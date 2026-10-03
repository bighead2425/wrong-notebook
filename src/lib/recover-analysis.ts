/**
 * 回录分析（深挖纸回录）—— **纯函数**，不碰 DOM / 不碰数据库。
 *
 * ── 这一条链路要解决什么（他 2026-10-04 的原话）──────────────────────
 * 孩子做完一道深挖纸后，会在**正面下半部分**手写"我卡在哪 / 我当时是怎么想的"。
 * 拍一张照，系统应该：读二维码认出题号 → 查出这道题 → 把「照片 + 题干」一起交给 AI
 * → 把她的分析整理成一条**日积月累**（她的话原样留、AI 整理的部分用斜体批注）。
 * 于是"错题 → 深挖纸 → 日积月累 → 打印 → 再做"成了一个循环。
 *
 * ⚠️ 定位方案是他拍板的，别自创：
 *   · 深挖纸正反面二维码 = **裸题号**（`SX20260916001`），不做几何切分（那些浅灰虚线手机拍必断）。
 *   · 先解码拿题号、查出题、**把题干当"地图"一起给 AI**，让它在有上下文的情况下读手写
 *     （比让它从零硬认整页可靠得多）。
 *
 * ── 为什么单独抽一个纯模块 ────────────────────────────────────────────
 * "二维码内容 → 题号"和"题号查不到题的降级路径"这两件事最容易被写进组件里、
 * 又最容易写错（空格/换行/大小写/页码码混入）。抽出来才有单测守着 —— 本机没有 AI key，
 * 真正"真跑一次"做不到，只能靠这些纯逻辑把边界钉死。
 */

import { parsePageCode } from '@/lib/volume-code';
import { QUESTION_NO_PREFIXES } from '@/lib/question-no';
import {
    safeParseRecoverReading,
    type RecoverReadingFromSchema,
} from '@/lib/ai/schema';

/* ===================== 一、二维码内容 → 题号 ===================== */

/**
 * 题号格式（与 `lib/question-no.ts` 同源）：**2 个学科简拼大写 + 8 位日期 + 3 位以上流水**。
 * 例：`SX20260916001`。
 *
 * ⚠️ 中间**绝不能**出现换行 —— 用 `\d` 而不是 `[\s\S]`；外部空白由 `trim()` 收掉。
 */
const QUESTION_NO_RE = /^([A-Z]{2})(\d{8})(\d{3,})$/;

/**
 * 从二维码原文里取题号。
 *
 * 三条容错（都是真实扫码会遇到的）：① 前后空格/换行、② 大小写、③ 前缀不是学科简拼。
 * 认不出返回 `null`（**不猜**：拿不准就得让上层显式报"没认出来"，绝不静默按空题号查库）。
 */
export function parseQuestionNo(raw: string | null | undefined): string | null {
    const s = (raw ?? '').trim().toUpperCase();
    if (!s) return null;
    const m = QUESTION_NO_RE.exec(s);
    if (!m) return null;
    // 前缀必须是 10 个学科简拼之一 —— 否则 `RE…`/`BU…`（卷号）会被误当题号
    if (!QUESTION_NO_PREFIXES.includes(m[1])) return null;
    return s;
}

/** 扫到的编码分类：题号 / 卷页码（走错纸了）/ 空 / 其它 */
export type ScannedCodeKind = 'question' | 'page-code' | 'empty' | 'unknown';

export interface ScannedCode {
    kind: ScannedCodeKind;
    /** question → 规范题号；page-code → 页号；unknown → 去掉外部空白后的原文；empty → '' */
    value: string;
}

/**
 * 把二维码/手输的原文分成四类。
 * 先认**卷页码**（`RE…-02` 这种复练/积累纸的码）—— 走错纸时给一句明确的话，
 * 而不是含糊的"没认出来"。
 */
export function parseScannedCode(raw: string | null | undefined): ScannedCode {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) return { kind: 'empty', value: '' };

    const page = parsePageCode(trimmed);
    if (page) return { kind: 'page-code', value: page.pageCode };

    const no = parseQuestionNo(trimmed);
    if (no) return { kind: 'question', value: no };

    return { kind: 'unknown', value: trimmed };
}

/* ===================== 二、查题结果的降级 ===================== */

/** `/api/scan` 的返回形状（只取判定要用的字段） */
export interface ScanLookupResult<T> {
    found: boolean;
    source?: 'main' | 'trash' | null;
    item?: T | null;
}

/** 卡住的原因（**每一种都必须在界面上说清楚**，绝不静默失败） */
export type ScanBlockedReason = 'empty' | 'page-code' | 'unknown' | 'lookup-miss';

export type ScanResolution<T> =
    | { status: 'ready'; no: string; item: T; source: 'main' | 'trash' | null }
    | { status: 'blocked'; reason: ScanBlockedReason; /** 题号（miss 时）/ 页号（page-code 时）；其余为 null */ detail: string | null };

/**
 * 扫描解析 + 查库结果 → 这张照片接下来该干什么。
 *
 * 降级路径（用户很在意的一条）：题号查不到题 ⇒ `blocked('lookup-miss')`，
 * 由界面显示"没认出来"并给【重试】【跳过】，而不是当成一道空题继续往下走。
 */
export function resolveScannedLookup<T>(
    scanned: ScannedCode,
    lookup: ScanLookupResult<T> | null,
): ScanResolution<T> {
    if (scanned.kind === 'empty') return { status: 'blocked', reason: 'empty', detail: null };
    if (scanned.kind === 'page-code') {
        return { status: 'blocked', reason: 'page-code', detail: scanned.value };
    }
    if (scanned.kind === 'unknown') {
        return { status: 'blocked', reason: 'unknown', detail: scanned.value || null };
    }
    // 到这里 scanned.kind === 'question'
    if (lookup?.found && lookup.item) {
        return {
            status: 'ready',
            no: scanned.value,
            item: lookup.item,
            source: lookup.source ?? null,
        };
    }
    return { status: 'blocked', reason: 'lookup-miss', detail: scanned.value };
}

/* ===================== 三、给 AI 的题目上下文 ===================== */

export interface RecoverQuestionContextInput {
    /** 题号 */
    no: string;
    /** 这道题的题干（AI 的"地图"） */
    questionText?: string | null;
    /** 学科中文名（可选） */
    subject?: string | null;
    /** 这道题记的错因中文名（可选，eg 概念模糊） */
    mistakeReason?: string | null;
}

/**
 * 拼"这让 AI 知道这是哪道题"的上下文块。
 * 题干截断到 1200 字 —— 回录这一屏要紧的是她手写的那一小段，题干只是定位用的。
 * 没有题干也照常返回（AI 仍能只读照片），**不抛错**。
 */
export function buildRecoverQuestionContext(input: RecoverQuestionContextInput): string {
    const lines: string[] = [`题号：${input.no}`];
    if (input.subject) lines.push(`学科：${input.subject}`);
    if (input.mistakeReason) lines.push(`这道题记的错因：${input.mistakeReason}`);
    const text = (input.questionText ?? '').trim();
    lines.push('题干：');
    lines.push(text ? text.slice(0, 1200) : '（这道题没有存到题干文本）');
    return lines.join('\n');
}

/* ===================== 四、AI 读数 → 日积月累正文 ===================== */

/**
 * 从 AI 的原始响应里抠出一个 XML 标签的内容。
 *
 * 与 `ai/openai-provider.ts` 的 `extractTag` 同一口径：闭标签丢了（响应常被 max_tokens 截断）
 * 就退一步读到"下一个标签起点"或末尾，**尽力救回而不是整条失败**。
 */
export function extractTag(text: string, tagName: string): string | null {
    const startTag = `<${tagName}>`;
    const endTag = `</${tagName}>`;
    const startIndex = text.indexOf(startTag);
    if (startIndex === -1) return null;

    const contentStart = startIndex + startTag.length;
    const endIndex = text.indexOf(endTag, contentStart);
    if (endIndex !== -1) {
        if (contentStart >= endIndex) return null;
        return text.substring(contentStart, endIndex).trim();
    }

    const rest = text.substring(contentStart);
    const nextTagAt = rest.search(/<\/?[a-zA-Z_][a-zA-Z0-9_]*>/);
    const fallback = (nextTagAt === -1 ? rest : rest.slice(0, nextTagAt)).trim();
    return fallback || null;
}

/**
 * AI 的原始响应 → 结构化读数（走 zod 校验）。
 * `organized` 空 ⇒ 抛错，由调用方转成"AI 读失败"的提示 —— **绝不让空正文静默入库**。
 */
export function parseRecoveryReading(raw: string): RecoverReadingFromSchema {
    const candidate = {
        herWords: extractTag(raw, 'her_words') ?? '',
        organized: extractTag(raw, 'organized') ?? '',
        unclear: extractTag(raw, 'unclear') ?? '',
    };
    const parsed = safeParseRecoverReading(candidate);
    if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => i.message).join('；');
        throw new Error(`AI_RESPONSE_ERROR: ${detail || 'AI 没有返回可用的分析'}`);
    }
    return parsed.data;
}

/** 把一段文本里的软换行折成空格（**段内**不换行 —— 斜体块内部换行会把它断开） */
function oneLine(s: string): string {
    return s.replace(/\s*\n+\s*/g, ' ').trim();
}

/** AI 整理可能有多段 ⇒ 先按空行切段，每段各自折成一行 */
function paragraphsOf(s: string): string[] {
    return s
        .split(/\n\s*\n+/)
        .map((p) => oneLine(p))
        .filter(Boolean);
}

/** AI 整理的段首标记（同时也是"她的话"与"AI 的话"的分界符，见 `previousHersOf`） */
export const AI_BLOCK_MARK = '—— AI 整理：';
const AI_UNCLEAR_MARK = '（AI 看不清：';

/**
 * 给"AI 的话"加斜体：**每一段各自包一个 `*…*`**。
 *
 * ⚠️ 不能整块包 —— 斜体 `*…*` **跨空行会断**（markdown 里空行是段落分隔）。
 * 所以"允许多段"和"整段斜体"这两件事同时成立，只能靠"一段一个斜体块"。
 * 只有第一段带前缀，后续段不加（免得看起来像好几条并列的批注）。
 */
function italicAiParagraphs(s: string, prefix?: string): string {
    const paras = paragraphsOf(s);
    if (paras.length === 0) return '';
    return paras.map((p, i) => `*${i === 0 ? prefix ?? '' : ''}${p}*`).join('\n\n');
}

/**
 * 从**上次已存的日积月累正文**里切出"**她的话**"那一段。
 *
 * 为什么要这个：他 2026-10-04 要求"对已经有日积月累的题，把原来的和现在的内容**有机合并**后覆盖"。
 * 合并的分工是：
 *   · **她的话 —— 累积保留**（旧的一字不动地留着，新的接在后面）⇒ 由这个函数取出来；
 *   · **AI 的整理 —— 每次重新融合**（交给 AI，见提示词的 `previous_insight`）。
 * 判据就是我们自己写进去的那两个标记 —— 第一个标记**之前**的就是她写的部分。
 * 找不到标记（比如那是一条手工写的日积月累）⇒ **原样返回整段**（宁可多留，不可丢话）。
 */
export function previousHersOf(previous?: string | null): string {
    const s = (previous ?? '').trim();
    if (!s) return '';
    let cut = -1;
    for (const mark of [`*${AI_BLOCK_MARK}`, AI_BLOCK_MARK, `*${AI_UNCLEAR_MARK}`, AI_UNCLEAR_MARK]) {
        const i = s.indexOf(mark);
        if (i !== -1 && (cut === -1 || i < cut)) cut = i;
    }
    return (cut === -1 ? s : s.slice(0, cut)).trim();
}

/**
 * 结构化读数 → 存进日积月累的 **markdown 正文**。
 *
 * 组成（与错题详情页"AI 批注"同一套约定，见 `error-items/[id]/page.tsx` 的 `*—— AI 批注：…*`）：
 *   ① **她的话** —— **原样**，正常段落（她一个字都不改）。若这道题以前记过，
 *      **上次她的话排在前面、这次的接在后面**（时间正序，像一本在长大的册子）。
 *   ② **AI 整理** —— 斜体 + `—— AI 整理：` 前缀；**可以多段**（每段各自包斜体）。
 *      有旧内容时，这里的文字**已经被 AI 融合过**（见提示词的 `previous_insight`），不是拼接。
 *   ③ 看不清的 —— 仅当 AI 有交代时补一行斜体。
 *
 * @param previous 这道题**上次已存的日积月累正文**（没有就不用传）
 */
export function composeRecoveryContent(
    reading: RecoverReadingFromSchema,
    previous?: string | null,
): string {
    const parts: string[] = [];

    // ① 她的话：上次的留着 + 这次的接在后面（"她的话"永不被改写、永不被丢）
    const herParts = [previousHersOf(previous), reading.herWords.trim()].filter(Boolean);
    if (herParts.length > 0) parts.push(herParts.join('\n\n'));

    // ② AI 整理（可多段；只有第一段带前缀）
    const organized = italicAiParagraphs(reading.organized, AI_BLOCK_MARK);
    if (organized) parts.push(organized);

    // ③ 看不清的
    const unclear = oneLine(reading.unclear ?? '');
    if (unclear) parts.push(`*${AI_UNCLEAR_MARK}${unclear}）*`);

    return parts.join('\n\n');
}
