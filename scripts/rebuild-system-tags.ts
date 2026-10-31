/**
 * 系统标签重建脚本 - 可在 Docker entrypoint 中自动运行
 * 用于重建系统标签并保留关联关系
 *
 * 【2026-10-31】触发条件从"应用版本号变了"改成"**词表内容指纹变了**"。
 *
 * 原来 entrypoint 只在 `package.json` 的 version 变化时才调它。后果很实际：
 * 2026-10-31 把五年级词表按北师大教材重写、发了新镜像（custom-v144），
 * 但 version 仍写 1.9.0 ⇒ 重建没触发，词表根本没进库，
 * 而我以为"发版就生效了"，直到查库才发现五年级还是老单元。
 *
 * 改成内容哈希之后：改词表不必再记得碰版本号，改了就重建，没改就秒退。
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import {
    MATH_CURRICULUM, MATH_GRADE_ORDER,
    PHYSICS_CURRICULUM, PHYSICS_GRADE_ORDER,
    ENGLISH_CURRICULUM, ENGLISH_GRADE_ORDER,
    CHEMISTRY_CURRICULUM, CHEMISTRY_GRADE_ORDER,
    BIOLOGY_CURRICULUM, BIOLOGY_GRADE_ORDER,
    CHINESE_CURRICULUM, CHINESE_GRADE_ORDER,
    HISTORY_CURRICULUM, HISTORY_GRADE_ORDER,
    GEOGRAPHY_CURRICULUM, GEOGRAPHY_GRADE_ORDER,
    POLITICS_CURRICULUM, POLITICS_GRADE_ORDER
} from '../src/lib/tag-data';

const prisma = new PrismaClient();

interface TagAssociation {
    errorItemId: string;
    tagName: string;
    subject: string;
}

async function seedMath(tx: any, curriculum: any, gradeOrder: any) {
    let count = 0;
    for (const [gradeSemester, chapters] of Object.entries(curriculum) as any) {
        const gradeNode = await tx.knowledgeTag.create({
            data: {
                name: gradeSemester,
                subject: 'math',
                parentId: null,
                isSystem: true,
                order: gradeOrder[gradeSemester] || 99,
            },
        });
        count++;

        for (let chapterIdx = 0; chapterIdx < chapters.length; chapterIdx++) {
            const chapter = chapters[chapterIdx];
            const chapterNode = await tx.knowledgeTag.create({
                data: {
                    name: chapter.chapter,
                    subject: 'math',
                    parentId: gradeNode.id,
                    isSystem: true,
                    order: chapterIdx + 1,
                },
            });
            count++;

            for (let sectionIdx = 0; sectionIdx < chapter.sections.length; sectionIdx++) {
                const section = chapter.sections[sectionIdx];
                const sectionNode = await tx.knowledgeTag.create({
                    data: {
                        name: section.section,
                        subject: 'math',
                        parentId: chapterNode.id,
                        isSystem: true,
                        order: sectionIdx + 1,
                    },
                });
                count++;

                for (let tagIdx = 0; tagIdx < section.tags.length; tagIdx++) {
                    const tagName = section.tags[tagIdx];
                    await tx.knowledgeTag.create({
                        data: {
                            name: tagName,
                            subject: 'math',
                            parentId: sectionNode.id,
                            isSystem: true,
                            order: tagIdx + 1,
                        },
                    });
                    count++;
                }
            }
        }
    }
    return count;
}

async function seedStandardSubject(tx: any, subject: string, curriculum: any, gradeOrder: any) {
    let count = 0;
    for (const [gradeSemester, chapters] of Object.entries(curriculum) as any) {
        const gradeNode = await tx.knowledgeTag.create({
            data: {
                name: gradeSemester,
                subject: subject,
                parentId: null,
                isSystem: true,
                order: gradeOrder[gradeSemester] || 99,
            },
        });
        count++;

        for (let chapterIdx = 0; chapterIdx < chapters.length; chapterIdx++) {
            const chapter = chapters[chapterIdx];
            const chapterNode = await tx.knowledgeTag.create({
                data: {
                    name: chapter.chapter,
                    subject: subject,
                    parentId: gradeNode.id,
                    isSystem: true,
                    order: chapterIdx + 1,
                },
            });
            count++;

            for (let tagIdx = 0; tagIdx < chapter.tags.length; tagIdx++) {
                const tagName = chapter.tags[tagIdx];
                await tx.knowledgeTag.create({
                    data: {
                        name: tagName,
                        subject: subject,
                        parentId: chapterNode.id,
                        isSystem: true,
                        order: tagIdx + 1,
                    },
                });
                count++;
            }
        }
    }
    return count;
}

/**
 * 词表指纹：只算"喂给数据库的那些内容"，不含任何时间/路径。
 * 同样一份词表，无论编译多少次，指纹都一样。
 */
function computeCurriculumHash(): string {
    const payload = JSON.stringify([
        MATH_CURRICULUM, PHYSICS_CURRICULUM, ENGLISH_CURRICULUM, CHEMISTRY_CURRICULUM,
        BIOLOGY_CURRICULUM, CHINESE_CURRICULUM, HISTORY_CURRICULUM, GEOGRAPHY_CURRICULUM,
        POLITICS_CURRICULUM,
    ]);
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * 指纹落盘位置：**紧跟数据库文件**（同一目录）。
 *
 * 为什么不能写死 `/app/data/.tags_hash`：这个脚本在**构建镜像时**也会跑一次
 * （Dockerfile 里 `node ./dist-scripts/scripts/rebuild-system-tags.js`，那时
 * `DATABASE_URL=file:/app/prisma/dev.db`）。写死路径的话，指纹会被烘进镜像，
 * 而运行时用的是另一个库（`/app/data/dev.db`）—— 两边指纹一比对就"相同"，
 * 于是刚发的新词表又被跳过。这跟原来那个版本门控是同一个错误，只是换了个壳。
 *
 * 跟着 DATABASE_URL 走，标记永远描述"它旁边那个库"，构建期和运行期互不干扰。
 */
function resolveHashMarker(): string {
    if (process.env.TAGS_HASH_FILE) return process.env.TAGS_HASH_FILE;
    const url = process.env.DATABASE_URL || '';
    const m = url.match(/^file:(.+)$/);
    if (m) {
        const dbPath = m[1];
        const dir = dbPath.slice(0, dbPath.lastIndexOf('/')) || '.';
        return `${dir}/.tags_hash`;
    }
    return '/app/data/.tags_hash';
}

const HASH_MARKER = resolveHashMarker();

async function main() {
    const hash = computeCurriculumHash();

    let prevHash = '';
    let prevCount = -1;
    try {
        const raw = readFileSync(HASH_MARKER, 'utf8').trim();
        const [h, c] = raw.split(/\s+/);
        prevHash = h || '';
        prevCount = Number.isFinite(Number(c)) ? Number(c) : -1;
    } catch {
        /* 第一次跑，没有标记文件 */
    }

    if (prevHash === hash) {
        /**
         * 光看指纹不够：库里若被换成了旧备份，标记文件不会跟着回退，
         * 那样会"以为是最新的"而跳过重建 ⇒ 词表悄悄退回旧版。
         * 所以标记里连**标签条数**一起记，数量对不上就重建。
         * 一次 count 查询，代价可以忽略。
         */
        const systemCount = await prisma.knowledgeTag.count({ where: { isSystem: true } });
        if (systemCount > 0 && (prevCount < 0 || systemCount === prevCount)) {
            console.log(`[RebuildTags] 词表未变（hash=${hash}，${systemCount} 个系统标签），跳过。`);
            return;
        }
        console.log(
            `[RebuildTags] 指纹相同但条数对不上（标记 ${prevCount}，实际 ${systemCount}）——可能换了旧备份，重建。`,
        );
    }

    console.log(`[RebuildTags] Starting automatic system tag rebuild... (hash ${prevHash || '(无)'} → ${hash})`);

    let totalCreated = 0;
    let associationsRestored = 0;
    let customTagsCreated = 0;

    await prisma.$transaction(async (tx) => {
        // ========== STEP 1: 备份现有关联关系 ==========
        console.log('[RebuildTags] Step 1: Backing up tag associations...');
        const associations: TagAssociation[] = [];

        const errorItemsWithSystemTags = await tx.errorItem.findMany({
            select: {
                id: true,
                tags: {
                    where: { isSystem: true },
                    select: { name: true, subject: true }
                }
            }
        });

        for (const item of errorItemsWithSystemTags) {
            for (const tag of item.tags) {
                associations.push({
                    errorItemId: item.id,
                    tagName: tag.name,
                    subject: tag.subject,
                });
            }
        }
        console.log(`[RebuildTags] Backed up ${associations.length} associations from ${errorItemsWithSystemTags.length} items`);

        // ========== STEP 2: 删除旧标签并重建 ==========
        console.log('[RebuildTags] Step 2: Rebuilding system tags...');

        // Math
        await tx.knowledgeTag.deleteMany({ where: { isSystem: true, subject: 'math' } });
        totalCreated += await seedMath(tx, MATH_CURRICULUM, MATH_GRADE_ORDER);

        // Physics
        await tx.knowledgeTag.deleteMany({ where: { isSystem: true, subject: 'physics' } });
        totalCreated += await seedStandardSubject(tx, 'physics', PHYSICS_CURRICULUM, PHYSICS_GRADE_ORDER);

        // English
        await tx.knowledgeTag.deleteMany({ where: { isSystem: true, subject: 'english' } });
        totalCreated += await seedStandardSubject(tx, 'english', ENGLISH_CURRICULUM, ENGLISH_GRADE_ORDER);

        // Chemistry
        await tx.knowledgeTag.deleteMany({ where: { isSystem: true, subject: 'chemistry' } });
        totalCreated += await seedStandardSubject(tx, 'chemistry', CHEMISTRY_CURRICULUM, CHEMISTRY_GRADE_ORDER);

        // Biology
        await tx.knowledgeTag.deleteMany({ where: { isSystem: true, subject: 'biology' } });
        totalCreated += await seedStandardSubject(tx, 'biology', BIOLOGY_CURRICULUM, BIOLOGY_GRADE_ORDER);

        // Chinese
        await tx.knowledgeTag.deleteMany({ where: { isSystem: true, subject: 'chinese' } });
        totalCreated += await seedStandardSubject(tx, 'chinese', CHINESE_CURRICULUM, CHINESE_GRADE_ORDER);

        // History
        await tx.knowledgeTag.deleteMany({ where: { isSystem: true, subject: 'history' } });
        totalCreated += await seedStandardSubject(tx, 'history', HISTORY_CURRICULUM, HISTORY_GRADE_ORDER);

        // Geography
        await tx.knowledgeTag.deleteMany({ where: { isSystem: true, subject: 'geography' } });
        totalCreated += await seedStandardSubject(tx, 'geography', GEOGRAPHY_CURRICULUM, GEOGRAPHY_GRADE_ORDER);

        // Politics
        await tx.knowledgeTag.deleteMany({ where: { isSystem: true, subject: 'politics' } });
        totalCreated += await seedStandardSubject(tx, 'politics', POLITICS_CURRICULUM, POLITICS_GRADE_ORDER);

        console.log(`[RebuildTags] Created ${totalCreated} tags`);

        // ========== STEP 3: 恢复关联关系 ==========
        console.log('[RebuildTags] Step 3: Restoring associations...');

        const associationsByItem = new Map<string, TagAssociation[]>();
        for (const assoc of associations) {
            const list = associationsByItem.get(assoc.errorItemId) || [];
            list.push(assoc);
            associationsByItem.set(assoc.errorItemId, list);
        }

        // 获取第一个 admin 用户用于创建自定义标签
        const adminUser = await tx.user.findFirst({
            where: { role: 'admin' },
            select: { id: true }
        });

        for (const [errorItemId, itemAssociations] of associationsByItem) {
            const newTagIds: string[] = [];

            for (const assoc of itemAssociations) {
                let newTag = await tx.knowledgeTag.findFirst({
                    where: {
                        name: assoc.tagName,
                        subject: assoc.subject,
                        isSystem: true
                    },
                    select: { id: true }
                });

                if (newTag) {
                    newTagIds.push(newTag.id);
                    associationsRestored++;
                } else if (adminUser) {
                    // 系统标签未找到，创建为自定义标签
                    console.warn(`[RebuildTags] Tag not found: "${assoc.tagName}" (${assoc.subject}), creating as custom tag`);

                    let customTag = await tx.knowledgeTag.findFirst({
                        where: {
                            name: assoc.tagName,
                            subject: assoc.subject,
                            userId: adminUser.id
                        },
                        select: { id: true }
                    });

                    if (!customTag) {
                        customTag = await tx.knowledgeTag.create({
                            data: {
                                name: assoc.tagName,
                                subject: assoc.subject,
                                isSystem: false,
                                userId: adminUser.id,
                            },
                            select: { id: true }
                        });
                        customTagsCreated++;
                    }

                    newTagIds.push(customTag.id);
                    associationsRestored++;
                }
            }

            if (newTagIds.length > 0) {
                await tx.errorItem.update({
                    where: { id: errorItemId },
                    data: {
                        tags: {
                            connect: newTagIds.map(id => ({ id }))
                        }
                    }
                });
            }
        }

        console.log(`[RebuildTags] Restored ${associationsRestored} associations, created ${customTagsCreated} custom tags`);
    }, {
        timeout: 120000
    });

    console.log(`[RebuildTags] Completed. System tags: ${totalCreated}, Associations: ${associationsRestored}, Custom tags: ${customTagsCreated}`);

    /* 重建成功才写指纹：半路失败绝不能写，否则下次会"以为已经同步过"而跳过，错得更隐蔽。 */
    try {
        const finalCount = await prisma.knowledgeTag.count({ where: { isSystem: true } });
        writeFileSync(HASH_MARKER, `${hash} ${finalCount}\n`, 'utf8');
        console.log(`[RebuildTags] 指纹已记录：${hash}（${finalCount} 个系统标签）`);
    } catch (e) {
        console.warn('[RebuildTags] 指纹写入失败（不影响本次结果，下次会再重建一遍）:', e);
    }
}

main()
    .catch((e) => {
        console.error('[RebuildTags] Error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
