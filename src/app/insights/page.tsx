"use client";

/**
 * 【2026-10-01 新增，同日按他的设计答复改】**日积月累页**（`/insights`）。
 *
 * 他定的结构：左右两栏。左栏 = 条目清单（编号 `JLyyyymmddxxx`）+ **筛选**（年级/学期 + 学科多选 + 检索）；
 * 右栏 = 年级/学期 + 10 个学科按钮 + 大 md 编辑框 + 拍照 + **相关错题的错题卡**（他说"给卡比给二维码直接"）。
 *
 * ── 三个实现要点（都来自 2026-10-01 的设计答复）─────────────────────
 *  ① **图片不在列表里**：存储改正后图片在 `InsightPhoto` 表，选中某条时才单独取
 *     （列表查询完全不碰它 —— "字典不贴照片"）。
 *  ② **关联错题用题号**（`errorItemNo`）：题被删了条目还挂着题号；
 *     活题由接口按题号查回来（回收箱里的题会带 `inTrash` 标记）。
 *  ③ **错题卡不显示删除**（共享卡片不给 onTrash 就没有那个按钮）：
 *     在积累页点"删错题"人会发懵 —— 删除回错题本页做。
 *
 * 其余（编号由服务端发、data URL 存图、改动即存）见第一版的文件头。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { BackButton } from '@/components/ui/back-button';
import { MdEditor } from '@/components/md-editor';
import { apiClient } from '@/lib/api-client';
import { useLanguage } from '@/contexts/LanguageContext';
import { processImageFile } from '@/lib/image-utils';
import { GRADE_SEMESTER_OPTIONS } from '@/lib/grade-semester-options';
import { SUBJECT_OPTIONS, subjectLabel } from '@/lib/notebook-fields';
import { cleanMarkdown } from '@/lib/markdown-utils';
import { dayKey } from '@/lib/calendar-grid';
import { ErrorItemCard } from '@/components/error-item-card';
import type { ErrorItem } from '@/types/api';
import { Camera, House, Plus, Printer, Save, Search, Trash2, X } from 'lucide-react';

interface InsightRow {
    id: string;
    code: string;
    dateKey: string;
    seq: number;
    gradeSemester: string | null;
    subject: string | null;
    content: string | null;
    errorItemNo: string | null;
    source: string | null;
    createdAt: string;
}

/** 选中的条目单独取详情时，接口额外给的（图片本体 + 活题） */
interface InsightDetail extends InsightRow {
    photo: string | null;
    question: ErrorItem | null;
}

export default function InsightsPage() {
    const { t, language } = useLanguage();
    const L = (zh: string, en: string) => (language === 'zh' ? zh : en);

    const [rows, setRows] = useState<InsightRow[]>([]);
    const [questions, setQuestions] = useState<Record<string, ErrorItem>>({});
    const [loading, setLoading] = useState(true);

    // 筛选（他 2026-10-01 定的：年级学期 + 学科多选 + 检索；日期只排先后不筛）
    const [grade, setGrade] = useState('');
    const [subjectSet, setSubjectSet] = useState<Set<string>>(new Set());
    const [query, setQuery] = useState('');

    const [currentId, setCurrentId] = useState<string | null>(null);
    const current = useMemo(() => rows.find((r) => r.id === currentId) ?? null, [rows, currentId]);

    // 编辑区状态
    const [gradeDraft, setGradeDraft] = useState('');
    const [subjectDraft, setSubjectDraft] = useState('');
    const [content, setContent] = useState('');
    const [photo, setPhoto] = useState<string | null>(null);
    /** 打开这条时**库里的**图片长什么样（脏判断的基准；改了图没保存 ⇒ photo !== loadedPhoto） */
    const [loadedPhoto, setLoadedPhoto] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const fileRef = useRef<HTMLInputElement | null>(null);

    const dirty =
        !!current &&
        (gradeDraft !== (current.gradeSemester ?? '') ||
            subjectDraft !== (current.subject ?? '') ||
            content !== (current.content ?? '') ||
            photo !== loadedPhoto);

    const fetchList = useCallback(
        async () => {
            setLoading(true);
            try {
                const qs = new URLSearchParams();
                if (grade) qs.set('grade', grade);
                if (subjectSet.size > 0) qs.set('subjects', [...subjectSet].join(','));
                if (query.trim()) qs.set('q', query.trim());
                const res = await apiClient.get<{ insights: InsightRow[]; questions: Record<string, ErrorItem> }>(
                    `/api/insights${qs.toString() ? `?${qs.toString()}` : ''}`,
                );
                setRows(res.insights || []);
                setQuestions(res.questions || {});
                return res.insights || [];
            } catch (error) {
                console.error(error);
                return [];
            } finally {
                setLoading(false);
            }
        },
        [grade, subjectSet, query],
    );

    useEffect(() => {
        fetchList();
    }, [fetchList]);

    /** 选中某条 ⇒ 单独取详情（**图片在这里才取**，列表不背） */
    useEffect(() => {
        if (!current) return;
        let alive = true;
        setLoadedPhoto(null);
        apiClient
            .get<InsightDetail>(`/api/insights/${current.id}`)
            .then((d) => {
                if (!alive) return;
                setGradeDraft(d.gradeSemester ?? '');
                setSubjectDraft(d.subject ?? '');
                setContent(d.content ?? '');
                setLoadedPhoto(d.photo ?? null);
                setPhoto(d.photo ?? null);
            })
            .catch((error) => console.error(error));
        return () => {
            alive = false;
        };
    }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    /** 新建：编号由服务端发（日期段用**本地日期**） */
    const createOne = async () => {
        try {
            const created = await apiClient.post<InsightRow>('/api/insights', {
                dateKey: dayKey(new Date()),
                gradeSemester: gradeDraft || null,
                subject: subjectDraft || null,
                content: '',
                source: 'page',
            });
            setRows((prev) => [created, ...prev]);
            setCurrentId(created.id);
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.saveFailed || 'Create failed');
        }
    };

    /** 切条目：有未保存改动先问一句（**不静默丢**） */
    const selectRow = (id: string) => {
        if (id === currentId) return;
        if (dirty && !confirm(L('这条有改动还没保存，要放弃吗？', 'Unsaved changes will be lost. Continue?'))) {
            return;
        }
        setCurrentId(id);
    };

    const save = async () => {
        if (!current) return;
        setSaving(true);
        try {
            const updated = await apiClient.patch<InsightRow>(`/api/insights/${current.id}`, {
                gradeSemester: gradeDraft || null,
                subject: subjectDraft || null,
                content,
                photo,
            });
            setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
            setLoadedPhoto(photo);
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.saveFailed || 'Save failed');
        } finally {
            setSaving(false);
        }
    };

    const discard = () => {
        if (!current) return;
        setGradeDraft(current.gradeSemester ?? '');
        setSubjectDraft(current.subject ?? '');
        setContent(current.content ?? '');
        setPhoto(loadedPhoto);
    };

    const remove = async () => {
        if (!current) return;
        if (!confirm(L(`删除「${current.code}」？删了就没了。`, `Delete ${current.code}?`))) return;
        try {
            await apiClient.delete(`/api/insights/${current.id}`);
            setRows((prev) => prev.filter((r) => r.id !== current.id));
            setCurrentId(null);
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.deleteFailed || 'Delete failed');
        }
    };

    /** 拍照：就地压缩成 data URL（本次会话先存草稿，保存时才进图片表） */
    const onPickPhoto = async (file: File | undefined) => {
        if (!file) return;
        try {
            const dataUrl = await processImageFile(file);
            setPhoto(dataUrl);
        } catch (error) {
            console.error(error);
            alert(L('这张图读不出来，换一张试试', 'Could not read that image'));
        }
    };

    /** 学科多选：点一下选中（可组合），再点取消 */
    const toggleSubject = (key: string) => {
        setSubjectSet((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return rows;
        return rows.filter(
            (r) => r.code.toLowerCase().includes(q) || (r.content || '').toLowerCase().includes(q),
        );
    }, [rows, query]);

    /** 右栏要出的错题卡（关联题号 → 活题；回收箱里的题卡片会带提示） */
    const linkedQuestion: ErrorItem | null =
        current?.errorItemNo && questions[current.errorItemNo]
            ? (questions[current.errorItemNo] as ErrorItem)
            : null;

    return (
        <main className="min-h-screen bg-background">
            {/* 顶栏 */}
            <div className="border-b bg-background">
                <div className="mx-auto flex w-full max-w-[1400px] items-center gap-2 px-4 py-3 md:px-8">
                    <BackButton fallbackUrl="/" className="shrink-0" />
                    <h1 className="text-lg font-semibold">{L('日积月累', 'Takeaways')}</h1>
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                        {L('从错题里攒下来的一句话，一条一个编号', 'One line per takeaway, one code each')}
                    </span>
                    <span className="flex-1" />
                    <Button size="sm" onClick={createOne}>
                        <Plus className="mr-1.5 h-4 w-4" />
                        {L('新建一条', 'New')}
                    </Button>
                    {/* 【2026-10-01 第三轮】**打印另开一屏**（他担心的对）：
                        编辑与打印是两种状态（未保存的改动、量高、分页、页码），
                        硬塞进同一个右栏久了必然互相打架。 */}
                    <Link href="/insights/print">
                        <Button variant="outline" size="sm" title={L('把挑出来的条目排成积累纸印出来', 'Print picked entries on takeaway sheets')}>
                            <Printer className="mr-1.5 h-4 w-4" />
                            {L('打印', 'Print')}
                        </Button>
                    </Link>
                    <Link href="/">
                        <Button variant="ghost" size="icon" title={L('返回主页', 'Home')}>
                            <House className="h-5 w-5" />
                        </Button>
                    </Link>
                </div>
            </div>

            <div className="mx-auto w-full max-w-[1400px] px-4 py-4 md:px-8">
                <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
                    {/* ===== 左栏：筛选 + 条目清单 ===== */}
                    <aside className="space-y-2">
                        {/* 【2026-10-01 他定的】筛选：年级/学期 + 学科**多选**；日期只排先后不筛 */}
                        <Select value={grade || '__all__'} onValueChange={(v) => setGrade(v === '__all__' ? '' : v)}>
                            <SelectTrigger className="h-9 w-[150px] text-sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__all__">{L('全部学期', 'All terms')}</SelectItem>
                                {GRADE_SEMESTER_OPTIONS.map((g) => (
                                    <SelectItem key={g} value={g}>
                                        {g}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <div className="flex flex-wrap gap-1">
                            {SUBJECT_OPTIONS.map((s) => {
                                const on = subjectSet.has(s.key);
                                return (
                                    <Button
                                        key={s.key}
                                        type="button"
                                        size="sm"
                                        variant={on ? 'secondary' : 'outline'}
                                        className={`h-7 px-2 text-xs ${on ? 'bg-zinc-300 text-zinc-900 hover:bg-zinc-300/90' : ''}`}
                                        onClick={() => toggleSubject(s.key)}
                                    >
                                        {s.label}
                                    </Button>
                                );
                            })}
                        </div>
                        <div className="relative">
                            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                            <Input
                                className="h-9 pl-7 text-sm"
                                placeholder={L('搜编号或内容…', 'Search code or text…')}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                            />
                        </div>

                        <div className="max-h-[62vh] space-y-1.5 overflow-y-auto rounded-md border p-2">
                            {loading && (
                                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                                    {t.common?.loading || 'Loading…'}
                                </p>
                            )}
                            {!loading && visible.length === 0 && (
                                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                                    {L('没有符合条件的条目。点右上角「新建一条」开始。', 'Nothing here — press New to start.')}
                                </p>
                            )}
                            {visible.map((r) => {
                                const active = r.id === currentId;
                                const preview = cleanMarkdown((r.content || '').split('\n')[0] || '');
                                return (
                                    <button
                                        key={r.id}
                                        type="button"
                                        onClick={() => selectRow(r.id)}
                                        className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors ${
                                            active ? 'border-primary bg-accent/60' : 'hover:bg-accent/30'
                                        }`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="font-mono text-xs font-semibold">{r.code}</span>
                                            {r.errorItemNo && (
                                                <Badge variant="outline" className="px-1 py-0 text-[10px]">
                                                    {L('题', 'Q')} {r.errorItemNo}
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                            <span>{r.gradeSemester || L('未设年级', 'no grade')}</span>
                                            <span>·</span>
                                            <span>{subjectLabel(r.subject)}</span>
                                        </div>
                                        {preview && (
                                            <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                                                {preview}
                                            </div>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </aside>

                    {/* ===== 右栏：编辑区 ===== */}
                    <section className="min-w-0">
                        {!current ? (
                            <div className="rounded-md border border-dashed px-6 py-16 text-center text-sm text-muted-foreground">
                                {L('左边选一条，或者右上角新建一条。', 'Pick one on the left, or create a new entry.')}
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {/* ① 年级/学期 + 学科（10 个按钮：9 科 + 其他） */}
                                <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm text-muted-foreground">
                                            {L('年级/学期', 'Grade')}:
                                        </span>
                                        <Select
                                            value={gradeDraft || '__none__'}
                                            onValueChange={(v) => setGradeDraft(v === '__none__' ? '' : v)}
                                        >
                                            <SelectTrigger className="h-8 w-[150px]">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="__none__">
                                                    {t.common?.notSet || 'Not set'}
                                                </SelectItem>
                                                {GRADE_SEMESTER_OPTIONS.map((g) => (
                                                    <SelectItem key={g} value={g}>
                                                        {g}
                                                    </SelectItem>
                                                ))}
                                                {gradeDraft && !GRADE_SEMESTER_OPTIONS.includes(gradeDraft) && (
                                                    <SelectItem value={gradeDraft}>{gradeDraft}（原值）</SelectItem>
                                                )}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <div className="flex flex-wrap gap-1.5">
                                        {SUBJECT_OPTIONS.map((s) => (
                                            <Button
                                                key={s.key}
                                                type="button"
                                                size="sm"
                                                variant={subjectDraft === s.key ? 'secondary' : 'outline'}
                                                className={`h-7 px-2 text-xs ${subjectDraft === s.key ? 'bg-zinc-300 text-zinc-900 hover:bg-zinc-300/90' : ''}`}
                                                onClick={() => setSubjectDraft(subjectDraft === s.key ? '' : s.key)}
                                            >
                                                {s.label}
                                            </Button>
                                        ))}
                                    </div>
                                </div>

                                {/* ② md 编辑框（比错题详情页那个再大一点） */}
                                <MdEditor
                                    value={content}
                                    onChange={setContent}
                                    placeholder={L('这条积累写在这里…', 'Write the takeaway here…')}
                                    minHeightPx={320}
                                    dirty={dirty}
                                />

                                {/* ③ 拍照 + 删除 */}
                                <div className="flex flex-wrap items-center gap-3">
                                    <input
                                        ref={fileRef}
                                        type="file"
                                        accept="image/*"
                                        capture="environment"
                                        className="hidden"
                                        onChange={(e) => {
                                            onPickPhoto(e.target.files?.[0]);
                                            e.target.value = '';
                                        }}
                                    />
                                    <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                                        <Camera className="mr-1.5 h-4 w-4" />
                                        {L('拍照', 'Photo')}
                                    </Button>

                                    {photo && (
                                        <span className="flex items-center gap-2">
                                            {/* eslint-disable-next-line @next/next/no-img-element -- 存的是 dataURL，next/image 用不上 */}
                                            <img src={photo} alt="" className="h-14 w-14 rounded border object-cover" />
                                            <button
                                                type="button"
                                                className="text-xs text-muted-foreground hover:text-destructive"
                                                onClick={() => setPhoto(null)}
                                            >
                                                {L('去掉这张图', 'Remove photo')}
                                            </button>
                                        </span>
                                    )}

                                    <span className="flex-1" />

                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-muted-foreground hover:text-destructive"
                                        onClick={remove}
                                    >
                                        <Trash2 className="mr-1.5 h-4 w-4" />
                                        {L('删除', 'Delete')}
                                    </Button>
                                </div>

                                {/* ③' 相关错题的**错题卡** —— 与错题本页同一份组件。
                                    ⚠️ 故意**不给 onTrash**（共享卡片因此不出垃圾桶）：
                                    在积累页点"删错题"人会发懵；轻操作照常，删除回错题本页做。 */}
                                <div>
                                    <div className="mb-2 text-sm font-medium">
                                        {L('相关错题', 'Linked question')}
                                        {current.errorItemNo && (
                                            <span className="ml-2 font-mono text-xs text-muted-foreground">
                                                {current.errorItemNo}
                                            </span>
                                        )}
                                    </div>
                                    {linkedQuestion ? (
                                        <div className="max-w-[520px]">
                                            <ErrorItemCard item={linkedQuestion} />
                                        </div>
                                    ) : (
                                        <div className="rounded-md border border-dashed px-4 py-5 text-sm text-muted-foreground">
                                            {current.errorItemNo
                                                ? L(
                                                      `按题号 ${current.errorItemNo} 没找到活题（可能已彻底删除）`,
                                                      `Question ${current.errorItemNo} not found`,
                                                  )
                                                : L('这条积累还没有关联错题。', 'No linked question yet.')}
                                        </div>
                                    )}
                                </div>

                                {/* 保存 / 取消（有改动才出现 —— 全项目统一手感） */}
                                {dirty && (
                                    <div className="flex gap-2">
                                        <Button size="sm" onClick={save} disabled={saving}>
                                            <Save className="mr-1 h-4 w-4" />
                                            {t.common?.save || 'Save'}
                                        </Button>
                                        <Button size="sm" variant="outline" onClick={discard}>
                                            <X className="mr-1 h-4 w-4" />
                                            {t.common?.cancel || 'Cancel'}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </main>
    );
}
