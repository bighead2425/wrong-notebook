"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BookOpen, Pencil, Trash2, Archive, ArchiveRestore, ArrowUpLeft, ArrowDownRight, Merge } from "lucide-react";
import { Button } from "@/components/ui/button";
/**
 * 【2026-10-13 需求第 1 条】学科配色 —— **不新造一套颜色**：
 * 就用纸面上那套 9 色 + 其他（"明度统一偏深、色相拉开、天然冗余"三条原则见该文件头）。
 */
import { getSubjectColorDef } from "@/lib/subject-colors";

interface NotebookCardProps {
    id: string;
    displayName: string;      // 自由显示名，如 "小五上数学"
    errorCount: number;
    meta?: string;            // 副标题，如 "五年级 · 上 · 数学"
    archived?: boolean;       // 已归档本置灰（H2 四分法）
    onClick: () => void;
    onRename?: () => void;
    onDelete?: (id: string) => void;
    /** 归档 / 拉回（B15：逐本归档 + 按本拉回，不做批量按钮） */
    onToggleArchive?: (id: string) => void;
    itemLabel?: string;
    /**
     * 【2026-10-12 需求第 6/7 条】拖动时那几个**临时外观**由外面算好传进来：
     *   · 正在被拖的那张 ⇒ 红边框
     *   · 指针停在它身上（落点）⇒ 粉色填充
     *   · 双击选中的"目标本" ⇒ 黄边框
     * 卡片自己**不判断**这些状态（判断只在页面那一处），这里只负责把它画出来。
     */
    className?: string;
    /**
     * 【2026-10-12 晚 · 需求第 3 条】卡片**右下角那三个按钮**。
     *
     * 他原话："我决定修改操作逻辑，在错题本卡片右下角增加三个按钮，
     *          一是指向左上方的箭头，点击后错题本卡片向前移动一位；
     *          二是指向右下方的箭头，点击后错题本卡片向后移动一位；
     *          三是合并按钮，点击后替代目前双击错题本卡片的操作……"
     *
     * ⇒ 上一版给卡片挂的 `onDoubleClick` **已经删掉**（双击与单击互相抢，
     *    他实测"单击进不去、双击没反应"）。现在这三种操作各有一个明确的按钮，
     *    单击永远是"进错题本"。
     */
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    /** 到头了就置灰（第一张不能再往前、最后一张不能再往后） */
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    /** 合并键：点它选中这一本（再点另一张卡并入；再点自己取消）。**已归档不传** */
    onMerge?: () => void;
    /** 已选中（黄框 + 按钮高亮） */
    mergeArmed?: boolean;
    /**
     * 【2026-10-13 需求第 1 条】学科 `subjectKey`（math/chinese/…/other）。
     *
     * 他给了两个方案（换 10 种符号 vs 把符号染色）让我判，我判的是**染色**：
     *   ① 你们自己定的配色原则里就写着"颜色只是一眼识别的加成，**天然冗余靠 2 字母简拼**"，
     *      换 10 种符号正好违背它 —— 在 20px 那个大小上，书/卷轴/原子/烧瓶**互相分不出来**，
     *      等于用更弱的信号换掉更强的信号（副标题本来就印着"数学/语文"）；
     *   ② 染色 + 左侧一条学科色带是**零维护**（颜色表本来就在 `subject-colors.ts`），
     *      而 10 套符号要人一个个去认、去记。
     *
     * ⚠️ 只染**色**，不改学科名 —— 名字在副标题里（`meta`），不重复。
     * ⚠️ 传空（未归本）⇒ **不染色**（保持原来那个主题色图标 + 无色带），
     *    因为"没归本"不是一个学科；`'other'` 是**真学科**，照染（黑）。
     */
    subject?: string | null;
}

export function NotebookCard({
    id, displayName, errorCount, meta, archived = false,
    onClick, onRename, onDelete, onToggleArchive, itemLabel = "items",
    className = "",
    onMoveUp, onMoveDown, canMoveUp = true, canMoveDown = true,
    onMerge, mergeArmed = false,
    subject,
}: NotebookCardProps) {
    /** 有学科才染色（空 = 未归本，保持原样；`'other'` 是合法学科，照染） */
    const subjectDef = subject && subject.trim() ? getSubjectColorDef(subject) : null;

    return (
        <Card
            className={`cursor-pointer hover:border-primary/50 transition-colors relative overflow-hidden group ${archived ? "opacity-60" : ""} ${className}`}
            onClick={onClick}
        >
            {/* 【2026-10-13】左侧学科色带 —— 列表里扫一眼就知道"哪本是哪科"最快的一处。
                ⚠️ 用**绝对定位的条**而不是 `border-l-4`：卡片自带 `hover:border-primary/50`，
                   走边框的话一悬停色带就被主题色盖掉；绝对定位的条不参与 border 那些变数。 */}
            {subjectDef && (
                <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-1"
                    style={{ background: subjectDef.hex }}
                />
            )}
            <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                        <BookOpen
                            className={`h-5 w-5 shrink-0${subjectDef ? "" : " text-primary"}`}
                            // 有学科 ⇒ 用学科色（inline 压过 class 上的颜色）；没学科 ⇒ 保持主题色
                            style={subjectDef ? { color: subjectDef.hex } : undefined}
                        />
                        <div className="min-w-0">
                            <CardTitle className="text-lg truncate">{displayName}</CardTitle>
                            {meta && (
                                <p className="text-xs text-muted-foreground truncate">{meta}</p>
                            )}
                        </div>
                    </div>
                    {/* ⚠️ 不要用 group-hover 才显示：手机没有 hover，按钮会永远点不到 */}
                    <div className="flex items-center gap-1 shrink-0">
                        {onRename && (
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                className="h-8 w-8"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onRename();
                                }}
                            >
                                <Pencil className="h-4 w-4" />
                            </Button>
                        )}
                        {onToggleArchive && (
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                className="h-8 w-8"
                                title={archived ? "拉回在用" : "归档"}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onToggleArchive(id);
                                }}
                            >
                                {archived
                                    ? <ArchiveRestore className="h-4 w-4" />
                                    : <Archive className="h-4 w-4" />}
                            </Button>
                        )}
                        {onDelete && (
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                className="h-8 w-8"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDelete(id);
                                }}
                            >
                                <Trash2 className={`h-4 w-4 ${errorCount > 0 ? "text-muted-foreground" : "text-destructive"}`} />
                            </Button>
                        )}
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                {/* 【2026-10-12 晚 需求第 3 条】左下角是"几道题"，**右下角那三个按钮**：
                    ↖ 往前一位 / ↘ 往后一位 / ⧉ 合并。
                    ⚠️ 三个都要 `stopPropagation` —— 否则一点它们也顺带把卡片点了（进了错题本）。
                    ⚠️ 到头的那一个 `disabled`（灰掉但**仍然占位**，免得按钮位置跳来跳去）。 */}
                <div className="flex items-center justify-between gap-2">
                    <Badge variant="secondary">
                        {errorCount} {itemLabel}
                    </Badge>
                    {(onMoveUp || onMoveDown || onMerge) && (
                        <div className="flex items-center gap-0.5 shrink-0">
                            {onMoveUp && (
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                    disabled={!canMoveUp}
                                    title="往前移动一位"
                                    aria-label="往前移动一位"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onMoveUp();
                                    }}
                                >
                                    <ArrowUpLeft className="h-4 w-4" />
                                </Button>
                            )}
                            {onMoveDown && (
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                    disabled={!canMoveDown}
                                    title="往后移动一位"
                                    aria-label="往后移动一位"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onMoveDown();
                                    }}
                                >
                                    <ArrowDownRight className="h-4 w-4" />
                                </Button>
                            )}
                            {onMerge && (
                                <Button
                                    variant={mergeArmed ? "default" : "ghost"}
                                    size="icon-sm"
                                    className={`h-7 w-7 ${mergeArmed ? "" : "text-muted-foreground hover:text-foreground"}`}
                                    title={mergeArmed ? "取消合并" : "把这一本并进另一本"}
                                    aria-label={mergeArmed ? "取消合并" : "把这一本并进另一本"}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onMerge();
                                    }}
                                >
                                    <Merge className="h-4 w-4" />
                                </Button>
                            )}
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
