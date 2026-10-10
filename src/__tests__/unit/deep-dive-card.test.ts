import { describe, expect, it } from 'vitest';
import {
    CONTENT_MM,
    CURRENT_PAPER_TYPE,
    DEEP_CROSSHAIR_FLOOR_MM,
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
    maxFrontPhotoHeightHardMM,
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

    it('★ 正面照片"拖把手放大"必须**真的能放大**（2026-10-10 改）', () => {
        /**
         * 旧版的 bug（他拿英语阅读题试印时发现的）：
         * 硬上限写成 `frontPhotoSpaceMM()`，而那个式子把"十字留白 ≥110mm"算在里面，
         * 110 恰好就是默认尺寸留下的量 ⇒ 硬上限 == 默认上限（93.5mm）⇒ **拉到底也不动**。
         *
         * 现在的契约：放大时**允许吃掉下面的空白**，只给分析区留一个小底。
         */
        const def = maxFrontPhotoHeightMM();
        const hard = maxFrontPhotoHeightHardMM();

        // ① 必须明显比默认值大 —— 这是"能放大"的判据（旧版两者相等）
        expect(hard).toBeGreaterThan(def + 50);
        // ② 顶到天花板时，分析区刚好剩 DEEP_CROSSHAIR_FLOOR_MM（不是 0，也不能是负的）
        const leftForAnalysis =
            SIDE_HEIGHT_MM -
            T1_LAYOUT_MM.identityBar -
            T1_LAYOUT_MM.knowledgeRowMax -
            T1_LAYOUT_MM.frontGaps -
            hard;
        expect(leftForAnalysis).toBeCloseTo(DEEP_CROSSHAIR_FLOOR_MM, 5);
        expect(leftForAnalysis).toBeGreaterThan(0);
        // ③ 天花板不能超过整面高度（那是纸，不是橡皮筋）
        expect(hard).toBeLessThan(SIDE_HEIGHT_MM);
    });

    it('★ 默认尺寸仍按 P9 走：照片 ≤95mm、分析区 ≥110mm —— **只有手动放大才吃空白**（2026-10-10）', () => {
        const maxH = maxFrontPhotoHeightMM();
        expect(maxH).toBeLessThanOrEqual(95);
        expect(frontSideSlackMM(maxH)).toBeGreaterThanOrEqual(0);
        expect(SIDE_HEIGHT_MM - 9 - 6 - maxH).toBeGreaterThanOrEqual(110);
        // 知识点折两行时也不许裁掉分析区下沿（四角标识在那儿，OCR 靠它定方向）
        expect(frontSideSlackWorstMM(maxH)).toBeGreaterThanOrEqual(0);
    });

    it('★ 反面：留白是"最后保障"的 —— 它的下限必须远小于页脚（2026-10-10）', () => {
        /**
         * 他的原话："我建议留白部分是最后保障的。"
         * 起因：拿阅读题试印时**整块页脚没了**（二维码 / 横线 / 三个日期格 / 虚线框）——
         * 旧值 let 手写区先占 60mm，题干一长就把页脚顶出纸外。
         * 判据：留白让得比页脚狠（下限小），而页脚是硬指标（不能被压）。
         */
        expect(T1_LAYOUT_MM.writingMin).toBeLessThanOrEqual(20);
        expect(T1_LAYOUT_MM.writingMin).toBeLessThan(T1_LAYOUT_MM.footer);
        // 页脚高度是扫回定位要用的，一处都不能省
        expect(T1_LAYOUT_MM.footer).toBeGreaterThanOrEqual(26);
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
    it('当前能打印的是 T1 深挖纸 + T2 复练纸 + T3 积累纸，其余本轮不涉及', () => {
        expect(CURRENT_PAPER_TYPE).toBe('T1');
        const implemented = PAPER_TYPES.filter((p) => p.implemented).map((p) => p.code);
        // 【2026-09-28】T2/T3 都是"卷"：共用 components/print/review-card.tsx，
        // 打印页对应 mode=review / mode=build。
        // 这条断言是"清单式"的：**新开一种纸就把它加进来**，避免"加了纸却没人知道能打"。
        expect(implemented).toEqual(['T1', 'T2', 'T3']);
    });
});
