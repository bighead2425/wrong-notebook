import { describe, expect, it } from 'vitest';
import {
    CONTENT_MM,
    CURRENT_PAPER_TYPE,
    PAPER_B5_MM,
    PAPER_TYPES,
    PUNCH_GUTTER_MM,
    REVIEW_OFFSETS_DAYS,
    SLOT_COLORS,
    SLOT_SIZE_MM,
    STAMP_BOX_MM,
    SIDE_HEIGHT_MM,
    T1_LAYOUT_MM,
    USABLE_WIDTH_MM,
    addDays,
    frontSideSlackMM,
    frontSideSlackWorstMM,
    maxFrontPhotoHeightMM,
    reviewDateSlots,
    sidePaddingMM,
} from '@/lib/deep-dive-card';
import { formatIsoDate } from '@/lib/date-format';

describe('T1 深挖纸 · 纸张与内容区尺寸', () => {
    it('B5 必须是 JIS 182×257（不是 ISO 176×250，否则满页排版会跑版）', () => {
        expect(PAPER_B5_MM).toEqual({ w: 182, h: 257 });
    });

    it('内容区 = B5 − 页边距 = 152mm × 227mm', () => {
        expect(CONTENT_MM).toEqual({ w: 152, h: 227 });
    });

    it('正面必须装得下：身份条 + 知识点行 + 照片 + 十字留白 全为正富余', () => {
        // 9(身份条) + 6(知识点行) + 45~95(照片) + 110(十字留白)
        expect(frontSideSlackMM(45)).toBe(55);
        expect(frontSideSlackMM(95)).toBe(5);
        expect(frontSideSlackMM(maxFrontPhotoHeightMM())).toBeGreaterThanOrEqual(0);
    });

    it('照片上限必须同时满足 P9 的 95mm 与"十字留白不缩水"', () => {
        const maxH = maxFrontPhotoHeightMM();
        expect(maxH).toBeLessThanOrEqual(95);
        expect(maxH).toBeGreaterThan(90);
        expect(frontSideSlackMM(maxH)).toBeGreaterThanOrEqual(0);
        expect(SIDE_HEIGHT_MM - 9 - 6 - maxH).toBeGreaterThanOrEqual(110);
    });

    it('知识点折成**两行**时也不能把分析区下沿裁掉（2026-09-26）', () => {
        // 裁掉的正是分析区的下边框 + 下面两个角标 —— OCR 靠角标定方向，不能裁。
        // 所以照片上限是按"两行"算的，不是按"一行"算的。
        expect(frontSideSlackWorstMM(maxFrontPhotoHeightMM())).toBeGreaterThanOrEqual(0);
        expect(frontSideSlackWorstMM(45)).toBeGreaterThan(0);
        // 两行的富余必须比一行少，但绝不能是负的
        expect(frontSideSlackWorstMM(45)).toBeLessThan(frontSideSlackMM(45));
    });

    it('知识点行：一行 6mm、最多两行（写不下宁可不印，也不挤第三行）', () => {
        expect(T1_LAYOUT_MM.knowledgeRowMax).toBeGreaterThan(T1_LAYOUT_MM.knowledgeRow);
        expect(T1_LAYOUT_MM.knowledgeRowMax).toBeLessThan(T1_LAYOUT_MM.knowledgeRow * 2);
    });

    it('反面末尾的虚线框：比颜色格宽得多、略高一点，且**不写用途**', () => {
        expect(STAMP_BOX_MM.w).toBeGreaterThan(SLOT_SIZE_MM * 3);
        expect(STAMP_BOX_MM.h).toBeGreaterThan(SLOT_SIZE_MM);
        expect(STAMP_BOX_MM.h).toBeLessThan(SLOT_SIZE_MM * 2);
        expect(STAMP_BOX_MM.radius).toBeGreaterThan(0);
    });

    it('打孔位：正面让左、反面让右，两面让出的是同一条物理边', () => {
        expect(sidePaddingMM('front')).toEqual({ left: PUNCH_GUTTER_MM, right: 0 });
        expect(sidePaddingMM('back')).toEqual({ left: 0, right: PUNCH_GUTTER_MM });
        expect(USABLE_WIDTH_MM).toBe(CONTENT_MM.w - PUNCH_GUTTER_MM);
        // 扣掉打孔位之后仍要留出足够写字宽度（>120mm 才不像信封）
        expect(USABLE_WIDTH_MM).toBeGreaterThan(120);
    });

    it('每一面实际占的高度要比内容区矮一点（否则浏览器会整体挪到下一页）', () => {
        expect(SIDE_HEIGHT_MM).toBeLessThan(CONTENT_MM.h);
        expect(SIDE_HEIGHT_MM).toBe(CONTENT_MM.h - 2);
    });
});

describe('T1 深挖纸 · 反面三个日期格（P20 / P24）', () => {
    it('间隔必须是 +1 / +7 / +21 —— 不是 +2（口径已定案）', () => {
        expect([...REVIEW_OFFSETS_DAYS]).toEqual([1, 7, 21]);
    });

    it('应以打印日为准算出三个日期，写法为 yyyy-mm-dd', () => {
        const slots = reviewDateSlots(new Date(2026, 8, 24)); // 2026-09-24
        expect(slots.map((s) => s.label)).toEqual(['2026-09-25', '2026-10-01', '2026-10-15']);
        expect(slots.map((s) => s.index)).toEqual([1, 2, 3]);
    });

    it('跨月要算对（9/30 + 1 天 = 10/01）', () => {
        expect(reviewDateSlots(new Date(2026, 8, 30)).map((s) => s.label)).toEqual([
            '2026-10-01',
            '2026-10-07',
            '2026-10-21',
        ]);
    });

    it('跨年要算对（12/25 + 7 天 = 次年 01/01）', () => {
        const slots = reviewDateSlots(new Date(2026, 11, 25));
        expect(slots.map((s) => s.label)).toEqual(['2026-12-26', '2027-01-01', '2027-01-15']);
        expect(slots[1].date.getFullYear()).toBe(2027);
    });

    it('闰年 2 月要算对（2028-02-28 + 1 天 = 02-29）', () => {
        expect(reviewDateSlots(new Date(2028, 1, 28))[0].label).toBe('2028-02-29');
    });

    it('只按年月日加减，时分秒必须被忽略（否则晚上打印会印成前一天）', () => {
        const lateNight = new Date(2026, 8, 24, 23, 59, 59);
        expect(reviewDateSlots(lateNight).map((s) => s.label)).toEqual([
            '2026-09-25',
            '2026-10-01',
            '2026-10-15',
        ]);
    });

    it('addDays 不应改变时区/时间部分以外的语义', () => {
        const d = addDays(new Date(2026, 0, 31), 1);
        expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 2, 1]);
    });
});

describe('日期写法', () => {
    it('纸面统一 yyyy-mm-dd，月日必须补零', () => {
        expect(formatIsoDate(new Date(2026, 8, 5))).toBe('2026-09-05');
        expect(formatIsoDate(new Date(2026, 11, 31))).toBe('2026-12-31');
    });

    it('绝不用 UTC —— 本地 0 点与 23 点必须是同一天', () => {
        expect(formatIsoDate(new Date(2026, 8, 24, 0, 0, 0))).toBe('2026-09-24');
        expect(formatIsoDate(new Date(2026, 8, 24, 23, 59, 59))).toBe('2026-09-24');
    });
});

describe('反面三个进度格的配色（她第 1 / 2 / 3 次复做）', () => {
    it('必须是三格三色，且每个色都给了"底 / 边 / 字"三个值', () => {
        expect(SLOT_COLORS).toHaveLength(3);
        expect(SLOT_COLORS.map((c) => c.name)).toEqual(['浅粉', '嫩绿', '金黄']);
        for (const c of SLOT_COLORS) {
            expect(c.fill).toMatch(/^#[0-9a-f]{6}$/);
            expect(c.border).toMatch(/^#[0-9a-f]{6}$/);
            expect(c.text).toMatch(/^#[0-9a-f]{6}$/);
        }
    });

    it('三个底色互不相同（一样就等于没标）', () => {
        expect(new Set(SLOT_COLORS.map((c) => c.fill)).size).toBe(3);
    });

    it('日期文字必须是**深色** —— 浅色当正文在纸上几乎看不清，复印还会再吃掉一层', () => {
        for (const c of SLOT_COLORS) {
            const r = parseInt(c.text.slice(1, 3), 16);
            const g = parseInt(c.text.slice(3, 5), 16);
            const b = parseInt(c.text.slice(5, 7), 16);
            const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            expect(lum).toBeLessThan(0.6);
        }
    });
});

describe('纸型家族（架构口子）', () => {
    it('当前唯一能打印的纸型是 T1 深挖纸，其余本轮不涉及', () => {
        expect(CURRENT_PAPER_TYPE).toBe('T1');
        const implemented = PAPER_TYPES.filter((p) => p.implemented).map((p) => p.code);
        expect(implemented).toEqual(['T1']);
    });
});
