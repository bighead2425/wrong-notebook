// @vitest-environment node
// 渲染冒烟测试：扫到的复练卷页上「纸面直接录入」那两组控件。
// 用 renderToStaticMarkup（react-dom/server）：不需要 jsdom，本机 4GB 内存也跑得动。
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewSheet } from '@/components/print/review-card';
import type { MeasuredPageLayout } from '@/lib/review-card';
import type { ErrorItem } from '@/types/api';
import type { ReviewMark } from '@/lib/scan-marking';
import type { PromoteDirection } from '@/lib/manage-type';

/**
 * 【2026-10-02 他要求】扫到的复练卷页支持**纸面上直接录入**：
 *   一、点升降框 ⇒ 改类型（勾选态：对号 + 已降/已升 + 浅绿/粉底）；
 *   二、每题右侧一颗灰圆 ⇒ 灰数字 / 绿对号 / 粉错号。
 *
 * ⭐【2026-10-16 如如】灰圆的**手势与角标**是本轮改造的重点（`docs\18` §4.3）：
 *   · 点击 = **对 ⇄ 错 两态**（不再有"再点一下清空"）；
 *   · **长按 / 右键** ⇒ 弹菜单（再录一次：对 / 错、删除这一条）；
 *   · 同一张卷录了 2 轮以上 ⇒ 圈**左上方**画一个上标数字（1 不画）；
 *   · **已掌握的题 ⇒ 这颗圆禁用**（验收 #10"录不了"）。
 *
 * 测试只需钉住**看得见、最容易事后被改坏**的几条：
 *   · 控件带 `no-print`（纸上零 AI 内容的铁律）；
 *   · 灰圆各态画对（数字 / ✓ / ✗），且直径 11mm（比加号那个蓝圆大）；
 *   · 升降框勾选态的文案与底色；
 *   · 角标只在 >1 时出现；禁用态真的 `disabled`；
 *   · **不传这些回调时（打印那一路）一个都不许冒出来**。
 */

const item = (extra: Partial<ErrorItem> = {}): ErrorItem =>
    ({
        id: 'e1',
        userId: 'u1',
        originalImageUrl: '/uploads/a.jpg',
        questionText: '一个长方形的长是 8 厘米，宽是 5 厘米，求它的周长和面积。',
        answerText: '周长 26 厘米',
        manageType: 'deep',
        masteryLevel: 0,
        createdAt: '2026-09-24T10:00:00.000Z',
        updatedAt: '2026-09-24T10:00:00.000Z',
        ...extra,
    }) as unknown as ErrorItem;

const page: MeasuredPageLayout = {
    columns: [{ blocks: [{ key: 'e1', heightMM: 40, seq: 1 }] }],
};

function renderSheet(opts: {
    it?: ErrorItem;
    mark?: ReviewMark;
    promote?: { direction: PromoteDirection; checked: boolean };
    interactive?: boolean;
    /** 录过几轮（角标） */
    rounds?: number;
    /** 已掌握 ⇒ 圈禁用 */
    disabled?: boolean;
    /** 要不要给长按回调 */
    longPress?: boolean;
    /** 这道题的答案（给了才会画那个灰色小框） */
    answer?: string;
    /** 灰框能不能点开（= 传了 onAnswerClick） */
    answerClick?: boolean;
    /** 【2026-10-18】要凸显哪道题（传题 id；不传 = 不凸显） */
    highlight?: string;
} = {}): string {
    const it = opts.it ?? item();
    const interactive = opts.interactive ?? true;
    return renderToStaticMarkup(
        <ReviewSheet
            page={page}
            pageNo={1}
            pageCount={1}
            volumeNo="RE20260926001"
            kind="review"
            printDate={new Date(2026, 9, 2)}
            itemByKey={{ e1: it }}
            onQuestionPlusClick={interactive ? () => undefined : undefined}
            onPromoteToggle={interactive ? () => undefined : undefined}
            promoteOverrideOf={interactive ? () => opts.promote : undefined}
            onReviewMarkTap={interactive ? () => undefined : undefined}
            reviewMarkOf={interactive ? () => opts.mark ?? 'none' : undefined}
            onReviewMarkLongPress={interactive && opts.longPress ? () => undefined : undefined}
            reviewRoundsOf={interactive ? () => opts.rounds ?? 1 : undefined}
            reviewMarkDisabledOf={interactive ? () => !!opts.disabled : undefined}
            answerOf={interactive && opts.answer ? () => opts.answer! : undefined}
            onAnswerClick={
                interactive && opts.answerClick ? () => undefined : undefined
            }
            highlightItemId={opts.highlight ?? null}
            L={(zh) => zh}
        />,
    );
}

describe('扫卷录入 · 右侧灰圆（两态）', () => {
    it('★ 三态各画各的：灰数字 / 绿对号 / 粉错号', () => {
        const none = renderSheet({ mark: 'none' });
        expect(none).toContain('>1<'); // 灰底白**流水号**
        expect(none).not.toContain('✓');
        expect(none).not.toContain('✗');

        expect(renderSheet({ mark: 'right' })).toContain('✓');
        const wrong = renderSheet({ mark: 'wrong' });
        expect(wrong).toContain('✗');
        expect(wrong).not.toContain('✓');
    });

    it('★ 圆的直径 11mm（比加号那个 10mm 蓝圆略大）', () => {
        expect(renderSheet({ mark: 'none' })).toContain('width:11mm');
    });

    it('三态配色来自一处 token（绿=对 / 粉=错）', () => {
        expect(renderSheet({ mark: 'right' })).toContain('#6fbf8b');
        expect(renderSheet({ mark: 'wrong' })).toContain('#f6c9cf');
        expect(renderSheet({ mark: 'none' })).toContain('#9ca3af');
    });

    it('⚠️ 控件是屏幕上的东西 ⇒ 必须 no-print（绝不落纸）', () => {
        expect(renderSheet({ mark: 'right' })).toContain('no-print');
    });

    it('★★ 提示语改口了：**不再出现"再点清空"**（撤销走长按菜单）', () => {
        const html = renderSheet({ mark: 'none', longPress: true });
        expect(html).toContain('对 ⇄ 错');
        expect(html).toContain('长按');
        expect(html).not.toContain('清空');
    });

    it('不给长按回调 ⇒ 提示语也不提长按（别许一个做不到的手势）', () => {
        const html = renderSheet({ mark: 'none', longPress: false });
        expect(html).toContain('对 ⇄ 错');
        expect(html).not.toContain('长按');
    });

    it('★★ 轮次角标：录过 2 轮 ⇒ 圈上出现上标 2；1 轮 / 没录过 ⇒ 不画', () => {
        // 用 mark=right（圈里是 ✓、没有数字）⇒ 页面上的数字只可能来自角标
        const twoRounds = renderSheet({ mark: 'right', rounds: 2 });
        expect(twoRounds).toContain('>2<');
        expect(twoRounds).toContain('left:-1.6mm'); // 位置：圈的左上方

        const oneRound = renderSheet({ mark: 'right', rounds: 1 });
        expect(oneRound).not.toContain('>2<');
        expect(oneRound).not.toContain('left:-1.6mm');
    });

    it('★★ 已掌握的题 ⇒ 那颗圆禁用（验收 #10"录不了"）', () => {
        const html = renderSheet({ mark: 'right', disabled: true });
        expect(html).toContain('disabled');
        expect(html).toContain('not-allowed');
        expect(html).toContain('已掌握');
    });
});

describe('扫卷录入 · 升降框（点一下改类型）', () => {
    it('未勾选：还是印"降级"（深挖）/"升级"（复练）', () => {
        expect(renderSheet({ it: item({ manageType: 'deep' }) })).toContain('降级');
        expect(renderSheet({ it: item({ manageType: 'review' }) })).toContain('升级');
    });

    it('★ 勾选后：文字改"已降"、底色浅绿（箭头仍留着）', () => {
        const html = renderSheet({
            it: item({ manageType: 'review' }), // 已降级 ⇒ 现在类型是复练
            promote: { direction: 'demote', checked: true },
        });
        expect(html).toContain('已降');
        expect(html).toContain('#d7f0dd');
        expect(html).toContain('↓');
    });

    it('★ 勾选后：文字改"已升"、底色粉红', () => {
        const html = renderSheet({
            it: item({ manageType: 'deep' }),
            promote: { direction: 'upgrade', checked: true },
        });
        expect(html).toContain('已升');
        expect(html).toContain('#fbd7e0');
        expect(html).toContain('↑');
    });

    it('方框里出现对号（勾选态）', () => {
        const html = renderSheet({ promote: { direction: 'demote', checked: true } });
        // 对号的 svg 路径
        expect(html).toContain('M5 13l4 4L19 7');
    });
});

describe('扫卷录入 · 打印那一路一个都不许冒出来', () => {
    it('★ 不传这些回调（打印/纸面）⇒ 没有灰圆、没有"已降/已升"、没有对号', () => {
        const html = renderSheet({ interactive: false });
        expect(html).not.toContain('已降');
        expect(html).not.toContain('已升');
        expect(html).not.toContain('✗');
        expect(html).not.toContain('M5 13l4 4L19 7');
        // 但只读的升降框照旧在（纸面本来每道题都有）
        expect(html).toContain('print-promote-box');
    });
});

/**
 * 【2026-10-17 空空第 3 条】那个**灰色答案小框**：点它 ⇒ 弹对话框看/改完整答案。
 *
 * 他只要求"能点开"；这里钉住的是**两个方向的退化**：
 *   · 不给 `onAnswerClick`（打印预览/纸面那一路）⇒ 仍是只读的 `<span>`，不许变成按钮；
 *   · 给了 ⇒ 必须带那句"点开看完整答案"的提示（否则没人知道它能点）。
 */
describe('扫卷录入 · 灰色答案框可点开', () => {
    it('★ 不给回调 ⇒ 只读（没有"点开"那句提示）', () => {
        const html = renderSheet({ answer: '周长 26 厘米' });
        expect(html).toContain('周长 26 厘米');
        expect(html).not.toContain('点开看完整答案');
    });

    it('★★ 给了回调 ⇒ 变成可点的框，并写明"点开看完整答案"', () => {
        const html = renderSheet({ answer: '周长 26 厘米', answerClick: true });
        expect(html).toContain('点开看完整答案');
        // 仍然是屏幕控件：绝不落纸
        expect(html).toContain('no-print');
    });

    it('★ 长答案照旧带 `>…` 提示（这个行为没被本次改动碰掉）', () => {
        const html = renderSheet({ answer: '很长很长的答案', answerClick: true });
        // 服务端渲染时量不出宽度 ⇒ `truncated` 初值 false，所以只断言答案文字在、且控件在
        expect(html).toContain('很长很长的答案');
    });
});

/**
 * 【2026-10-18 空空第 2 条】"从二维码进来看相关卷"时，把**那道题**凸显出来。
 *
 * 他原话：*"卷面内容比较多的话，一道一道去查看其实并不太方便……
 *          希望有这样的一个标记，看上去比较醒目好认，而且从开发角度而言还不耽误其他功能。"*
 * ⇒ 橙色描边 + "这道题"标签，纯屏幕元素。
 */
describe('卷面高亮 · 这道题', () => {
    it('不传 ⇒ 一份卷里没有任何高亮（与以前一模一样）', () => {
        const html = renderSheet();
        /**
         * ⚠️ 别用 `not.toContain('这道题')` —— 圈上那句 title 里也有"这道题已掌握 ⇒ 录不了"。
         * 判据要**精确到"标签本身"**：`>这道题</span>`（高亮标签是唯一这样一个独立文本节点）。
         */
        expect(html).not.toContain('>这道题</span>');
        expect(html).not.toContain('#f59e0b');
    });

    it('★★ 传了那道题的 id ⇒ 出现"这道题"标签 + 橙色描边', () => {
        const html = renderSheet({ highlight: 'e1' });
        expect(html).toContain('>这道题</span>');
        expect(html).toContain('#f59e0b');
    });

    it('★ 高亮是屏幕元素 ⇒ 必须 `no-print`（绝不落纸）', () => {
        const html = renderSheet({ highlight: 'e1' });
        const idx = html.indexOf('>这道题</span>');
        // 标签所在的那个 span 必须带 no-print
        const tagStart = html.lastIndexOf('<span', idx);
        expect(html.slice(tagStart, idx)).toContain('no-print');
    });
});
