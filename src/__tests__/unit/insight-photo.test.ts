/**
 * 【2026-10-19 真真】`readPhotoForPrint` —— **入版开关的唯一落地点**。
 *
 * 钉住两件事：
 *  ① 开关关着 ⇒ 返回 null（纸上没有图），**图本身还在库里**；
 *  ② 开关开着 / 老数据没这个值 ⇒ 返回图。
 *
 * 这两条就是空空那句"点中入版，组积累纸时这张图跟随进入；关着的就不跟随进入"。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
    prisma: { insightPhoto: { findUnique } },
}));

import { readPhotoForPrint } from '@/lib/insight-photo';

beforeEach(() => {
    findUnique.mockReset();
});

describe('readPhotoForPrint', () => {
    it('★ 入版开着 ⇒ 给图', async () => {
        findUnique.mockResolvedValue({ data: 'data:image/png;base64,AAA', includedInPrint: true });
        await expect(readPhotoForPrint('ins-1')).resolves.toBe('data:image/png;base64,AAA');
    });

    it('★ 入版关着 ⇒ 给 null（纸面上不排这张图）', async () => {
        findUnique.mockResolvedValue({ data: 'data:image/png;base64,AAA', includedInPrint: false });
        await expect(readPhotoForPrint('ins-1')).resolves.toBeNull();
    });

    it('没图 ⇒ null（不是报错）', async () => {
        findUnique.mockResolvedValue(null);
        await expect(readPhotoForPrint('ins-1')).resolves.toBeNull();
    });

    it('取数时**同时**要 data 与 includedInPrint —— 只取 data 就又回到那个 bug', async () => {
        findUnique.mockResolvedValue(null);
        await readPhotoForPrint('ins-1');
        const arg = findUnique.mock.calls[0][0] as { select?: Record<string, boolean> };
        expect(arg.select).toMatchObject({ data: true, includedInPrint: true });
    });
});
