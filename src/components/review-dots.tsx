"use client";

import { reviewDots } from '@/lib/review-outcomes';

/**
 * 【2026-09-30】错题卡底部中间的**四个复习结果圆圈**。
 *
 * 四个圈：前三个 = 第 1 / 7 / 21 天三次**计划**复习，第四个 = **最近一次**复习。
 * 前三个与第四个之间用一条 `|` 隔开（他要的："前三个圆圈和最后一个圆圈用 | 隔开"）。
 *
 * 三种状态（他定的话）：
 *   · 灰圈（只留圈、不填色）  = 还没有结果
 *   · 浅绿底 + 白对号        = 那一次做对了
 *   · 浅粉底 + 灰错号        = 那一次做错了
 *
 * ⚠️ 颜色刻意**不用** manageType 那套红/绿：这里绿=会对、粉=会错，
 *    是"结果"的颜色；"深挖/复练"那套讲的是"怎么处置"。同一个红绿表示两件事，
 *    看卡片的人会误读。
 */
export function ReviewDots({
    outcomes,
    language = 'zh',
    className = '',
}: {
    /** `ErrorItem.reviewOutcomes` 原样传进来（字符串或对象都认） */
    outcomes?: unknown;
    language?: 'zh' | 'en';
    className?: string;
}) {
    const dots = reviewDots(outcomes);

    return (
        <span className={`inline-flex items-center gap-1 ${className}`}>
            {dots.map((d, i) => (
                <span key={d.key} className="inline-flex items-center">
                    {/* 第 4 个圈（"最近一次"）与前面三个隔开 */}
                    {i === 3 && (
                        <span
                            aria-hidden="true"
                            className="mx-1 text-[9px] leading-none text-zinc-400"
                        >
                            |
                        </span>
                    )}
                    <span
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
                </span>
            ))}
        </span>
    );
}
