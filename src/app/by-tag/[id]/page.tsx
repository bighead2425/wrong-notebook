"use client";

/**
 * 按**知识点**看题 —— 点一个标签，把挂在它（以及它下面所有子知识点）上的错题列出来。
 *
 * 【2026-11-01 建】标签准了之后，"这个知识点她错了哪些题"才成立。
 *
 * 【2026-11-02 真真重写】空空提了三条，一次解决：
 *
 *  ① **"每个错题卡都非常宽……进错题本里一行是三个"**
 *     ⇒ 原来这页自己写了一套列表（没 grid、没有多选、没有分页）。
 *       现在**直接用 `ErrorList`** —— 那是错题本页同一个组件，一行三个、
 *       多选 / 删除 / 筛选 / 等级 / 关联 / 分页**全都有**。
 *
 *  ② **"点返回，路径往往不是原来进入的路径"**
 *     ⇒ 读 `?back=`（站内路径白名单，照 `/scan?back=` 的做法）：
 *       从详情页标签点进来 ⇒ 回那道题；从标准标签库进来 ⇒ 回标签库。
 *       没带 `back` 就退回 `/tags`。
 *
 *  ③ **"能不能和错题本页面功能基本一致，像是临时建了个错题本"**
 *     ⇒ 复用组件就意味着**永远一致**：以后错题本页加什么，这页自动跟着有。
 *
 * ⚠️ 查题走 `?tagId=…&includeChildren=1` —— **按 id 不按名字**：
 *   「计算」「阅读理解」这种名字在不同学科/不同册下都存在，按名字会串。
 * ⚠️ `includeChildren=1` 不能省：点一个"节"时，题其实挂在它**下面更深的知识点**上。
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Printer, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api-client";
import { ErrorList } from "@/components/error-list";
import { useLanguage } from "@/contexts/LanguageContext";

interface TagInfo {
    id: string;
    name: string;
    path: string;
    subject: string;
    isSystem: boolean;
    itemCount: number;
    childCount: number;
    subtreeSize: number;
}

export default function ByTagPage() {
    const params = useParams<{ id: string }>();
    const router = useRouter();
    const { language } = useLanguage();
    const L = (zh: string, en: string) => (language === "zh" ? zh : en);

    const [tag, setTag] = useState<TagInfo | null>(null);
    /** `ErrorList` 报上来的数：当前筛完剩多少 / 这一类一共多少 */
    const [counts, setCounts] = useState<{ total: number; notebookTotal: number | null }>({
        total: 0,
        notebookTotal: null,
    });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    /** 返回目标：`?back=` 带来的站内路径；没有就回标准标签库 */
    const [backTo, setBackTo] = useState("/tags");

    /** 【第 2 条】怎么进来怎么回去 —— 只认站内路径（`//` 开头是协议相对 URL，挡掉） */
    useEffect(() => {
        const b = new URLSearchParams(window.location.search).get("back");
        if (b && b.startsWith("/") && !b.startsWith("//")) setBackTo(b);
    }, []);

    useEffect(() => {
        const id = params?.id;
        if (!id) return;
        let cancelled = false;

        (async () => {
            setLoading(true);
            setError(null);
            try {
                const info = await apiClient.get<TagInfo>(`/api/tags/${id}`);
                if (!cancelled) setTag(info);
            } catch (e) {
                if (!cancelled) {
                    console.error(e);
                    setError(L("这一类没能加载出来", "Could not load this tag"));
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- L 每次渲染都是新函数，进依赖会无限拉
    }, [params?.id]);

    const handlePrint = () => {
        if (!tag) return;
        /**
         * 直接跳打印预览：它会把 URL 参数原样透传给列表接口，
         * 所以 `tagId + includeChildren` 在那边照样生效。
         * 不在这一页另做一套"勾选 + 组卷"——那是组卷页的事，两处各写一遍必然走样。
         */
        router.push(`/print-preview?tagId=${encodeURIComponent(tag.id)}&includeChildren=1`);
    };

    return (
        <main className="min-h-screen bg-background">
            <div className="container mx-auto space-y-5 p-4 pb-20">
                <div className="flex items-start gap-3">
                    {/**
                     * 【第 2 条】返回 = 进来时那条路。
                     * `?back=` 由入口带过来（详情页的标签 / 标签管理页的行）；
                     * 没带就回标准标签库 —— 那是"看这一类"最自然的上一层。
                     */}
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={L("返回", "Back")}
                        onClick={() => router.push(backTo)}
                    >
                        <ArrowLeft className="w-4 h-4" />
                    </Button>
                    <div className="min-w-0 flex-1">
                        <h1 className="truncate text-xl font-semibold">
                            {tag?.name ?? L("加载中…", "Loading…")}
                        </h1>
                        {tag && (
                            <p className="mt-0.5 break-all text-xs text-muted-foreground">{tag.path}</p>
                        )}
                        {tag && (
                            <p className="mt-2 text-sm">
                                {L("共 ", "Total ")}
                                <span className="font-medium">{counts.notebookTotal ?? tag.itemCount}</span>
                                {L(" 道题", " questions")}
                                {tag.childCount > 0 && (
                                    <span className="text-muted-foreground">
                                        {L(
                                            `（含 ${tag.childCount} 个子知识点）`,
                                            ` (incl. ${tag.childCount} sub-tags)`,
                                        )}
                                    </span>
                                )}
                                {counts.notebookTotal !== null && counts.total !== counts.notebookTotal && (
                                    <span className="text-muted-foreground">
                                        {L(`　当前筛选后 ${counts.total} 道`, `　filtered: ${counts.total}`)}
                                    </span>
                                )}
                            </p>
                        )}
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handlePrint}
                        disabled={!tag || tag.itemCount === 0}
                        className="shrink-0"
                    >
                        <Printer className="mr-1 h-4 w-4" />
                        {L("打印这一组", "Print these")}
                    </Button>
                </div>

                {loading ? (
                    <div className="flex items-center gap-2 p-10 text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        {L("正在加载…", "Loading…")}
                    </div>
                ) : error ? (
                    <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
                        {error}
                    </div>
                ) : (
                    /**
                     * 【第 1、3 条】与错题本页**同一个组件** ⇒ 一行三个、多选、删除选中、
                     * 筛选、等级、关联、分页全都有；以后错题本页加功能这页也跟着有。
                     */
                    <ErrorList
                        tagId={params?.id}
                        includeChildren
                        subjectName={tag?.subject}
                        onCountChange={setCounts}
                    />
                )}
            </div>
        </main>
    );
}
