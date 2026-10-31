/**
 * GET /api/tags/pending —— 「标签没能归类」的题
 *
 * 【2026-10-31】为什么要有这个接口：
 * 原来 AI 选的标签如果对不上词表，服务端要么丢进 `unmatchedTags`（前端没人读），
 * 要么硬建一个野节点。两种都是**静默的** —— 人永远不知道这道题的标签没存上。
 *
 * 现在落库时把每条解析结果写进 `ErrorItem.tagResolution`（含 matchedBy），
 * 这里就是把 `matchedBy: 'none'` 的挑出来：一条一条列清楚，附候选，点一下就能修好。
 */

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { authOptions } from '@/lib/auth';
import { createLogger } from '@/lib/logger';
import { buildResolverIndex } from '@/lib/tag-resolve';
import { normalizeTagName } from '@/lib/ai/tag-ref';

const logger = createLogger('api:tags:pending');

interface ResolvedLike {
    name: string;
    book?: string;
    section?: string;
    tagId?: string | null;
    matchedBy?: string;
}

export async function GET() {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { id: true },
        });
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        /**
         * SQLite 没有 JSON 查询能力，用字符串匹配即可。
         * `JSON.stringify` 出来的键顺序固定、无空格，所以 `"matchedBy":"none"` 一定匹配得上。
         */
        const rows = await prisma.errorItem.findMany({
            where: {
                userId: user.id,
                tagResolution: { contains: '"matchedBy":"none"' },
            },
            select: {
                id: true,
                source: true,
                questionText: true,
                tagResolution: true,
                tagDeviation: true,
                notebook: { select: { displayName: true, subject: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });

        /* 每道题所在学科的节点先取一次，用于召回候选 */
        const subjects = [...new Set(rows.map((r) => r.notebook?.subject).filter(Boolean))] as string[];
        const tagsBySubject = new Map<string, { id: string; name: string; parentId: string | null }[]>();

        for (const s of subjects) {
            const all = await prisma.knowledgeTag.findMany({
                where: { subject: s, OR: [{ isSystem: true }, { userId: user.id }] },
                select: { id: true, name: true, parentId: true },
            });
            tagsBySubject.set(s, all);
        }

        const items = rows.map((row) => {
            let parsed: ResolvedLike[] = [];
            try {
                parsed = JSON.parse(row.tagResolution || '[]');
            } catch {
                parsed = [];
            }

            const pending = parsed.filter((p) => p.matchedBy === 'none');
            const subject = row.notebook?.subject || '';
            const all = tagsBySubject.get(subject) ?? [];
            const index = buildResolverIndex(all);
            const hasChild = new Set(all.filter((t) => t.parentId).map((t) => t.parentId as string));
            const leaves = all.filter((t) => !hasChild.has(t.id));

            return {
                id: row.id,
                source: row.source,
                questionText: (row.questionText || '').slice(0, 60),
                notebook: row.notebook?.displayName || '',
                subject,
                deviation: row.tagDeviation || '',
                pending: pending.map((p) => {
                    const norm = normalizeTagName(p.name);
                    const candidates = leaves
                        .filter((t) => {
                            const tn = normalizeTagName(t.name);
                            return tn === norm || tn.includes(norm) || norm.includes(tn);
                        })
                        .sort((a, b) => {
                            const ea = normalizeTagName(a.name) === norm ? 0 : 1;
                            const eb = normalizeTagName(b.name) === norm ? 0 : 1;
                            return ea - eb;
                        })
                        .slice(0, 8)
                        .map((t) => ({
                            id: t.id,
                            name: t.name,
                            path: `${index.rootNameOf.get(t.id) ?? ''} › ${index.parentNameOf.get(t.id) ?? ''}`,
                        }));

                    return { name: p.name, book: p.book || '', section: p.section || '', candidates };
                }),
            };
        });

        logger.info({ count: items.length }, 'Pending tag items');
        return NextResponse.json({ items, total: items.length });
    } catch (error) {
        logger.error({ error }, 'Failed to list pending tags');
        return NextResponse.json({ error: 'Failed to list pending tags' }, { status: 500 });
    }
}
