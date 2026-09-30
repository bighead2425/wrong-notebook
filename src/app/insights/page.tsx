"use client";

/**
 * 【2026-10-01 新增】**日积月累页**（`/insights`）。
 *
 * 他定的结构（原话拆解）：
 *   · 两层构成：第一层是**录入与浏览**（左右两栏）；
 *   · 左栏 = 已有的全部条目，每条按 `JLyyyymmddxxx` 编号（yyyymmdd 日期 + 当日流水 001 起）；
 *   · 右栏 = 条目的编辑区，从上到下：
 *       ① 左边「年级/学期」选择框，右边 **9 大学科 + 其他** 共 10 个按钮；
 *       ② 一个能编辑 md 的大编辑框（比错题详情页那个再大一点）；
 *       ③ 一个**拍照**按钮（调终端摄像头），右边一个**方形按钮**：
 *          若这条积累与某道错题有关联 ⇒ 按钮上显示**二维码**（可被终端扫到），
 *          点它进入那道题的错题卡/详情页。
 *
 * ── 三处刻意的取舍 ───────────────────────────────────────────────
 *  ① **编号由服务端发**（`JL` + 日期 + 当日流水）：多设备同时建也不会撞号。
 *     但**日期段由本页算好传上去** —— 容器跑在 UTC，服务端自己分"天"会把半夜录的
 *     条目记到前一天（全项目的时区铁律，见 `calendar-grid.ts`）。
 *  ② **配图存 data URL**（与 `ErrorItem.originalImageUrl` 同一套存法），
 *     不新建上传接口、不新增 NAS 目录 —— 少一个"谁能往哪写"的口子。
 *     压缩走现成的 `processImageFile`（>1MB 自动降到 1MB 以内）。
 *  ③ **改动即存**（有改动才出现保存/取消）—— 全项目统一的手感。
 *     切到另一条之前会先看你有没有未保存的改动，有就问一句，不静默丢。
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
import { makeQrDataUrl } from '@/lib/qr';
import { Camera, House, Plus, QrCode, Save, Search, Trash2, X } from 'lucide-react';

interface InsightRow {
    id: string;
    code: string;
    dateKey: string;
    seq: number;
    gradeSemester: string | null;
    subject: string | null;
    content: string | null;
    photoUrl: string | null;
    errorItemId: string | null;
    errorItem?: { id: string; source: string | null; questionText: string | null } | null;
    createdAt: string;
}

export default function InsightsPage() {
    const { t, language } = useLanguage();
    const L = (zh: string, en: string) => (language === 'zh' ? zh : en);

    const [rows, setRows] = useState<InsightRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');

    const [currentId, setCurrentId] = useState<string | null>(null);
    const current = useMemo(() => rows.find((r) => r.id === currentId) ?? null, [rows, currentId]);

    // 编辑区状态（与"当前条目"解耦：改完点保存才回写列表）
    const [grade, setGrade] = useState('');
    const [subject, setSubject] = useState('');
    const [content, setContent] = useState('');
    const [photoUrl, setPhotoUrl] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [qrUrl, setQrUrl] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement | null>(null);

    const dirty =
        !!current &&
        (grade !== (current.gradeSemester ?? '') ||
            subject !== (current.subject ?? '') ||
            content !== (current.content ?? '') ||
            photoUrl !== (current.photoUrl ?? null));

    const fetchList = useCallback(async () => {
        setLoading(true);
        try {
            const res = await apiClient.get<{ insights: InsightRow[] }>('/api/insights');
            setRows(res.insights || []);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchList();
    }, [fetchList]);

    /** 把选中条目装进编辑区 */
    useEffect(() => {
        if (!current) return;
        setGrade(current.gradeSemester ?? '');
        setSubject(current.subject ?? '');
        setContent(current.content ?? '');
        setPhotoUrl(current.photoUrl ?? null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [current?.id]);

    /** 关联错题的二维码：内容 = **裸题号**（与纸上、扫码页同一个约定，见 lib/qr.ts） */
    useEffect(() => {
        let alive = true;
        const src = current?.errorItem?.source;
        if (!src) {
            setQrUrl(null);
            return;
        }
        // 二维码内容 = **裸题号**（与纸上、扫码页同一个约定，见 lib/qr.ts）
        makeQrDataUrl(src, { width: 160 })
            .then((url) => {
                if (alive) setQrUrl(url);
            })
            .catch(() => {
                if (alive) setQrUrl(null);
            });
        return () => {
            alive = false;
        };
    }, [current?.id, current?.errorItem?.source]);

    /** 新建：编号由服务端发（日期段用**本地日期**） */
    const createOne = async () => {
        try {
            const created = await apiClient.post<InsightRow>('/api/insights', {
                dateKey: dayKey(new Date()),
                gradeSemester: grade || null,
                subject: subject || null,
                content: '',
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
                gradeSemester: grade || null,
                subject: subject || null,
                content,
                photoUrl,
            });
            setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.saveFailed || 'Save failed');
        } finally {
            setSaving(false);
        }
    };

    const discard = () => {
        if (!current) return;
        setGrade(current.gradeSemester ?? '');
        setSubject(current.subject ?? '');
        setContent(current.content ?? '');
        setPhotoUrl(current.photoUrl ?? null);
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

    /** 拍照：就地压缩成 data URL（不新增上传接口，见文件头 ②） */
    const onPickPhoto = async (file: File | undefined) => {
        if (!file) return;
        try {
            const dataUrl = await processImageFile(file);
            setPhotoUrl(dataUrl);
        } catch (error) {
            console.error(error);
            alert(L('这张图读不出来，换一张试试', 'Could not read that image'));
        }
    };

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return rows;
        return rows.filter(
            (r) =>
                r.code.toLowerCase().includes(q) ||
                (r.content || '').toLowerCase().includes(q),
        );
    }, [rows, query]);

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
                    <Link href="/">
                        <Button variant="ghost" size="icon" title={L('返回主页', 'Home')}>
                            <House className="h-5 w-5" />
                        </Button>
                    </Link>
                </div>
            </div>

            <div className="mx-auto w-full max-w-[1400px] px-4 py-4 md:px-8">
                <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
                    {/* ===== 左栏：条目清单 ===== */}
                    <aside className="space-y-2">
                        <div className="relative">
                            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                            <Input
                                className="h-9 pl-7 text-sm"
                                placeholder={L('搜编号或内容…', 'Search code or text…')}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                            />
                        </div>

                        <div className="max-h-[70vh] space-y-1.5 overflow-y-auto rounded-md border p-2">
                            {loading && (
                                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                                    {t.common?.loading || 'Loading…'}
                                </p>
                            )}
                            {!loading && visible.length === 0 && (
                                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                                    {L('还没有条目。点右上角「新建一条」开始。', 'Nothing yet — press New to start.')}
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
                                            {r.errorItem?.source && (
                                                <Badge variant="outline" className="px-1 py-0 text-[10px]">
                                                    {L('题', 'Q')} {r.errorItem.source}
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
                                            value={grade || '__none__'}
                                            onValueChange={(v) => setGrade(v === '__none__' ? '' : v)}
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
                                                {/* 旧值不在清单里也留着（与错题详情页同一条规矩） */}
                                                {grade && !GRADE_SEMESTER_OPTIONS.includes(grade) && (
                                                    <SelectItem value={grade}>{grade}（原值）</SelectItem>
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
                                                variant={subject === s.key ? 'secondary' : 'outline'}
                                                className={`h-7 px-2 text-xs ${subject === s.key ? 'bg-zinc-300 text-zinc-900 hover:bg-zinc-300/90' : ''}`}
                                                onClick={() => setSubject(subject === s.key ? '' : s.key)}
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

                                {/* ③ 拍照 + 关联错题的二维码按钮 */}
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

                                    {photoUrl && (
                                        <span className="flex items-center gap-2">
                                            {/* eslint-disable-next-line @next/next/no-img-element -- 存的是 dataURL，next/image 用不上 */}
                                            <img
                                                src={photoUrl}
                                                alt=""
                                                className="h-14 w-14 rounded border object-cover"
                                            />
                                            <button
                                                type="button"
                                                className="text-xs text-muted-foreground hover:text-destructive"
                                                onClick={() => setPhotoUrl(null)}
                                            >
                                                {L('去掉这张图', 'Remove photo')}
                                            </button>
                                        </span>
                                    )}

                                    {/* 方形按钮：有关联错题 ⇒ 显示二维码（可被终端扫到），点它去那道题 */}
                                    {current.errorItem?.source ? (
                                        <Link
                                            href={`/error-items/${current.errorItem.id}`}
                                            title={L(
                                                `关联的错题：${current.errorItem.source}（二维码内容就是题号，终端可直接扫）`,
                                                `Linked question ${current.errorItem.source}`,
                                            )}
                                            className="flex h-[54px] w-[54px] shrink-0 items-center justify-center rounded-md border bg-white p-1 hover:border-primary"
                                        >
                                            {qrUrl ? (
                                                /* eslint-disable-next-line @next/next/no-img-element -- 同上：dataURL */
                                                <img src={qrUrl} alt="" className="h-full w-full" />
                                            ) : (
                                                <QrCode className="h-5 w-5 text-muted-foreground" />
                                            )}
                                        </Link>
                                    ) : (
                                        <span
                                            className="flex h-[54px] w-[54px] shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground"
                                            title={L(
                                                '这条积累还没有关联错题（将来自动从深挖纸回录里生成）',
                                                'No linked question yet',
                                            )}
                                        >
                                            <QrCode className="h-5 w-5 opacity-40" />
                                        </span>
                                    )}

                                    {current.errorItem?.source && (
                                        <span className="text-xs text-muted-foreground">
                                            {L('关联题号', 'Question')}:{' '}
                                            <span className="font-mono">{current.errorItem.source}</span>
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
