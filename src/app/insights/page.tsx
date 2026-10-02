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
 *
 * ── 【2026-10-02 他提的两件事】───────────────────────────────────────
 *  ① 「拍照」按钮 ⇒ 「图片」：接**主页那套**拍照/选图链路（DocScanner 拍摄/相册 →
 *     四角景深 + 原色/漂白/黑白 + 重拍/用原图 ⇒ ImageCropper 剪裁/橡皮擦/旋转/拉伸/
 *     平移/原图/取消/确认），成品只交给**当前这一条**（不送 AI、不送预处理）。
 *  ② 错题卡与**扫码页对齐**：`href={null}` 整卡不可点（防手机误触）、左上掌握度互换、
 *     右上等级循环、右下类型循环、左下打印深挖页（都即点即存）；卡下加「打开详情页」；
 *     卡上无删除按钮、卡下无复习结果栏（日积月累是积累，不是复习）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { getSubjectHex } from '@/lib/subject-colors';
import { cleanMarkdown } from '@/lib/markdown-utils';
import { dayKey } from '@/lib/calendar-grid';
import { ErrorItemCard } from '@/components/error-item-card';
import { DocScanner, type DocScannerHandle } from '@/components/doc-scanner';
import { ImageCropper } from '@/components/image-cropper';
import { ImageZoomViewer } from '@/components/image-zoom-viewer';
import { cycleAttentionLevel } from '@/lib/attention-level';
import { cycleManageType } from '@/lib/manage-type';
import type { ErrorItem } from '@/types/api';
import {
    ExternalLink,
    House,
    Image as ImageIcon,
    Layers,
    PanelLeftClose,
    PanelLeftOpen,
    Plus,
    Printer,
    Save,
    Search,
    Trash2,
    X,
} from 'lucide-react';

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

/**
 * 【2026-10-03 他要求】新建条目时**默认沿用上一次用的年级/学期**。
 * 原话："新建一条积累条目，年级/学期默认选为上次新建时的年级学期，这样就减少一次输入了。"
 *
 * ⚠️ 为什么用 `localStorage` 而不是"参考右栏当前值"：右栏的值会**跟着你看的那条走** ——
 *    你要是先翻了一条三年级的，再点新建，就会默认成三年级，那正是他要避免的。
 *    这里只记"**上次新建/保存时**用的那个"，与你在看哪条无关。
 * 取不到（隐私模式、清了缓存、第一次用）就当空，绝不报错。
 */
const LAST_GRADE_KEY = 'insight:lastGradeSemester';

function readLastGrade(): string {
    try {
        return window.localStorage.getItem(LAST_GRADE_KEY) || '';
    } catch {
        return '';
    }
}

function rememberGrade(value: string) {
    try {
        window.localStorage.setItem(LAST_GRADE_KEY, value);
    } catch {
        /* 隐私模式 / 禁用存储：忽略，不影响主流程 */
    }
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
    /**
     * 【2026-10-01 加】左栏（清单 + 筛选）**可隐藏**。
     * 他原话："对电脑端没有什么意义，但对手机这个功能是很有价值的 ——
     * 在手机里左右两栏会变成上下关系，左边内容多了以后……翻半天也翻不到后面。"
     * ⇒ 手机上是单列堆叠，隐藏左栏就直接落在编辑区；宽屏时右栏自动占满。
     */
    const [leftOpen, setLeftOpen] = useState(true);

    /**
     * 【2026-10-01 按他定的分工加】**勾选若干条 → 送入积累纸打印**。
     *
     * 他原话："让哪些日积月累组成积累纸就在**这个页面**决定；
     * 送到积累纸打印后，用那个页面管理生成过哪些积累纸。"
     * ⇒ 挑的活在这儿，"排成纸"的活在那边，两边不再互相越界。
     *
     * ⚠️ 这里**只发 id 过去**，不在这儿建卷 —— 建卷必须先量出每条的真实高度再分栏分页，
     *    而那套能力在打印页（要靠真正的 DOM 渲染）。详见打印页 `NewVolume` 的说明。
     */
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const router = useRouter();

    const togglePick = (id: string) =>
        setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const sendToPrint = () => {
        if (picked.size === 0) return;
        // 按**左栏当前顺序**送过去（他挑的时候看到的就是这个顺序）
        const ordered = visible.map((r) => r.id).filter((id) => picked.has(id));
        router.push(`/insights/print?new=${ordered.join(',')}`);
    };
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

    /**
     * 【2026-10-02 他要求】「拍照」⇒「图片」：接入**主页那套**拍照/选图链路。
     *
     * 原来这里是 `<input type="file" capture="environment">`，点到就拿原图 —— 没有四角景深、
     * 没有原色/漂白/黑白、没有剪裁。他要的是"我们有比较成熟的一套拍照、美化功能了，
     * 在这里可以直接调用功能，无非是加工完成后的图片送到哪里去的问题罢了"。
     * 于是**复用两个既有组件**串成一条链，不另写一套：
     *   ① DocScanner（`src/components/doc-scanner.tsx`，主页"拍照扫描"用的同一个）：
     *      拍摄 / 相册 → 四角景深、原色/漂白/黑白、重拍、用原图；
     *   ② ImageCropper（`src/components/image-cropper.tsx`，主页与错题本"添加"用的同一个）：
     *      剪裁 / 橡皮擦 / 旋转 / 拉伸 / 平移 / 原图 / 取消 / 确认；
     *   ③ 剪裁页点「确认」⇒ 成品图**只交给当前这一条日积月累**（`onPickPhoto`：
     *      压缩成 data URL 存草稿，保存时才进图片表）。
     *
     * ⚠️ 全程不送 AI、不进「预处理」栏 —— 这正是他说的"无非是加工完成后的图片送到哪里去"。
     */
    const scannerRef = useRef<DocScannerHandle | null>(null);
    /** DocScanner 交出的成品（object URL），交给 ImageCropper 继续加工 */
    const [croppingImage, setCroppingImage] = useState<string | null>(null);
    const [isCropperOpen, setIsCropperOpen] = useState(false);

    /**
     * 【2026-10-03 他要求】右栏那张配图**点开可放大阅览**（滚轮/双指缩放、拖动平移）。
     * 只是开一个覆盖全屏的浮层，**不动任何草稿状态** —— 他可能正改着这条，
     * 关掉浮层后编辑框里的内容、光标、未保存改动都还在原地。
     * 阅览组件复用"图片录入"那条链路上的看图手感，详见 `ImageZoomViewer` 的文件头。
     */
    const [isViewerOpen, setIsViewerOpen] = useState(false);

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
        // 默认沿用上次用的年级/学期（见 LAST_GRADE_KEY 的说明）；没有就空着
        const inheritGrade = readLastGrade();
        try {
            const created = await apiClient.post<InsightRow>('/api/insights', {
                dateKey: dayKey(new Date()),
                gradeSemester: inheritGrade || null,
                subject: subjectDraft || null,
                content: '',
                source: 'page',
            });
            setRows((prev) => [created, ...prev]);
            // 右栏也切到继承值：否则界面上显示空、库里却有值，他一看就以为没生效
            setGradeDraft(inheritGrade);
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

    /**
     * 【2026-10-01 加】从**错题详情页**的「去日积月累页看全文 / 配图」跳过来时会带 `?pick=JL…`
     * ⇒ 到了这里要**直接选中那一条**（他原话："并没有显示出这道题关联的日积月累内容。
     * 这个关联还不紧密"）。清单加载完再比对编号，选中后也只选一次（`pickedRef`）。
     *
     * ⚠️ 用 `window.location.search` 而**不是** `useSearchParams`：后者会把页面拖进
     *    Suspense 边界（本项目 2026-10-01 正因漏包 Suspense 炸过构建，
     *    见 `next-build-conventions.test.ts`）。这里只需"挂载后读一次"，
     *    不需要响应 URL 变化 —— 正是 `window.location` 的适用场景（`/scan`、`/review-volumes` 同）。
     */
    const pickedRef = useRef(false);
    useEffect(() => {
        if (pickedRef.current || rows.length === 0) return;
        pickedRef.current = true;
        const pick = new URLSearchParams(window.location.search).get('pick');
        if (!pick) return;
        const hit = rows.find((r) => r.code === pick || r.id === pick);
        if (hit) setCurrentId(hit.id);
    }, [rows]);

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
            // 记住这次用的年级/学期，供下一次"新建"默认（他要求的"减少一次输入"）
            rememberGrade(gradeDraft);
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

    /**
     * 成品图落地：就地压缩成 data URL（本次会话先存草稿，保存时才进图片表）。
     * 返回是否成功 —— 剪裁页据此决定**关不关**（失败要留在原地让人重试，不静默丢编辑成果）。
     */
    const onPickPhoto = async (file: File | undefined): Promise<boolean> => {
        if (!file) return false;
        try {
            const dataUrl = await processImageFile(file);
            setPhoto(dataUrl);
            return true;
        } catch (error) {
            console.error(error);
            alert(L('这张图读不出来，换一张试试', 'Could not read that image'));
            return false;
        }
    };

    /** DocScanner 拍摄/选图完成 ⇒ 把成品交给剪裁页（而不是像主页那样送 AI） */
    const handleScanComplete = (blob: Blob) => {
        const url = URL.createObjectURL(blob);
        setCroppingImage(url);
        setIsCropperOpen(true);
    };

    /**
     * 剪裁页「确认」⇒ 成品进**当前这一条**。
     * 只有真正读进 `photo` 才关剪裁页 —— 失败时画布与编辑状态原地保留，可直接再点一次「确认」。
     */
    const handleCropComplete = async (blob: Blob) => {
        const file = new File([blob], 'insight.jpg', { type: 'image/jpeg' });
        const ok = await onPickPhoto(file);
        if (ok) setIsCropperOpen(false);
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

    /**
     * 错题卡上的"即点即存"：乐观更新 → 发请求 → 失败弹提示并**拉回真实数据**。
     * 与扫码页 `ScanItemPanel`（`src/components/scan-item-panel.tsx`）同一条规矩 ——
     * 失败绝不静默。
     *
     * ⚠️ 这里改的是**那道错题**（ErrorItem：掌握度 / 等级 / 类型），不是日积月累条目本身。
     *    他原话："点击错题卡左上角的待复习或已掌握，两者可以互换并保存到数据库"。
     *    条目自己的字段（年级 / 学科 / 正文 / 图）仍走上面的 `save()`。
     */
    const patchQuestion = async (
        body: Record<string, unknown>,
        optimistic: Partial<ErrorItem>,
    ) => {
        const no = current?.errorItemNo;
        const prev = no ? questions[no] : undefined;
        if (!no || !prev) return;
        setQuestions((q) => ({ ...q, [no]: { ...prev, ...optimistic } }));
        try {
            await apiClient.put(`/api/error-items/${prev.id}`, body);
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.updateFailed || 'Update failed');
            // 回滚：点之前那一份原样放回去，画面不留假象
            setQuestions((q) => ({ ...q, [no]: prev }));
        }
    };

    /** 进错题详情页时带上"从哪来" ⇒ 详情页返回键回到**这一条**（与原卡片那条链接等义） */
    const questionDetailHref =
        current && linkedQuestion
            ? `/error-items/${linkedQuestion.id}?back=${encodeURIComponent(
                  `/insights?pick=${current.code}`,
              )}`
            : null;

    /** 拍照链路的 object URL 用完即回收（换一张 / 卸载时）—— 与主页同一处理 */
    useEffect(() => {
        return () => {
            if (croppingImage) URL.revokeObjectURL(croppingImage);
        };
    }, [croppingImage]);

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
                    {/* 【2026-10-01 加】隐藏 / 显示左栏（手机上价值最大 —— 见 leftOpen 的说明） */}
                    <Button
                        variant="outline"
                        size="icon"
                        title={
                            leftOpen
                                ? L('隐藏左栏（手机上看编辑区更省事）', 'Hide the list')
                                : L('显示左栏', 'Show the list')
                        }
                        onClick={() => setLeftOpen((v) => !v)}
                    >
                        {leftOpen ? (
                            <PanelLeftClose className="h-4 w-4" />
                        ) : (
                            <PanelLeftOpen className="h-4 w-4" />
                        )}
                    </Button>
                    {/* 【2026-10-02 他要求】窄屏/手机上**只留图标**（文字藏起来）——
                        "当浏览器变窄，或者在手机端屏幕比较窄的时候，右上角的新建一条按钮，
                        文字隐藏，只留前面的加号既可"。打印按钮同样处理。 */}
                    <Button size="sm" onClick={createOne} title={L('新建一条', 'New')}>
                        <Plus className="h-4 w-4 sm:mr-1.5" />
                        <span className="hidden sm:inline">{L('新建一条', 'New')}</span>
                    </Button>
                    {/* 【2026-10-01 第三轮】**打印另开一屏**（他担心的对）：
                        编辑与打印是两种状态（未保存的改动、量高、分页、页码），
                        硬塞进同一个右栏久了必然互相打架。 */}
                    <Link href="/insights/print">
                        <Button variant="outline" size="sm" title={L('把挑出来的条目排成积累纸印出来', 'Print picked entries on takeaway sheets')}>
                            <Printer className="h-4 w-4 sm:mr-1.5" />
                            <span className="hidden sm:inline">{L('打印', 'Print')}</span>
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
                {/* 藏起左栏时**不留空列**（`lg:grid-cols-[1fr]`）⇒ 右栏自然占满 */}
                <div className={`grid gap-4 ${leftOpen ? 'lg:grid-cols-[360px_1fr]' : 'lg:grid-cols-[1fr]'}`}>
                    {/* ===== 左栏：筛选 + 条目清单（**可隐藏**，见 leftOpen） ===== */}
                    {leftOpen && (
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

                        {/* 【2026-10-01】勾选工具条：**勾完了才出现**（平时不占地方）。
                            "哪几条印在一张纸上"在这儿决定；点【送入】就去打印页排纸。 */}
                        {picked.size > 0 && (
                            <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-accent/50 px-2 py-1.5 text-xs">
                                <span className="font-medium">
                                    {L(`已勾 ${picked.size} 条`, `${picked.size} picked`)}
                                </span>
                                <span className="flex-1" />
                                <button
                                    type="button"
                                    className="underline"
                                    onClick={() =>
                                        setPicked((prev) =>
                                            prev.size === visible.length
                                                ? new Set()
                                                : new Set(visible.map((r) => r.id)),
                                        )
                                    }
                                >
                                    {picked.size === visible.length
                                        ? L('全不选', 'None')
                                        : L('全选', 'All')}
                                </button>
                                <button
                                    type="button"
                                    className="underline"
                                    onClick={() => setPicked(new Set())}
                                >
                                    {L('清空', 'Clear')}
                                </button>
                                <Button size="sm" className="h-7" onClick={sendToPrint}>
                                    <Layers className="mr-1 h-3.5 w-3.5" />
                                    {L('送入积累纸打印', 'Send to print')}
                                </Button>
                            </div>
                        )}

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
                                const checked = picked.has(r.id);
                                return (
                                    <div
                                        key={r.id}
                                        className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-2 transition-colors ${
                                            active ? 'border-primary bg-accent/60' : 'hover:bg-accent/30'
                                        }`}
                                    >
                                        {/* 【2026-10-01】勾选（送去排积累纸用）。
                                            ⚠️ checkbox 放在 button **外面** —— "勾选"和"点开编辑"
                                            是两个互不相干的动作，嵌套在一起会互相打架。 */}
                                        <input
                                            type="checkbox"
                                            className="mt-0.5 shrink-0"
                                            checked={checked}
                                            onChange={() => togglePick(r.id)}
                                            title={L('勾上，之后可以送去排积累纸', 'Pick to print later')}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => selectRow(r.id)}
                                            className="min-w-0 flex-1 text-left"
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
                                    </div>
                                );
                            })}
                        </div>
                    </aside>
                    )}

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

                                    <div className="flex items-center gap-2">
                                        <span className="text-sm text-muted-foreground">
                                            {L('学科', 'Subject')}:
                                        </span>
                                        {/*
                                         * 【2026-10-01 他要求】10 个按钮 ⇒ **收进一个下拉菜单**：
                                         *   · 菜单里的科目**各自用本科目的颜色**（取自
                                         *     `lib/subject-colors.ts` —— 与深挖纸/复练纸左上角那个
                                         *     科目标识同一份，5.4/5.6 定稿"勿擅自调色"）；
                                         *   · **选中后菜单收起来，触发器上直接显示那个科目名**，同色；
                                         *   · 好处正是他说的："不同科目用不同科目的颜色标识出来"。
                                         */}
                                        <Select
                                            value={subjectDraft || '__none__'}
                                            onValueChange={(v) => setSubjectDraft(v === '__none__' ? '' : v)}
                                        >
                                            <SelectTrigger
                                                className="h-8 w-[120px] font-medium"
                                                style={
                                                    subjectDraft
                                                        ? { color: getSubjectHex(subjectDraft) }
                                                        : undefined
                                                }
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="__none__">
                                                    {t.common?.notSet || 'Not set'}
                                                </SelectItem>
                                                {SUBJECT_OPTIONS.map((s) => (
                                                    <SelectItem key={s.key} value={s.key}>
                                                        <span style={{ color: getSubjectHex(s.key) }}>
                                                            {s.label}
                                                        </span>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>

                                {/* ② 保存 / 取消 —— 【2026-10-01 上移】。
                                    他原话："这个保存和取消的按钮实在是太靠下面了，建议调整到上面去。"
                                    放在编辑框**上方**：改完内容一抬眼就在手边，不用滚到最底下。 */}
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

                                {/* ③ md 编辑框 —— 【2026-10-01 改小】只留 **3 行**起步，写长了它自己变高。
                                    他原话："目前太宽了，预留三行就行了；如果内容多了起来，
                                    则结合行数调整框的宽度。日积月累每一条都不应该有太长的内容。" */}
                                <MdEditor
                                    value={content}
                                    onChange={setContent}
                                    placeholder={L('这条积累写在这里…', 'Write the takeaway here…')}
                                    minHeightPx={110}
                                    dirty={dirty}
                                />

                                {/* ④ 图片（左）+ 图片 / 删除（右）—— 【2026-10-01 重排】。
                                    他原话："拍照按钮往右放，靠近右边的删除，这样能空余出一部分空间，
                                    下面放图片，然后再接相关错题卡，如果没有图片的话就直接连错题卡，
                                    这样会比较紧凑。"
                                    ⇒ 图片占左边（原来是拍照按钮占着的位置），图片按钮与删除一起靠右；
                                      没图时这一行只有右边两个按钮，错题卡就紧跟着顶上来。

                                    【2026-10-02 他要求】原「拍照」按钮（直取原图）换成「图片」：
                                    点它调起**主页那套**拍照/扫描链路（见 scannerRef 的说明），
                                    加工完的成品仍回到这一条（不送 AI、不送预处理）。 */}
                                <div className="flex flex-wrap items-center gap-3">
                                    {photo && (
                                        <span className="flex items-center gap-2">
                                            {/* 【2026-10-03 他要求】点这张缩略图 ⇒ 打开放大阅览
                                                （滚轮/双指缩放、拖动平移；见 ImageZoomViewer）。
                                                缩略图本身 `cursor-zoom-in` 明示"能点开"。 */}
                                            <button
                                                type="button"
                                                onClick={() => setIsViewerOpen(true)}
                                                className="shrink-0 cursor-zoom-in"
                                                title={L('点开放大阅览', 'Click to enlarge')}
                                                aria-label={L('放大阅览这张图', 'Enlarge this photo')}
                                            >
                                                {/* eslint-disable-next-line @next/next/no-img-element -- 存的是 dataURL，next/image 用不上 */}
                                                <img
                                                    src={photo}
                                                    alt=""
                                                    className="h-20 w-20 rounded border object-cover"
                                                />
                                            </button>
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
                                        variant="outline"
                                        size="sm"
                                        onClick={() => scannerRef.current?.openCamera()}
                                        title={L(
                                            '拍摄或从相册选图，可调四角、选原色/漂白/黑白，再进剪裁页',
                                            'Shoot or pick from album, adjust corners & enhance, then crop',
                                        )}
                                    >
                                        <ImageIcon className="mr-1.5 h-4 w-4" />
                                        {L('图片', 'Image')}
                                    </Button>
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
                                            {/*
                                             * 【2026-10-02 他要求】错题卡与**扫码页对齐**（照
                                             * `src/components/scan-item-panel.tsx` 的做法），四点：
                                             *  ① `href={null}` ⇒ **整卡不再当跳转热区**：他原话
                                             *     "点击错题卡不转到这道题详情页，为手机防止误操作提供空间"，
                                             *     进详情页改走下面那个按钮（一次意图一个动作）。
                                             *  ② 左上掌握度互换、右上等级循环、右下类型循环、左下打印深挖页，
                                             *     全部"即点即存"（`patchQuestion` 乐观更新 + 失败回滚）。
                                             *  ③ **不给 onTrash** —— 日积月累不删题（他原话"不同在于错题卡上
                                             *     没有删除按钮"），共享卡片因此不出垃圾桶。
                                             *  ④ **卡下不加复习结果栏** —— 日积月累是积累不是复习
                                             *     （他原话"错题卡下面没有复习结果栏"）。
                                             */}
                                            <ErrorItemCard
                                                item={linkedQuestion}
                                                href={null}
                                                onToggleMastery={() =>
                                                    patchQuestion(
                                                        {
                                                            masteryLevel:
                                                                linkedQuestion.masteryLevel > 0 ? 0 : 2,
                                                        },
                                                        {
                                                            masteryLevel:
                                                                linkedQuestion.masteryLevel > 0 ? 0 : 2,
                                                        },
                                                    )
                                                }
                                                onCycleAttention={() => {
                                                    const next = cycleAttentionLevel(
                                                        linkedQuestion.attention,
                                                    );
                                                    patchQuestion(
                                                        { attention: next },
                                                        { attention: next },
                                                    );
                                                }}
                                                onCycleManageType={() => {
                                                    const next = cycleManageType(
                                                        linkedQuestion.manageType,
                                                    );
                                                    patchQuestion(
                                                        { manageType: next },
                                                        { manageType: next },
                                                    );
                                                }}
                                                onDeepDivePrint={() => {
                                                    router.push(
                                                        `/print-preview?ids=${linkedQuestion.id}&mode=deep`,
                                                    );
                                                }}
                                            />
                                            {/* 整卡不可点了 ⇒ 进详情页只留这一个明确的按钮（与扫码页同款）。
                                                带上"从哪来" ⇒ 详情页返回键回到**这一条**
                                                （他原话："返回的是这个日积月累的页面…回来还得是这一条"）。 */}
                                            {questionDetailHref && (
                                                <div className="mt-2">
                                                    <Link href={questionDetailHref}>
                                                        <Button variant="outline" size="sm">
                                                            <ExternalLink className="mr-1.5 h-4 w-4" />
                                                            {L('打开详情页', 'Open details')}
                                                        </Button>
                                                    </Link>
                                                </div>
                                            )}
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

                            </div>
                        )}
                    </section>
                </div>
            </div>

            {/*
             * 【2026-10-02 他要求】拍照/选图链路 —— **主页那套既有组件**，这里只是换个"图的下一站"：
             *   ① DocScanner：拍摄 / 相册 → 四角景深、原色/漂白/黑白、重拍、用原图；
             *   ② ImageCropper：剪裁 / 橡皮擦 / 旋转 / 拉伸 / 平移 / 原图 / 取消 / 确认。
             * 两个都是 fixed 全屏浮层（z 高、盖在最上层），挂在这儿即可，不占页面布局。
             * ⚠️ 与主页唯一的差别：成品**不送 AI**，`handleCropComplete` 直接交给当前这一条。
             */}
            <DocScanner
                ref={scannerRef}
                onScanComplete={handleScanComplete}
                onClose={() => {}}
            />
            {croppingImage && (
                <ImageCropper
                    imageSrc={croppingImage}
                    open={isCropperOpen}
                    onClose={() => setIsCropperOpen(false)}
                    onCropComplete={handleCropComplete}
                />
            )}

            {/*
             * 【2026-10-03 他要求】右栏配图的**放大阅览**层（`fixed inset-0` + portal 到 body，
             * 盖住整屏；`no-print` 保证纸面不出现）。只动"开/关"，草稿状态一概不受影响。
             */}
            <ImageZoomViewer
                open={isViewerOpen}
                src={photo}
                onClose={() => setIsViewerOpen(false)}
            />
        </main>
    );
}
