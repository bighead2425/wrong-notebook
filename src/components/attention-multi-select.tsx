"use client";

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChevronDown, Medal } from 'lucide-react';
import { ATTENTION_LEVELS, isAttentionUnfiltered, toggleAttentionLevel } from '@/lib/attention-level';

/**
 * 【2026-09-30】「等级」筛选 —— **多选**下拉（🥉青铜 … 👑王者）。
 *
 * 他定的规矩（逐条对上）：
 *   · 点一次切换选中，前面有 ✓ / 无 ✓ 作标识；
 *   · 【2026-10-03 改】底部两排按钮：
 *       第一排 = **全选 / 清除**（同一个按钮，文字随草稿状态变）；
 *       第二排 = **取消 / 确认**；
 *   · **一个都没勾 ⇒ 确认置灰不可点**（他的核心诉求）：只有至少勾了一个等级，确认才可点；
 *   · 改动只在**确认**时才吐给外面 —— 边点边筛会让列表在菜单后面乱跳，也看不出"我改了什么"。
 *
 * ⚠️ 用 **draft 草稿**而不是直接改外部 state：`onOpenChange` 打开时把外部值拷进草稿，
 *    「取消」只需丢掉草稿即可（不需要外部把值传回来，也不会因为 props 变了而半路被覆盖）。
 */
export function AttentionMultiSelect({
    value,
    onConfirm,
    language = 'zh',
    className = '',
}: {
    /** 当前生效的等级（1-5）；长度为 5 = 未筛 */
    value: number[];
    onConfirm: (next: number[]) => void;
    language?: 'zh' | 'en';
    className?: string;
}) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<number[]>(value);

    const zh = language === 'zh';
    const allValues = ATTENTION_LEVELS.map((l) => l.value);
    /** 全部选中 = 等于没筛（按钮保持"未筛"的样子） */
    const isAll = isAttentionUnfiltered(value);

    const toggle = (v: number) => {
        // "至少留一个勾"的规则在 lib 里（唯一实现），这里只负责调用
        setDraft((prev) => toggleAttentionLevel(prev, v));
    };

    return (
        <DropdownMenu
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                // 打开时把"外部生效值"拷成草稿：取消时丢掉草稿即可回到原样
                if (next) setDraft(value);
            }}
        >
            <DropdownMenuTrigger asChild>
                <Button
                    variant={isAll ? 'outline' : 'secondary'}
                    size="sm"
                    className={`${isAll ? '' : 'bg-zinc-300 text-zinc-900 hover:bg-zinc-300/90'} ${className}`}
                >
                    <Medal className="mr-1.5 h-3.5 w-3.5" />
                    {zh ? '等级' : 'Level'}
                    {!isAll && ` · ${value.length}`}
                    <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
                {ATTENTION_LEVELS.map((lv) => {
                    const checked = draft.includes(lv.value);
                    const onlyOneLeft = checked && draft.length <= 1;
                    return (
                        <DropdownMenuItem
                            key={lv.value}
                            disabled={onlyOneLeft}
                            onSelect={(e) => {
                                // 不关菜单：多选要能连着点几个
                                e.preventDefault();
                                toggle(lv.value);
                            }}
                        >
                            <span className="w-4 shrink-0">{checked ? '✓' : ''}</span>
                            <span>
                                {lv.medal} {zh ? lv.zh : lv.en}
                            </span>
                        </DropdownMenuItem>
                    );
                })}

                <DropdownMenuSeparator />

                {/* 【2026-10-03 他要求】底部改成**两排**：
                    第一排 = 全选 / 清除（同一个按钮，文字随草稿变：一个没勾显示"全选"，有勾显示"清除"）；
                    第二排 = 取消 / 确认。
                    ⚠️ 硬约束：一个都没勾 ⇒ 确认**置灰不可点**（只有至少勾一个等级才可点）。 */}
                <div className="space-y-1 p-1">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 w-full px-1 text-xs"
                        onClick={() => setDraft(draft.length === 0 ? [...allValues] : [])}
                    >
                        {draft.length === 0 ? (zh ? '全选' : 'All') : (zh ? '清除' : 'Clear')}
                    </Button>
                    <div className="flex items-center gap-1">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 flex-1 px-1 text-xs"
                            onClick={() => {
                                setDraft(value);
                                setOpen(false);
                            }}
                        >
                            {zh ? '取消' : 'Cancel'}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            className="h-7 flex-1 bg-black px-1 text-xs text-white hover:bg-black/90"
                            /* 一个都没勾 ⇒ 灰掉不可点（他明确要求的那条硬约束） */
                            disabled={draft.length === 0}
                            onClick={() => {
                                if (draft.length === 0) return;
                                onConfirm(draft);
                                setOpen(false);
                            }}
                        >
                            {zh ? '确认' : 'OK'}
                        </Button>
                    </div>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
