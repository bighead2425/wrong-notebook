"use client";

import { reviewDots } from '@/lib/review-outcomes';

/**
 * 【2026-09-30 立 · 2026-10-16 换判据】错题卡底部中间的**四个复习结果圆圈**。
 *
 * ⭐【2026-10-16 如如】出处：`docs\18` §4.1 + 他原话"**卡片不大，有四个圈就够了**"。
 *
 *   以前：4 个计划格 + 1 个"最近一次"（**5 个圈**），中间画一条 `|` 隔开，
 *         每个圈悬停显示**计划日期**（录入日 +1/+7/+21/+49）。
 *   现在：**4 个圈 = 最近 4 条复习结果**（`recent`），
 *         **没有 `|`、没有日期**；不足 4 条 ⇒ 后面的画灰圈（"还没录"）。
 *
 *   为什么去掉 `|` 和日期：这两个都是"计划格"那套模型的产物 ——
 *   现在结果是一条条的流水（一条一次、带日期），**"第几格"只在纸上有意义**
 *   （纸背面印着四个日期框），卡片上再画格子只会跟流水对不上。
 *
 * 三种状态（他定的话，一个字没变）：
 *   · 灰圈（只留圈、不填色）  = 还没有结果
 *   · 浅绿底 + 白对号        = 那一次做对了
 *   · 浅粉底 + 灰错号        = 那一次做错了
 *
 * ⚠️ 颜色刻意**不用** manageType 那套红/绿：这里绿=会对、粉=会错，
 *    是"结果"的颜色；"深挖/复练"那套讲的是"怎么处置"。同一个红绿表示两件事，
 *    看卡片的人会误读。
 * ⚠️ 配色与卷页的圆**同一份常量**（`REVIEW_MARK_COLORS`）—— 同一屏不许出现两套红绿。
 */
export function ReviewDots({
    outcomes,
    language = 'zh',
    className = '',
}: {
    /** `ErrorItem.reviewOutcomes` 原样传进来（字符串或对象都认；**新旧形状都认**） */
    outcomes?: unknown;
    language?: 'zh' | 'en';
    className?: string;
}) {
    const dots = reviewDots(outcomes);

    return (
        <span className={`inline-flex items-center gap-1 ${className}`}>
            {dots.map((d) => (
                <span
                    key={d.key}
                    title={language === 'zh' ? d.zh : d.en}
                    style={{
                        width: '11px',
                        height: '11px',
                        borderRadius: '9999px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '7px',
                        lineHeight: 1,
                        fontWeight: 700,
                        ...(d.state === 'right'
                            ? { background: '#6fbf8b', color: '#ffffff' }
                            : d.state === 'wrong'
                              ? { background: '#f6c9cf', color: '#8a8a8a' }
                              : { background: 'transparent', border: '1px solid #cfcfcf', color: 'transparent' }),
                    }}
                >
                    {d.state === 'right' ? '✓' : d.state === 'wrong' ? '✗' : '·'}
                </span>
            ))}
        </span>
    );
}
