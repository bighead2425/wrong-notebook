/**
 * 复练纸回录 —— **纸回录的第二步**的纯逻辑（不碰 DOM / 不碰数据库）。
 *
 * ── 这一步要解决什么（他 2026-10-04 拍板的方案）──────────────────────
 * 复练纸**每页**印一个**页码二维码**（`RE20260926001-02`），它定位到「**哪一卷 + 哪一页**」——
 * **不是**题号。纸面上每道题右边一个**灰圆**（圆里是本卷流水号）、右下角一个**升降框**，
 * 而**她已经自己在纸面上标了**（灰圆三态：灰数字=没标 / 绿勾=做对 / 粉叉=做错）。
 *
 * 核心思路是「**已知版面 + 让 AI 读标记**」，**不要**让 AI 从白纸里认版面、更**不要**让它判卷：
 *   ① 解二维码 ⇒ 拿到「卷号 + 页码」；
 *   ② 查这一卷、取出**这一页的条目**（`ReviewVolumeItem` 存了 pageIndex / columnIndex /
 *      seqInColumn / itemNo / questionText）⇒ 拼成一张"**地图**"（左栏从上到下是哪几题、
 *      右栏哪几题）；
 *   ③ 把「照片 + 地图」交给 AI，让它**只做一件事**：在**已知位置**上读出她标的记号
 *      （对 / 错 / 没标 / 看不清）—— 它标的比 AI 看照片准，而且那是她的判断，本该以她为准。
 *
 * ── 为什么单独一个纯模块 ────────────────────────────────────────────
 * "版面 → 地图"、"AI 读数 → 每题该写什么"这两段最容易写错（栏序、块序、题被删、她没标），
 * 又完全能纯测。本机没有 AI key，"真跑一次 AI"做不到，只能靠这里的单测把边界钉死。
 *
 * ⚠️ 保存**不在这里**：本模块只算"该写什么"，写库由页面在校对后调
 *    `PUT /api/error-items/[id]`（复习结果）与 `PATCH /api/review-volumes/[id]`（卷行标记）。
 * ⚠️ 这一步**不动等级、不改题目类型** —— "反复表现不好 ⇒ 建议升深挖"是下一步的事。
 */

import { parseScannedCode } from '@/lib/recover-analysis';
import { parsePageCode } from '@/lib/volume-code';

/* ===================== 一、二维码内容 → 走哪条路 ===================== */

/**
 * 回录页扫到内容后的**分流**：
 *   · `question`     —— 裸题号（深挖纸）⇒ 走第一步那套（深挖流程）；
 *   · `review-page`  —— 复练纸页二维码（`RE…`）⇒ 走本模块这一套；
 *   · `build-page`   —— 积累纸页二维码（`BU…`）⇒ 这一屏处理不了，要给**一句明确的话**；
 *   · `empty`        —— 没扫到；
 *   · `unknown`      —— 认不出的内容（原样留着给她看）。
 *
 * ⚠️ 题号的分类**复用** `recover-analysis.ts` 的 `parseScannedCode`（单一事实来源），
 *    这里**不另写一份**正则；页二维码再用 `volume-code.ts` 的 `parsePageCode` 分出 RE/BU。
 */
export type RecoveryRoute =
    | { route: 'question'; value: string }
    | { route: 'review-page'; pageCode: string; volumeNo: string; pageNo: number }
    | { route: 'build-page'; pageCode: string; volumeNo: string; pageNo: number }
    | { route: 'empty' }
    | { route: 'unknown'; value: string };

export function classifyRecoveryCode(raw: string | null | undefined): RecoveryRoute {
    const scanned = parseScannedCode(raw);
    if (scanned.kind === 'empty') return { route: 'empty' };
    if (scanned.kind === 'unknown') return { route: 'unknown', value: scanned.value };
    if (scanned.kind === 'question') return { route: 'question', value: scanned.value };

    // 到这里是 page-code：再解析一次拿到「卷别 / 卷号 / 页码」
    const page = parsePageCode(scanned.value);
    if (!page) return { route: 'unknown', value: scanned.value };
    const base = { pageCode: page.pageCode, volumeNo: page.volumeNo, pageNo: page.pageNo };
    return page.kind === 'review' ? { route: 'review-page', ...base } : { route: 'build-page', ...base };
}

/* ===================== 二、卷页面版图 → 给 AI 的"地图" ===================== */

/**
 * 卷里一行（就是 `ReviewVolumeItem` 跟这一步有关的那几个字段）。
 * ⚠️ 这是**快照**：`itemNo` / `questionText` 是印在纸上的内容；
 *    `errorItemId` 只是"还能点回去看看"的软链接，题被删就是 null（纸照常有这一格）。
 */
export interface RecoveryRow {
    /** 卷行的 id（卷内唯一）—— 写 `markState` 用它定位这一行 */
    rowId: string;
    pageIndex: number;
    columnIndex: number;
    seqInColumn: number;
    /** 本卷流水号（1 起）—— 纸面灰圆里印的就是它 */
    seqInVolume: number;
    itemNo: string | null;
    questionText: string | null;
    /** 原题软链接；null = 题已被删除（纸上有这一格，但没处写复习历史） */
    errorItemId: string | null;
    /** 这一卷上这道题的标记（`right`/`wrong`/null）—— 地图不展示它，AI 自己从照片读 */
    markState?: string | null;
    /** 这道题的复习历史（JSON 字符串）—— 保存时用它算 `nextReviewOutcomes` */
    reviewOutcomes?: string | null;
}

/**
 * 这一格在纸面上的**槽位代号**：左栏 `L1..Ln`、右栏 `R1..Rn`（更靠后的栏 `C{col}-{n}`）。
 *
 * ⚠️ 它就是「地图」与「AI 读数」之间对齐的钥匙：地图里这么标、提示词里要求 AI 这么写回来，
 *    读数才能稳稳落回**哪一行**。所以这个函数是**唯一**的槽位命名处，别再在别处拼。
 */
export function slotOfRow(row: Pick<RecoveryRow, 'columnIndex' | 'seqInColumn'>): string {
    const col = Number.isFinite(row.columnIndex) ? row.columnIndex : 0;
    const seq = Number.isFinite(row.seqInColumn) ? row.seqInColumn : 1;
    if (col === 0) return `L${seq}`;
    if (col === 1) return `R${seq}`;
    return `C${col}-${seq}`;
}

/** 栏的人话名（地图里给 AI 看的）：0=左栏 / 1=右栏 / 其余按序号 */
function columnLabel(col: number): string {
    if (col === 0) return '左栏';
    if (col === 1) return '右栏';
    return `第${col + 1}栏`;
}

/**
 * 从卷的全部条目里取出**这一页**的（按栏、按栏内块序排好）。
 * 页里没有的栏不凭空造；一页没有任何条目 ⇒ 返回空数组（调用方报 `empty-page`）。
 */
export function pageRowsOf(rows: readonly RecoveryRow[], pageNo: number): RecoveryRow[] {
    return rows
        .filter((r) => (r.pageIndex || 1) === pageNo)
        .slice()
        .sort((a, b) => (a.columnIndex || 0) - (b.columnIndex || 0) || a.seqInColumn - b.seqInColumn);
}

/** 题干在地图里截到多少字 —— 地图只用来"对上位置"，不是让 AI 做题，短一点更省心 */
const MAP_TEXT_MAX = 60;

/**
 * 拼「这一页的版面地图」—— 交给 AI 的**已知版面**。
 *
 * @param pageRows 已经 `pageRowsOf` 过滤好、排好序的这一页条目
 * @returns 形如：
 *   ```
 *   【这一页的版面（数据库里已知，不需要你认版面）】
 *   左栏（从上到下）：
 *     L1｜流水 1｜题号 SX20260916001｜题干：计算 1/2+1/3
 *     L2｜流水 2｜题号 —｜题干：（纸上有这一格，但题已从题库删除）
 *   右栏（从上到下）：
 *     R1｜流水 3｜题号 SX20260916003｜题干：……
 *   ```
 */
export function buildReviewPageMap(pageRows: readonly RecoveryRow[]): string {
    const lines: string[] = ['【这一页的版面（数据库里已知，不需要你认版面）】'];

    const cols = [...new Set(pageRows.map((r) => r.columnIndex || 0))].sort((a, b) => a - b);
    for (const col of cols) {
        lines.push(`${columnLabel(col)}（从上到下）：`);
        for (const r of pageRows.filter((x) => (x.columnIndex || 0) === col)) {
            const slot = slotOfRow(r);
            const no = (r.itemNo ?? '').trim() || '—';
            const text = (r.questionText ?? '').trim();
            const textOut = r.errorItemId
                ? text
                    ? text.slice(0, MAP_TEXT_MAX)
                    : '（没有存到题干文本）'
                : '（纸上有这一格，但题已从题库删除）';
            lines.push(`  ${slot}｜流水 ${r.seqInVolume}｜题号 ${no}｜题干：${textOut}`);
        }
    }
    return lines.join('\n');
}

/* ===================== 三、AI 读数 → 每一格她标了什么 ===================== */

/**
 * 一格上读到的记号：
 *   · `right`   —— 她标了"对"（绿底白勾）
 *   · `wrong`   —— 她标了"错"（粉底灰叉）
 *   · `none`    —— 没标（灰底白数字）
 *   · `unclear` —— 看不清（交她复核；**绝不猜对错**）
 */
export type RecoveredMark = 'right' | 'wrong' | 'none' | 'unclear';

/** 只有这两种是"她真的标了"，才会写库（见 `planRecoveryWrites`） */
export type RecoveryWrittenMark = 'right' | 'wrong';

export interface ReviewReading {
    /** 槽位代号（`L1`/`R1`/…）→ 她标的记号 */
    marksBySlot: Record<string, RecoveredMark>;
    /** AI 交代的"哪里看不清 / 拿不准"（整体一句，给她复核用） */
    unclear: string;
}

/** 把一个词归一成四态之一；认不出的一律当"看不清"，交她复核（不猜对错） */
export function normalizeMarkValue(value: string | null | undefined): RecoveredMark {
    const s = (value ?? '').trim().toLowerCase();
    if (!s) return 'unclear';
    const exact: Record<string, RecoveredMark> = {
        right: 'right', correct: 'right', 对: 'right', 正确: 'right', 做对: 'right', 勾: 'right',
        '✓': 'right', '√': 'right',
        wrong: 'wrong', incorrect: 'wrong', 错: 'wrong', 做错: 'wrong', 叉: 'wrong',
        '✗': 'wrong', '×': 'wrong', 'x': 'wrong',
        none: 'none', 未标: 'none', 没标: 'none', 空: 'none', 无: 'none', 未做: 'none',
        unclear: 'unclear', 看不清: 'unclear', 不确定: 'unclear', 模糊: 'unclear', '?': 'unclear', '？': 'unclear',
    };
    if (exact[s]) return exact[s];
    if (s.includes('看不清') || s.includes('不确定') || s.includes('模糊')) return 'unclear';
    if (s.includes('对') || s.includes('勾')) return 'right';
    if (s.includes('错') || s.includes('叉')) return 'wrong';
    if (s.includes('没') || s.includes('未') || s.includes('空')) return 'none';
    return 'unclear';
}

const MARK_TAG_RE = /<mark\s+slot\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/mark>/gi;
/** 兜底：AI 没按 XML 写、而是逐行 `L1: right` 时也能读回来 */
const MARK_LINE_RE = /^\s*([A-Za-z]\d+(?:-\d+)?)\s*[:：=]\s*(.+?)\s*$/gm;
const UNCLEAR_TAG_RE = /<unclear>([\s\S]*?)<\/unclear>/i;

/**
 * AI 的原始响应 → 结构化读数。
 *
 * ⚠️ **认不出就留空、绝不猜**：没读到的槽位**不出现**在这个 Record 里
 *    （上层按"没标"兜底，并在校对表格里让她自己填）。
 */
export function parseReviewReading(raw: string): ReviewReading {
    const marksBySlot: Record<string, RecoveredMark> = {};

    const text = raw ?? '';
    let m: RegExpExecArray | null;
    MARK_TAG_RE.lastIndex = 0;
    while ((m = MARK_TAG_RE.exec(text)) !== null) {
        const slot = m[1].trim().toUpperCase();
        if (slot) marksBySlot[slot] = normalizeMarkValue(m[2]);
    }

    // XML 一个都没认到时，再试逐行格式
    if (Object.keys(marksBySlot).length === 0) {
        MARK_LINE_RE.lastIndex = 0;
        while ((m = MARK_LINE_RE.exec(text)) !== null) {
            const slot = m[1].trim().toUpperCase();
            if (slot) marksBySlot[slot] = normalizeMarkValue(m[2]);
        }
    }

    const unclearTag = UNCLEAR_TAG_RE.exec(text);
    return { marksBySlot, unclear: (unclearTag?.[1] ?? '').trim() };
}

/* ===================== 四、读数 → 校对表格 / 该写什么 ===================== */

/** 校对表格里的一行：这一格 + 读到的记号（默认"没标"） */
export interface RecoveryRowMark {
    row: RecoveryRow;
    slot: string;
    mark: RecoveredMark;
}

/**
 * 把 AI 读数铺到这一页的每一行上（= 校对表格的初始值）。
 * 没读到的行 ⇒ `none`（她没标）。
 */
export function applyReadingToRows(pageRows: readonly RecoveryRow[], reading: ReviewReading): RecoveryRowMark[] {
    return pageRows.map((row) => {
        const slot = slotOfRow(row);
        return { row, slot, mark: reading.marksBySlot[slot] ?? 'none' };
    });
}

/** 保存时对某一行要写的东西 */
export interface RecoveryWrite {
    rowId: string;
    slot: string;
    itemNo: string | null;
    errorItemId: string | null;
    /** 写进卷行的 `markState`（只可能是 right / wrong） */
    markState: RecoveryWrittenMark;
    /** 是否把这次结果写进**这道题的复习历史**（她标了 **且** 题还在） */
    writesOutcome: boolean;
}

/**
 * 【这一步的核心输出】**AI 读数（经用户校对）→ 保存时每题该写什么**。
 *
 * 规则（与他定的口径一致）：
 *   · **只写"她标了"的题** —— `none` / `unclear` 一律跳过（不静默清空、不替她做主）；
 *   · **题被删了**（`errorItemId` 为空，纸上有格子但题库没这题）⇒ 只写卷行的 `markState`，
 *     不写复习历史（没处写）；
 *   · `markState` 只可能是 `right` / `wrong`。
 *
 * ⚠️ 复习结果**怎么落格**（"按顺序填第一个空位 + 每次都更新最近一次"）由
 *    `scan-marking.ts` 的 `nextReviewOutcomes` 负责，这里只回答"哪几行要写、写对还是错"。
 */
export function planRecoveryWrites(
    pageRows: readonly RecoveryRow[],
    marksByRowId: Readonly<Record<string, RecoveredMark>>,
): RecoveryWrite[] {
    const out: RecoveryWrite[] = [];
    for (const row of pageRows) {
        const mark = marksByRowId[row.rowId] ?? 'none';
        if (mark !== 'right' && mark !== 'wrong') continue;
        out.push({
            rowId: row.rowId,
            slot: slotOfRow(row),
            itemNo: row.itemNo,
            errorItemId: row.errorItemId,
            markState: mark,
            writesOutcome: !!row.errorItemId,
        });
    }
    return out;
}

/* ===================== 五、查卷结果的降级 ===================== */

/** `/api/review-volumes/lookup` 的返回形状（只取判定要用的字段） */
export interface RecoveryVolumeLookup {
    volume: { id: string; volumeNo: string; kind?: string | null } | null;
    items?: RecoveryRow[];
}

/** 卡住的原因（**每一种都必须在界面上说清楚**，绝不静默失败） */
export type RecoveryBlockedReason = 'volume-miss' | 'wrong-volume' | 'empty-page';

export type RecoveryLookupResolution =
    | { status: 'ready'; volumeId: string; volumeNo: string; pageNo: number; rows: RecoveryRow[] }
    | { status: 'blocked'; reason: RecoveryBlockedReason; detail: string | null };

/**
 * 页二维码 + 查卷结果 → 这张照片接下来该干什么。
 *
 * 三条降级（都能在界面上说清）：
 *   · 卷查不到（`volume-miss`）—— 可能卷被删 / 码不是本机的；
 *   · 返回的卷号与扫到的**对不上**（`wrong-volume`）—— 防御性：多一道路，免得写错卷；
 *   · 这一页一条都没有（`empty-page`）—— 扫到的页码在库里是空的 / 超出总页数。
 */
export function resolveRecoveryLookup(
    scanned: { volumeNo: string; pageNo: number },
    lookup: RecoveryVolumeLookup | null,
): RecoveryLookupResolution {
    const wantNo = scanned.volumeNo.trim().toUpperCase();
    if (!lookup?.volume) return { status: 'blocked', reason: 'volume-miss', detail: wantNo };

    const gotNo = (lookup.volume.volumeNo ?? '').trim().toUpperCase();
    if (gotNo !== wantNo) return { status: 'blocked', reason: 'wrong-volume', detail: gotNo || wantNo };

    const rows = pageRowsOf(lookup.items ?? [], scanned.pageNo);
    if (rows.length === 0) return { status: 'blocked', reason: 'empty-page', detail: String(scanned.pageNo) };

    return { status: 'ready', volumeId: lookup.volume.id, volumeNo: gotNo, pageNo: scanned.pageNo, rows };
}
