"use client";

/**
 * 【2026-11-06 空空】**标签使用统计：全量排行 + 五种看法。**
 *
 * 原来的实现只有一件事：拿 `{tag, count}` 排个 top20 画横条。
 * 他要的是**所有挂过题的标签都能排**，而且要能换五种角度看——
 * 因为"哪个知识点用得最多"和"这一学期我们哪里不牢"是两个不同的问题。
 *
 * ── 五种模式 ──────────────────────────────────────────────
 * | 模式 | 回答的问题 |
 * |---|---|
 * | 全部 | 这学期整体上，哪些知识点最常出错 |
 * | 按年级 | 每一册（或学段）内部，哪些知识点最常出错 |
 * | 按学科 | 每一科内部，哪些知识点最常出错 |
 * | 年级 → 学科 | **"当前这学期，哪一科哪个知识点最不牢"** |
 * | 学科 → 年级 | **"这一科，在哪一册/学段最吃力"** |
 *
 * ── 为什么"册"对语文/英语是错的 ─────────────────────────────
 * 数学/物理/化学/生物按册（"五年级上"）；语文/英语/政史地按学段（"小学/初中/高中"）。
 * `stage` 由接口沿标签树爬到根算出来，本组件只负责展示，不自己猜。
 *
 * ── 每一条都能点 ────────────────────────────────────────────
 * 点标签名 ⇒ `/by-tag/<id>`，就是知识点页那套（已有功能，接过来即可）。
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import type { TagStats } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

type Mode = "all" | "stage" | "subject" | "stageSubject" | "subjectStage";

const SUBJECT_ORDER = [
    "math",
    "chinese",
    "english",
    "physics",
    "chemistry",
    "biology",
    "history",
    "geography",
    "politics",
];

const SUBJECT_LABEL: Record<string, string> = {
    math: "数学",
    chinese: "语文",
    english: "英语",
    physics: "物理",
    chemistry: "化学",
    biology: "生物",
    history: "历史",
    geography: "地理",
    politics: "道法",
};

/** 册/学段的先后 —— 不靠中文排序，靠这张表；表里没有的排到最后 */
const STAGE_ORDER = [
    "一年级上", "一年级下", "二年级上", "二年级下", "三年级上", "三年级下",
    "四年级上", "四年级下", "五年级上", "五年级下", "六年级上", "六年级下",
    "七年级上", "七年级下", "八年级上", "八年级下", "九年级上", "九年级下",
    "高一上", "高一下", "高二上", "高二下", "高三",
    "小学", "初中", "高中",
];

const stageRank = (s: string | null) => {
    const i = STAGE_ORDER.indexOf(s ?? "");
    return i < 0 ? 999 : i;
};
const subjectRank = (s: string | null) => {
    const i = SUBJECT_ORDER.indexOf(s ?? "");
    return i < 0 ? 999 : i;
};

const UNKNOWN_STAGE = "未标册";
const UNKNOWN_SUBJECT = "未标学科";

export function TagUsageStats({ stats }: { stats: TagStats[] }) {
    const { language } = useLanguage();
    const L = (zh: string, en: string) => (language === "zh" ? zh : en);

    const [mode, setMode] = useState<Mode>("all");
    const [q, setQ] = useState("");

    const MODES: { key: Mode; label: string }[] = [
        { key: "all", label: L("全部排行", "All") },
        { key: "stage", label: L("按年级/学期", "By term") },
        { key: "subject", label: L("按学科", "By subject") },
        { key: "stageSubject", label: L("年级 → 学科", "Term → subject") },
        { key: "subjectStage", label: L("学科 → 年级", "Subject → term") },
    ];

    /**
     * 分组。
     * 五种模式统一成"一组一组"的形状——两级模式只是组标题里带两段，
     * 不为它单写一套嵌套渲染（那样折叠、计数都要写两遍）。
     */
    const groups = useMemo(() => {
        const kw = q.trim();
        const filtered = kw ? stats.filter((s) => s.name.includes(kw)) : stats;

        if (mode === "all") {
            return [{ key: "all", title: "", items: filtered }];
        }

        const map = new Map<string, TagStats[]>();
        for (const s of filtered) {
            const stage = s.stage ?? UNKNOWN_STAGE;
            const subject = s.subject ? (SUBJECT_LABEL[s.subject] ?? s.subject) : UNKNOWN_SUBJECT;
            const key =
                mode === "stage"
                    ? stage
                    : mode === "subject"
                      ? subject
                      : `${stage}\u0000${subject}`;
            const arr = map.get(key) ?? [];
            arr.push(s);
            map.set(key, arr);
        }

        return [...map.entries()]
            .map(([key, items]) => ({
                key,
                title: key.replace("\u0000", " · "),
                items,
            }))
            .sort((a, b) => {
                const [sa, ta] = a.key.split("\u0000");
                const [sb, tb] = b.key.split("\u0000");
                if (mode === "subject") return subjectRank(sa) - subjectRank(sb);
                if (mode === "stage") return stageRank(sa) - stageRank(sb);
                if (mode === "stageSubject") {
                    return stageRank(sa) - stageRank(sb) || subjectRank(ta) - subjectRank(tb);
                }
                /* subjectStage */
                return subjectRank(sa) - subjectRank(sb) || stageRank(ta) - stageRank(sb);
            });
    }, [stats, mode, q]);

    /** 全局最大次数 —— 所有模式共用一把尺子，换模式时条长可比 */
    const maxCount = useMemo(() => Math.max(1, ...stats.map((s) => s.count)), [stats]);
    const totalTagged = stats.length;

    return (
        <div className="space-y-4">
            {/* ── 模式切换 + 搜索 ─────────────────────────────── */}
            <div className="space-y-3">
                <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
                    {MODES.map((m) => (
                        <button
                            key={m.key}
                            type="button"
                            onClick={() => setMode(m.key)}
                            className={cn(
                                "shrink-0 rounded-full border px-3 py-1.5 text-xs transition-colors",
                                mode === m.key
                                    ? "bg-primary text-primary-foreground border-primary"
                                    : "hover:bg-muted",
                            )}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>
                <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={L("搜标签名…", "Search tag…")}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">
                    {L(
                        `${totalTagged} 个标签挂过题${q ? `，筛出 ${groups.reduce((n, g) => n + g.items.length, 0)} 个` : ""}`,
                        `${totalTagged} tags in use`,
                    )}
                </p>
            </div>

            {/* ── 排行 ───────────────────────────────────────── */}
            {groups.map((g) => (
                <section key={g.key}>
                    {g.title && (
                        <h3 className="mb-1.5 flex items-baseline gap-2 text-sm font-semibold">
                            {g.title}
                            <span className="text-xs font-normal text-muted-foreground">
                                {g.items.length}
                            </span>
                        </h3>
                    )}
                    <ul className="divide-y rounded-lg border">
                        {g.items.map((s, i) => {
                            const row = (
                                <div className="flex items-center gap-2.5 px-3 py-1.5">
                                    <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                                        {i + 1}
                                    </span>
                                    <span
                                        className={cn(
                                            "shrink-0 text-sm",
                                            /* 自建标签沿用卡片上那条规矩：紫色 = 词表里找不到 */
                                            s.isSystem === false && "text-violet-700",
                                        )}
                                    >
                                        {s.name}
                                    </span>
                                    <span className="min-w-0 flex-1" />
                                    <div className="hidden h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-muted sm:block">
                                        <div
                                            className="h-full rounded-full bg-primary/70"
                                            style={{ width: `${(s.count / maxCount) * 100}%` }}
                                        />
                                    </div>
                                    <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                                        {s.count}
                                    </span>
                                </div>
                            );
                            /* 没有 id 的老数据（关系还没建）不可点——没有落点可跳 */
                            return (
                                <li key={s.id ?? `n:${s.name}`} className="hover:bg-muted/50">
                                    {s.id ? (
                                        <Link href={`/by-tag/${s.id}?back=${encodeURIComponent("/tags")}`}>
                                            {row}
                                        </Link>
                                    ) : (
                                        row
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ))}

            {groups.every((g) => g.items.length === 0) && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                    {L("没有匹配的标签", "No matching tags")}
                </p>
            )}
        </div>
    );
}
