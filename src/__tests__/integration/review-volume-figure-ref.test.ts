/**
 * 【2026-10-28】读卷时把 `ref:insight:<id>` 还原成真图 —— 打印链路最后一道验证。
 *
 * 背景：积累卷行的配图不再存副本，只存引用（省了 15.56MB → 1394 字节）。
 * 但**打印页拿到的必须是图本身**，否则纸上就是一个破图标。
 * 所以这条钉住"读的时候还原"这件事，以及三种坏情况：
 *   · 那条积累把图删了 ⇒ 这一行没有图，**不报错**；
 *   · 图被拨成"不入版" ⇒ 先被 `stripExcludedFigures` 清掉，不还原；
 *   · 老数据的 data URL ⇒ 原样返回（不迁移也能印）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    volumeFindUnique: vi.fn(),
    photoFindMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        reviewVolume: { findUnique: mocks.volumeFindUnique },
        insightPhoto: { findMany: mocks.photoFindMany },
    },
}));

vi.mock('next-auth', () => ({
    getServerSession: vi.fn(() => Promise.resolve({ user: { name: 'u' }, expires: '2099-01-01' })),
}));

vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { GET } from '@/app/api/review-volumes/[id]/route';

function volumeWith(items: Array<Record<string, unknown>>) {
    return {
        id: 'v1',
        volumeNo: 'BU20260101001',
        kind: 'build',
        pageCount: 1,
        emojiMark: '📌', // 有值 ⇒ 不会触发惰性写库
        items: items.map((it, i) => ({
            id: `row${i}`,
            volumeId: 'v1',
            seqInVolume: i + 1,
            pageIndex: 1,
            columnIndex: 0,
            seqInColumn: i + 1,
            errorItemId: null,
            itemNo: `JL2026010100${i}`,
            questionText: '正文',
            manageType: null,
            blankLines: 5,
            figureScale: 100,
            insightId: `ins${i}`,
            markState: null,
            ...it,
        })),
    };
}

const call = async () => {
    const res = await GET(new Request('http://localhost/api/review-volumes/v1') as never, {
        params: Promise.resolve({ id: 'v1' }),
    } as never);
    return (await res.json()) as { volume: { items: Array<{ figureUrls: string | null }> } };
};

describe('GET 卷 · 配图引用还原', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('引用还原成真图', async () => {
        mocks.volumeFindUnique.mockResolvedValue(
            volumeWith([{ insightId: 'ins0', figureUrls: '["ref:insight:ins0"]' }]),
        );
        mocks.photoFindMany.mockResolvedValue([
            { insightId: 'ins0', includedInPrint: true, data: 'data:image/jpeg;base64,REAL' },
        ]);

        const { volume } = await call();
        expect(volume.items[0].figureUrls).toBe('["data:image/jpeg;base64,REAL"]');
    });

    it('图没了 ⇒ 这一行变成没有图，其它行不受影响', async () => {
        mocks.volumeFindUnique.mockResolvedValue(
            volumeWith([
                { insightId: 'gone', figureUrls: '["ref:insight:gone"]' },
                { insightId: 'ins1', figureUrls: '["ref:insight:ins1"]' },
            ]),
        );
        mocks.photoFindMany.mockResolvedValue([
            { insightId: 'ins1', includedInPrint: true, data: 'data:image/png;base64,OK' },
        ]);

        const { volume } = await call();
        expect(volume.items[0].figureUrls).toBeNull();
        expect(volume.items[1].figureUrls).toBe('["data:image/png;base64,OK"]');
    });

    it('拨成"不入版"的 ⇒ 不还原（先被清掉）', async () => {
        mocks.volumeFindUnique.mockResolvedValue(
            volumeWith([{ insightId: 'ins0', figureUrls: '["ref:insight:ins0"]' }]),
        );
        mocks.photoFindMany.mockResolvedValue([
            { insightId: 'ins0', includedInPrint: false, data: 'data:image/jpeg;base64,HIDDEN' },
        ]);

        const { volume } = await call();
        expect(volume.items[0].figureUrls).toBeNull();
    });

    it('老数据（data URL）原样返回 —— 不迁移也能印', async () => {
        const raw = '["data:image/jpeg;base64,OLD"]';
        mocks.volumeFindUnique.mockResolvedValue(volumeWith([{ insightId: null, figureUrls: raw }]));
        mocks.photoFindMany.mockResolvedValue([]);

        const { volume } = await call();
        expect(volume.items[0].figureUrls).toBe(raw);
    });
});
