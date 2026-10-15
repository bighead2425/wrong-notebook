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
import {
    ATTENTION_LEVELS,
    FILTER_KEYS,
    MASTERED_FILTER_KEY,
    attentionFullName,
    isFilterUnfiltered,
    toggleFilterKey,
} from '@/lib/attention-level';

/**
 * 【2026-09-30 建，2026-10-15 **改成「掌握/等级」合并筛选**】
 *
 * 他定的规矩（逐条对上）：
 *   · 点一次切换选中，前面有 ✓ / 无 ✓ 作标识；
 *   · 底部两排按钮：第一排 = **全选 / 清除**（同一个按钮，文字随草稿状态变）；
 *     第二排 = **取消 / 确认**；
 *   · **一个都没勾 ⇒ 确认置灰不可点**（他的核心诉求）；
 *   · 改动只在**确认**时才吐给外面 —— 边点边筛会让列表在菜单后面乱跳，也看不出"我改了什么"。
 *
 * ⭐【2026-10-15】空空把原【筛选】里的「掌握状态」整组并进来 ⇒ 选项变成 6 个：
 *    **已掌握 / 🍜D稳了 / 🥘C还行 / 🥐B该练 / 🥥A抓紧 / 🥗S此刻**
 *    键的集合（`mastered` + `1..5`）与"至少留一个勾"的规则都在 `lib/attention-level.ts`
 *    （唯一实现）；服务端把选中项拼成 `OR`、并给等级分支加 `masteryLevel < 2`
 *    ⇒ **已掌握优先于等级**（已掌握的题不会出现在任何等级档的结果里）。
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
    /** 当前生效的键（`mastered` + `1..5`）；长度 = 全部 = 未筛 */
    value: string[];
    onConfirm: (next: string[]) => void;
    language?: 'zh' | 'en';
    className?: string;
}) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<string[]>(value);

    const zh = language === 'zh';
    /** 全部选中 = 等于没筛（按钮保持"未筛"的样子） */
    const isAll = isFilterUnfiltered(value);

    const toggle = (key: string) => {
        // "至少留一个勾"的规则在 lib 里（唯一实现），这里只负责调用
        setDraft((prev) => toggleFilterKey(prev, key));
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
            <DropdownMenuContent align="end" className="w-48">
                {/* 第一项：**已掌握**（排在最前 —— 空空定的顺序） */}
                <DropdownMenuItem
                    disabled={draft.includes(MASTERED_FILTER_KEY) && draft.length <= 1}
                    onSelect={(e) => {
                        e.preventDefault(); // 不关菜单：多选要能连着点几个
                        toggle(MASTERED_FILTER_KEY);
                    }}
                >
                    <span className="w-4 shrink-0">{draft.includes(MASTERED_FILTER_KEY) ? '✓' : ''}</span>
                    <span>{zh ? '已掌握' : 'Mastered'}</span>
                </DropdownMenuItem>

                {/* 剩下五项：按"最不急 → 最急"排（1→5，与 `ATTENTION_LEVELS` 一致） */}
                {ATTENTION_LEVELS.map((lv) => {
                    const key = String(lv.value);
                    const checked = draft.includes(key);
                    return (
                        <DropdownMenuItem
                            key={key}
                            disabled={checked && draft.length <= 1}
                            onSelect={(e) => {
                                e.preventDefault();
                                toggle(key);
                            }}
                        >
                            <span className="w-4 shrink-0">{checked ? '✓' : ''}</span>
                            {/* 图标 + 字母 + 名称（如 🥐B该练）—— 字母与名称都来自 `ATTENTION_LEVELS`，
                                别在这儿拼字符串（本项目的老教训）。 */}
                            <span>
                                {lv.medal}
                                {attentionFullName(lv.value, zh)}
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
                        onClick={() => setDraft(draft.length === 0 ? [...FILTER_KEYS] : [])}
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
