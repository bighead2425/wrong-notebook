/**
 * POST /api/tags/pending/resolve —— 人确认一个"没归类"的标签
 *
 * 幂等：同一个名字重复确认不会连出两条关系（Prisma 的 connect 对已存在的关系是幂等的）。
 */

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { authOptions } from '@/lib/auth';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api:tags:pending:resolve');

interface ResolvedLike {
    name: string;
    book?: string;
    section?: string;
    tagId?: string | null;
    matchedBy?: string;
}

export async function POST(req: Request) {
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

        const body = await req.json();
        const { itemId, name, tagId, note } = body as {
            itemId?: string;
            name?: string;
            tagId?: string;
            note?: string;
        };

        if (!itemId || !name || !tagId) {
            return NextResponse.json({ error: 'itemId / name / tagId are required' }, { status: 400 });
        }

        const item = await prisma.errorItem.findFirst({
            where: { id: itemId, userId: user.id },
            select: { id: true, tagResolution: true, tagDeviation: true, notebookId: true },
        });
        if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 });

        /* 目标节点必须属于本人可见范围（系统标签或自建标签） */
        const tag = await prisma.knowledgeTag.findFirst({
            where: {
                id: tagId,
                OR: [{ isSystem: true }, { userId: user.id }],
            },
            select: { id: true },
        });
        if (!tag) return NextResponse.json({ error: 'Tag not found' }, { status: 404 });

        let parsed: ResolvedLike[] = [];
        try {
            parsed = JSON.parse(item.tagResolution || '[]');
        } catch {
            parsed = [];
        }

        let hit = false;
        const next = parsed.map((p) => {
            if (p.name !== name) return p;
            hit = true;
            return { ...p, tagId, matchedBy: 'human' };
        });

        /* 找不到对应项（老数据没有 tagResolution）就补一条，别让这次确认白做 */
        if (!hit) next.push({ name, tagId, matchedBy: 'human' });

        const deviation = typeof note === 'string' && note.trim()
            ? [item.tagDeviation, note.trim()].filter(Boolean).join('；')
            : item.tagDeviation;

        await prisma.errorItem.update({
            where: { id: item.id },
            data: {
                tagResolution: JSON.stringify(next),
                ...(deviation ? { tagDeviation: deviation } : {}),
                tags: { connect: { id: tag.id } },
            },
        });

        logger.info({ itemId, name, tagId, hasNote: !!note }, 'Pending tag resolved');
        return NextResponse.json({ ok: true });
    } catch (error) {
        logger.error({ error }, 'Failed to resolve pending tag');
        return NextResponse.json({ error: 'Failed to resolve pending tag' }, { status: 500 });
    }
}
