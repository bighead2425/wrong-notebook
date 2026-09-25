import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeepDiveCard } from '@/components/print/deep-dive-card';
import type { ErrorItem } from '@/types/api';

/**
 * T1 深挖纸的**渲染冒烟测试**。
 *
 * 为什么值得单独写：这张纸的验收标准是"打出来好不好看、装不装得下"，
 * 本来只能靠人眼；但有两类错**肉眼很难发现且后果严重**，必须由测试兜住：
 *   ① **纸上混进了 AI 内容**（解析 / 错因 / 参考答案）—— 这是整次改版要删的东西，
 *      一旦哪天有人"顺手把答案加上去"，孩子做题时就会直接看到答案；
 *   ② **该印的没印**（遮挡线、三个日期格）—— 纸面出现空白，
 *      只有真拿去打印才会发现。
 *
 * 另外几条是 2026-09-24 空空看纸样后的定稿要求，一并钉住：
 *   ③ 反面**没有身份条**（有就分不清正反）；
 *   ④ 正面左侧 / 反面右侧**留打孔位**；
 *   ⑤ 日期写 **yyyy-mm-dd**。
 */

const item = {
    id: 'e1',
    userId: 'u1',
    originalImageUrl: '/uploads/a.jpg',
    questionText: '一个长方形的长是 8 厘米，宽是 5 厘米，求它的周长和面积。',
    ocrText: '（OCR 原文）',
    answerText: '参考答案不该上纸',
    analysis: '解析不该上纸',
    mistakeAnalysis: '错因不该上纸',
    source: 'SX20260916001',
    masteryLevel: 0,
    tags: [{ name: '周长' }, { name: '面积' }],
    notebook: { grade: '五年级', semester: '上', displayName: '小五上数学', subject: 'sx' },
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
} as unknown as ErrorItem;

function renderWith(extra: Partial<ErrorItem> = {}, printDate = new Date(2026, 8, 24)): string {
    return renderToStaticMarkup(
        <DeepDiveCard
            item={{ ...item, ...extra } as ErrorItem}
            index={0}
            qrMap={{ e1: 'data:image/png;base64,AAAA' }}
            printDate={printDate}
            manualDuplex={false}
            L={(zh) => zh}
        />,
    );
}

describe('T1 深挖纸 · 纸上零 AI 内容', () => {
    it('解析 / 错因 / 参考答案一个字都不许出现', () => {
        const html = renderWith();
        expect(html).not.toContain('参考答案');
        expect(html).not.toContain('解析');
        expect(html).not.toContain('错因');
        // 连字段原文也不该漏出来
        expect(html).not.toContain('不该上纸');
    });
});

describe('T1 深挖纸 · 该印的必须印出来', () => {
    it('反面必须印出「遮挡线」三个字（给孩子看，也给 OCR 定位用）', () => {
        expect(renderWith()).toContain('遮挡线');
    });

    it('三个日期格写 **yyyy-mm-dd**，按打印日 +1 / +7 / +21', () => {
        const html = renderWith();
        expect(html).toContain('2026-09-25');
        expect(html).toContain('2026-10-01');
        expect(html).toContain('2026-10-15');
        // 旧的"月/日"写法必须绝迹（跨年时"10/1"分不清是哪一年）
        expect(html).not.toContain('>9/25<');
    });

    it('日期跟着打印日走（跨年要算对）', () => {
        const html = renderWith({}, new Date(2026, 11, 25));
        expect(html).toContain('2026-12-26');
        expect(html).toContain('2027-01-01');
        expect(html).toContain('2027-01-15');
    });

    it('身份条要印题号、年级学期与打印日', () => {
        const html = renderWith();
        expect(html).toContain('SX20260916001');
        expect(html).toContain('五年级');
        expect(html).toContain('2026-09-24');
    });

    it('身份条横线下面**靠左**写知识点，各知识点用 · 隔开', () => {
        const html = renderWith();
        expect(html).toContain('周长');
        expect(html).toContain('面积');
        expect(html).toContain('·');
    });

    it('知识点**贴着上面的横线**（2026-09-26：原来垂直居中，看着"掉下来了"）', () => {
        const html = renderWith();
        // 知识点块：顶部只留 0.4mm，且用 flex-start 而不是 center
        expect(html).toContain('padding-top:0.4mm');
        expect(html).toContain('align-items:flex-start');
    });

    it('知识点写不下可折行，但**每个知识点是 nowrap 的整块**（不许劈成两半）', () => {
        const html = renderWith();
        expect(html).toContain('flex-wrap:wrap');
        // 每个知识点一个 nowrap 的 span ⇒ 两个知识点至少两处 nowrap
        expect((html.match(/white-space:nowrap/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it('三个进度格必须各自带颜色（浅粉 / 嫩绿 / 金黄的底色都要出现）', () => {
        const html = renderWith();
        expect(html).toContain('#ffe3ec');
        expect(html).toContain('#e4f5d8');
        expect(html).toContain('#fff0c2');
    });
});

describe('T1 深挖纸 · 反面页脚（2026-09-26 改版）', () => {
    it('最后一个日期后面要有一个虚线框', () => {
        const html = renderWith();
        expect(html).toContain('print-deep-stamp');
        // 灰白底 + 虚线边 + 圆角
        expect(html).toContain('dashed');
        expect(html).toContain('border-radius:1.5mm');
    });

    it('⚠️ 版面上**不许写这个框是干什么的** —— 用途由她自己定', () => {
        const html = renderWith();
        for (const word of ['已会', '印章', '盖章', '会了', '家长签字']) {
            expect(html).not.toContain(word);
        }
    });

    it('二维码与横线**共享页宽**（横线是 flex:1，跟在二维码右边，不是压在它上面）', () => {
        const html = renderWith();
        // 页脚改成上下两行：上行 = 二维码 + 横线，下行 = 日期格 + 虚线框
        expect(html).toContain('flex-direction:column');
        expect(html).toContain('print-deep-footer-rule');
        expect(html).toContain('print-deep-slots');
    });
});

describe('T1 深挖纸 · 正反面的分野', () => {
    it('反面**没有身份条** —— 题号在整张纸上只出现一次', () => {
        const html = renderWith();
        expect(html.match(/SX20260916001/g) ?? []).toHaveLength(1);
    });

    it('正面左侧留打孔位、反面右侧留（同一条物理边，长边翻转）', () => {
        const html = renderWith();
        // 正面：左 12mm / 右 0；反面：左 0 / 右 12mm
        expect(html).toContain('padding-left:12mm');
        expect(html).toContain('padding-right:12mm');
    });

    it('外边框与四角标识归「她自己分析的那块」，不归原题照片', () => {
        const html = renderWith();
        expect(html).toContain('print-deep-analysis');
        expect(html).toContain('print-deep-photo');
    });
});

describe('T1 深挖纸 · 兜底与容错', () => {
    it('没有题干也没有 OCR 时，印一行小字让她翻回正面看题', () => {
        const html = renderWith({
            questionText: null as unknown as string,
            ocrText: null as unknown as string,
        });
        expect(html).toContain('翻回正面看题');
    });

    it('有题干时不该出现兜底那行字', () => {
        expect(renderWith()).not.toContain('翻回正面看题');
    });

    it('框坐标是坏 JSON 时也不能崩', () => {
        expect(() => renderWith({ cropRegions: '{坏数据' })).not.toThrow();
    });

    it('手动双面开启时应印出翻面提示', () => {
        const html = renderToStaticMarkup(
            <DeepDiveCard
                item={item}
                index={0}
                qrMap={{}}
                printDate={new Date(2026, 8, 24)}
                manualDuplex
                L={(zh) => zh}
            />,
        );
        expect(html).toContain('请在此处翻面');
    });
});
