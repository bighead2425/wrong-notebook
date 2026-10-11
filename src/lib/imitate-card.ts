import { VOLUME_COLUMN_MM, type MeasuredBlock } from '@/lib/review-card';
import { stripMarkdownImages } from '@/lib/markdown-utils';

/**
 * 【2026-10-10】T4 **模仿纸**的版面规则（纯函数，规则只写这一处）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这张纸跟另外三种**问的问题不一样**（他定的四种纸四种问法）：
 *   深挖纸 = 我为什么错 / 复练纸 = 我掌握没掌握 / 积累纸 = 开放笔记
 *   **模仿纸 = 我如何能对** —— 给自驱力弱的孩子：左栏把主题整个摊开
 *   （题干 → 图 → 遮挡线 → **参考答案 → 解析**），右栏放几道同类附题，让他**照着做**。
 *
 * ⚠️ 所以它是**唯一允许印 AI 内容**的纸型（答案与解析就印在左栏）。
 *    其余三种纸仍然守"纸上零 AI 内容"这条铁律。
 * ⚠️ **不印错因**（他 2026-10-10 明确："模仿纸不谈'错'这件事"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 分页：这张纸是**两条独立的流**，按同一批页输出
 *
 *   · **左栏（主题内容）**：一段一段往下填，一页放不下就**顺延到下一页**
 *     —— 这正是它跟另外三种纸最大的不同（那三种是"整块绝不跨页"，
 *     而左栏的题干/答案/解析本来就是长文，必须能接下去）。
 *   · **右栏（附题）**：与复练纸同一套规矩 —— **一道题绝不跨页**。
 *   · **总页数 = 两条流里大的那个**（某一侧先放完，那侧后面的页就是空的）。
 *
 * ⚠️ 段**不再切开**（同一个段内部不拆），但"段"划得比以前细得多：
 *    长答案 / 长解析在 `buildImitateSegments` 里就按**语义边界**（空行、`【…】`小标题）
 *    切成了几块（`splitImitateBlocks`）—— 于是"接着往下印"是在**块**这一级发生的，
 *    而不必去拆一个字（真要拆字得做文本级测量，得不偿失）。
 *    他 2026-10-12 的原话："一页放不下的时候后面的部分到第二页，第二页也满了后再往第三页去。"
 *
 * ⚠️ 另一个必须记住的前提：**量尺与纸面必须同一套排版**。
 *    2026-10-12 查出来的真 bug 就在这儿 —— 量尺容器在 `.print-sheet` 外面，
 *    继承了根节点的 `line-height: 1.5`，而纸面是 1.7，于是"量的"比"印的"矮约 12%，
 *    分页以为还排得下、继续往这一页塞，印的时候被 `overflow: hidden` 裁掉。
 *    修在 `globals.css` 的 `.print-review-measure`（那里有完整说明），这里只留一句提醒。
 */

/** 左栏里的一段（题干段落 / 题图 / 遮挡线 / 参考答案段落 / 解析段落，都是段） */
export interface ImitateSegment {
    /**
     * 唯一键：渲染与"量尺"都靠它对齐。
     * ⚠️ 形状是 `${题 id}:${stem|figure|divider|answer#n|analysis#n}` ——
     *    长文切成多块之后，**同一种 role 会有多个 key**（`#0`、`#1`…）。
     */
    key: string;
    /**
     * 画法（**分页算法不关心它**，只给渲染层看）：
     *   · `text`    —— 文字段（题干 / 答案 / 解析）
     *   · `figure`  —— 题图
     *   · `divider` —— 那条"遮挡线"（中间写"遮挡"二字）
     */
    kind: 'text' | 'figure' | 'divider';
    heightMM: number;
}

export interface ImitateSheet {
    /** 本页左栏的段（按顺序；空了就是这页左栏没内容了） */
    left: ImitateSegment[];
    /** 本页右栏的附题块（按顺序；已带**跨页连续**的流水号） */
    right: { key: string; heightMM: number; seq: number }[];
}

export interface ImitateLayout {
    sheets: ImitateSheet[];
    /**
     * 一栏都装不下的附题（key + 高度）—— 调用方拿它提示"这道题改用深挖纸"。
     */
    overflowRight: { key: string; heightMM: number }[];
    /**
     * 【2026-10-12】**比一整栏还高**的左栏段 —— 调用方拿它提示
     * "主题里有一段太长，纸上看不全，把它拆成两段"。
     *
     * ⚠️ 为什么不干脆静默让它溢出去：纸上看不到的等于没印，而**不声不响地少印**
     *    正是他 2026-10-12 报上来的那类问题。宁可提示一句。
     * ⚠️ 为什么左栏不再"独占一页就完事"：独占一页确实保住了"不被别的段挤掉"，
     *    但一段只要**本身就比一栏高**，独占一页照样会把尾巴裁掉 ——
     *    所以长文要先按语义边界切块（`splitImitateBlocks`），切完还超高的才进这里。
     */
    overflowLeft: { key: string; heightMM: number }[];
}

/**
 * 按**真实高度**给模仿纸分页（两条流）。
 *
 * @param leftSegments 左栏的段，**按主题内容的自然顺序**排好（题干 → 图 → 遮挡线 → 答案 → 解析）
 * @param rightBlocks  右栏的附题块，按卷内顺序排好（高度来自隐藏量尺的真实测量）
 * @param reservedMM   给页脚预留的高度（从每栏可用高度里扣掉；复练纸那边为同样的理由加过）
 */
export function paginateImitate(
    leftSegments: readonly ImitateSegment[],
    rightBlocks: readonly MeasuredBlock[],
    reservedMM = 0,
): ImitateLayout {
    /** 本栏**真正**可用的高度（扣掉页脚预留）；下限 10mm 兜住"配置写错" */
    const usableMM = Math.max(10, VOLUME_COLUMN_MM - reservedMM);

    /* ── 流①：左栏。段不切开，装不下就整段顺延下一页 ── */
    const leftPages: ImitateSegment[][] = [];
    const overflowLeft: { key: string; heightMM: number }[] = [];
    let curLeft: ImitateSegment[] = [];
    let usedLeft = 0;
    for (const seg of leftSegments) {
        /** 量出来的高度 + 一点余量（吸收"量完再渲染"的取整差，见 `IMITATE_SEG_SLACK_MM`） */
        const h = seg.heightMM + IMITATE_SEG_SLACK_MM;
        /**
         * 单段比整栏还高 ⇒ 让它**独占一页**（先保住"不被别的段挤掉"），
         * 同时**记进 `overflowLeft`** 让界面提示他"这段太长、纸上看不全，请拆成两段"。
         * ⚠️ 正常情况轮不到这里：长答案/长解析在 `buildImitateSegments` 里已经按
         *    语义边界切成几块了（`splitImitateBlocks`）。这里兜的是"一整块本身就超长"
         *    （比如一段从头到尾没有空行、也没有【…】小标题的长文）。
         */
        if (h > usableMM) {
            overflowLeft.push({ key: seg.key, heightMM: seg.heightMM });
            if (curLeft.length) {
                leftPages.push(curLeft);
                curLeft = [];
                usedLeft = 0;
            }
            leftPages.push([seg]);
            continue;
        }
        if (usedLeft + h > usableMM) {
            leftPages.push(curLeft);
            curLeft = [];
            usedLeft = 0;
        }
        curLeft.push(seg);
        usedLeft += h;
    }
    if (curLeft.length) leftPages.push(curLeft);

    /* ── 流②：右栏。整块不跨页，装不下换页；一栏都装不下 ⇒ 记进 overflow ── */
    const rightPages: ImitateSheet['right'][] = [];
    const overflowRight: { key: string; heightMM: number }[] = [];
    let curRight: ImitateSheet['right'] = [];
    let usedRight = 0;
    let seq = 0;
    for (const block of rightBlocks) {
        seq += 1;
        /** 同样加余量（右栏的题块里也有题干文字，量矮了就会被顶出纸外） */
        const h = block.heightMM + IMITATE_SEG_SLACK_MM;
        if (h > usableMM) {
            /** 流水号照样往前走：它是"卷里的第几道"，不该因为排不下就断号 */
            overflowRight.push({ key: block.key, heightMM: block.heightMM });
            continue;
        }
        if (usedRight + h > usableMM) {
            rightPages.push(curRight);
            curRight = [];
            usedRight = 0;
        }
        curRight.push({ key: block.key, heightMM: block.heightMM, seq });
        usedRight += h;
    }
    if (curRight.length) rightPages.push(curRight);

    /* ── 合页：页数取两条流里大的那个（至少 1 页，空卷也要有一张纸） ── */
    const pageCount = Math.max(leftPages.length, rightPages.length, 1);
    const sheets: ImitateSheet[] = [];
    for (let i = 0; i < pageCount; i += 1) {
        sheets.push({ left: leftPages[i] ?? [], right: rightPages[i] ?? [] });
    }

    return { sheets, overflowRight, overflowLeft };
}

/** 这份模仿纸一共几张（他界面上"第 X / Y 页"的 Y） */
export function imitatePageCount(layout: ImitateLayout): number {
    return layout.sheets.length;
}

/* ------------------------------------------------------------------ */
/* 左栏的内容：把主题拆成"段"                                            */
/* ------------------------------------------------------------------ */

/**
 * 左栏里一段的**内容**（不含高度 —— 高度要靠隐藏量尺按真实渲染量出来）。
 *
 * ⚠️ 顺序就是他定的那个：**题干 → 图 → 遮挡线 → 参考答案 → 解析**。
 *    两张"小标题"（`heading`）是给下面那段定名的，他自己那版设计稿里就写着
 *    "依次挂上，这道主题详情页的解析、参考答案"。
 * ⚠️ **没有"错因"**：他 2026-10-10 明确更正过 —— 模仿纸问的是"我如何能对"，
 *    **不谈"错"这件事**（原稿里写的"错因分析"作废）。
 */
export interface ImitateSegmentSpec {
    key: string;
    kind: 'text' | 'figure' | 'divider';
    /**
     * 这一段是什么：
     *   · `stem`     题干的正文
     *   · `answer`   参考答案（**包着它的小标题一起**）
     *   · `analysis` 解析（同上）
     * （`figure` / `divider` 两段的 role 用 `stem` 占位，渲染层按 kind 画）
     */
    role: 'stem' | 'answer' | 'analysis';
    /** 这一段的正文（`figure` / `divider` 为空） */
    text: string;
    /**
     * 【2026-10-12】小标题（"参考答案" / "解析"）—— 与正文**同属一段**。
     *
     * ⚠️ 为什么把它并进正文那一段（原来是"标题一段、正文一段"）：
     *    分成两段，分页就能把它们**拆到两页**去 —— 他 2026-10-12 给的 PDF 里
     *    满页都是"第 1 页末尾孤零零一个『解析』、正文跑到了第 2 页"
     *    （他的原话："遮挡线下面的内容是断的"）。
     *    合成一段之后，标题与正文**在 DOM 里就是同一个盒子**，
     *    分页只有"整段留下"与"整段挪走"两种结局 ——
     *    结构上就不可能再拆开，不靠"记得别拆"这种约定。
     */
    heading?: string;
}

/**
 * 每段（以及右栏每道附题）在分页时**多算**这么一点高度。
 *
 * 与复练纸那个 `REVIEW_BLOCK_SLACK_MM` 是同一条道理，只是这里给得更宽：
 * 模仿纸的左栏是**长文**（题干 / 答案 / 解析，里面全是 LaTeX 分式），
 * 它跟复练纸那种"以留白行数为主"的块不一样 —— 行数占高度的大头，文字那点误差看不出来；
 * 左栏反过来，**文字就是全部内容**，量矮一点点就会把末尾几行顶出纸外被 `overflow` 裁掉。
 *
 * 他 2026-10-12 明确过取舍："留白部分是最后保障的" ——
 * 多留一点白（页尾空几毫米）他接受，**少印一段内容他绝不接受**。
 * ⚠️ 2026-10-12 同一天还修掉了量尺与纸面**行高不一致**（1.5 vs 1.7）这个真 bug
 *    （见 `globals.css` 的 `.print-review-measure`）。那才是"少印"的主因；
 *    这个 slack 是第二道保险，两样都要。
 */
export const IMITATE_SEG_SLACK_MM = 2;

/**
 * 【2026-10-12】把一段长文按**语义边界**切成几块（段内再分块）。
 *
 * ── 为什么必须有它（他 2026-10-12 报的那个"余数页"问题）─────────────
 * 主题的解析常常比一整栏还高。原来它是**一个段**，分页只有两条路：
 * "整段留在这一页"（装不下 ⇒ 被 `overflow: hidden` 裁掉尾巴）或"整段挪到下一页"。
 * 他原话："一页放不下的时候后面的部分到第二页，第二页也满了后再往第三页去。"
 * ⇒ 那就得让**长文自己能被分**，而不是只能"整块搬"。
 *
 * ── 只在两种地方切（都是作者自己标出来的"这里换一节"）─────────────
 *   ① **空行**：markdown 里就是"另一个段落"；
 *   ② **整行的 `【…】` 小标题**：他这套 AI 解析就是这么分节的
 *      （【解题思路】/【正确解答推导】/【易错提醒】…）。
 *
 * ⚠️ **绝不切进列表中间**：markdown 的"1. 2. 3."分成两块渲染，数字会**从 1 重来**，
 *    纸上就成了"1. 2. 3. 1. 2." —— 那不是排版问题，是把内容改错了。
 * ⚠️ **绝不切进 `$$ … $$` 公式**：公式被切成两半直接渲染不出来。
 *    所以进公式之后，里面的空行不算块边界（公式内部常常有空行）。
 */
export function splitImitateBlocks(text: string): string[] {
    const raw = (text ?? '').replace(/\r\n/g, '\n').trim();
    if (!raw) return [];

    const chunks: string[] = [];
    let cur: string[] = [];
    /** 在 `$$ … $$` 里面吗（在里面时空行与【…】都不算边界） */
    let inDisplayMath = false;

    const flush = () => {
        const body = cur.join('\n').trim();
        if (body) chunks.push(body);
        cur = [];
    };

    for (const line of raw.split('\n')) {
        const t = line.trim();
        /**
         * `$$` 独占一行 = 公式开始/结束（他这套编辑器里公式必须独占一行，见项目铁律）。
         * ⚠️ `$$x=1$$` 这种**一行写完**的不能当成"开关" —— 否则后面的边界全乱。
         */
        const isMathFence = t === '$$' || (t.startsWith('$$') && !t.endsWith('$$'));

        if (!t && !inDisplayMath) {
            flush();
            continue;
        }
        if (!inDisplayMath && /^【.+】$/.test(t) && cur.length) flush();

        cur.push(line);
        if (isMathFence) inDisplayMath = !inDisplayMath;
    }
    flush();
    return chunks;
}

/** 只取"这几种字段"——不要把整条 `ErrorItem` 拖进纯逻辑里 */
export interface ImitateSource {
    id: string;
    questionText?: string | null;
    ocrText?: string | null;
    answerText?: string | null;
    analysis?: string | null;
}

/**
 * 把**主题**拆成左栏的段序列。
 *
 * ⚠️ 题干优先用 `questionText`、退回 `ocrText`（与复练纸题块同一口径）；
 *    并且**去掉文中的 markdown 图片** —— 题图是单独一段（`figure`），
 *    不然同一张图会印两遍（复练纸那边也踩过这个：`stripMarkdownImages`）。
 * ⚠️ 空内容不占段：没有答案就**不画**"参考答案"那个小标题，
 *    免得纸上出现一个孤零零的标题、下面一片空白。
 * ⚠️ 图要不要那一段由**调用方**决定（`opts.hasFigure`）—— 判断"有没有题图"
 *    要先解 `cropRegions`，那是另一层的事，不拉进这个纯函数里。
 */
export function buildImitateSegments(
    item: ImitateSource,
    opts: { hasFigure: boolean } = { hasFigure: false },
): ImitateSegmentSpec[] {
    const out: ImitateSegmentSpec[] = [];
    const stem = stripMarkdownImages((item.questionText || item.ocrText || '').trim());
    if (stem) {
        out.push({ key: `${item.id}:stem`, kind: 'text', role: 'stem', text: stem });
    }
    if (opts.hasFigure) {
        out.push({ key: `${item.id}:figure`, kind: 'figure', role: 'stem', text: '' });
    }
    /** 遮挡线：把"题目"和"答案"分开的那条线（与深挖纸背面同一个东西） */
    out.push({ key: `${item.id}:divider`, kind: 'divider', role: 'stem', text: '' });

    /**
     * 答案与解析：**小标题 + 正文同属第一块**，长文再按语义边界切成几块
     * （见 `ImitateSegmentSpec.heading` 与 `splitImitateBlocks` 两处的说明）。
     */
    const pushText = (role: 'answer' | 'analysis', heading: string, value: string | null | undefined) => {
        const chunks = splitImitateBlocks(value ?? '');
        chunks.forEach((chunk, i) => {
            out.push({
                key: `${item.id}:${role}#${i}`,
                kind: 'text',
                role,
                text: chunk,
                /** ⚠️ 小标题只挂在**第一块**上 —— 它跟着第一块走，不会孤零零留在页尾 */
                ...(i === 0 ? { heading } : {}),
            });
        });
    };
    pushText('answer', '参考答案', item.answerText);
    pushText('analysis', '解析', item.analysis);
    return out;
}

/** 段的内容 → 分页要的 `ImitateSegment`（把量出来的高度配上去） */
export function withHeights(
    specs: readonly ImitateSegmentSpec[],
    heightOf: (key: string) => number,
): ImitateSegment[] {
    return specs.map((s) => ({
        key: s.key,
        kind: s.kind,
        heightMM: heightOf(s.key),
    }));
}

/* ------------------------------------------------------------------ */
/* 按**快照**还原模仿卷的版面（卷管理页 / 扫到的模仿卷，2026-10-11）        */
/* ------------------------------------------------------------------ */

/** 快照里的一行（就是 `ReviewVolumeItem` 里跟排版有关的那几个字段） */
export interface ImitateSnapshotRow {
    /** 题在界面里的 key（= 原题 id；题被删了也得有个 key，所以存快照时用它自己那行） */
    key: string;
    /** 右栏的流水号（1 起）；**左栏（主题）那一行是 0** */
    seq: number;
    pageIndex: number;
    /** 0 = 左栏（主题那一行）、1 = 右栏（附题） */
    columnIndex: number;
    seqInColumn: number;
}

/**
 * 按**快照**把模仿卷还原成"每一页印什么" —— 右栏**只认快照**，左栏按主题现算。
 *
 * 为什么两条流待遇不同（他在设计稿里写得很准确）：
 *   · **右栏**："每页的题就固定了，这个和复练纸是一样的" ⇒ 页归属锁死，
 *     手机扫这一页的二维码要能对回这一页，题在各页之间窜来窜去就白扫了；
 *   · **左栏**："模仿卷并不记录卷内题的从属关系……这样数据库记录的模仿卷，日后也可以重新生成了"
 *     ⇒ 左栏的段**不存**，按主题内容现算现排（所以这里要传量好的段）。
 *
 * 页数取**两者里大的那个**：右栏排到第 3 页、左栏只用了 1 页 ⇒ 仍然是 3 页（第 2/3 页左栏空着）；
 * 反过来，主题后来被写长了、左栏多出一页 ⇒ 那多出来的一页右栏空着（纸照印）。
 *
 * @param rows         快照里**右栏**那些行（`columnIndex === 1` 的那些；左栏那一行不要传进来）
 * @param leftSegments 左栏的段（**已量好高度**）—— 传空数组就是"左栏什么都不印"
 */
export function imitateLayoutFromSnapshot(
    rows: readonly ImitateSnapshotRow[],
    leftSegments: readonly ImitateSegment[],
): ImitateLayout {
    const rightRows = rows.filter((r) => (r.columnIndex || 0) !== 0);
    const rightMaxPage = rightRows.reduce((m, r) => Math.max(m, r.pageIndex || 1), 1);

    /**
     * 左栏那条流**原样复用 `paginateImitate`**（右栏传空）——
     * 别在这儿再写一遍"贪心填栏"，那正是"同一套规则两份实现"的开端。
     */
    const leftSheets = paginateImitate(leftSegments, []).sheets;

    const pageCount = Math.max(rightMaxPage, leftSheets.length, 1);
    const sheets: ImitateSheet[] = [];
    for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
        const onPage = rightRows
            .filter((r) => (r.pageIndex || 1) === pageNo)
            .sort((a, b) => (a.seqInColumn || 1) - (b.seqInColumn || 1));
        sheets.push({
            left: leftSheets[pageNo - 1]?.left ?? [],
            right: onPage.map((r) => ({ key: r.key, heightMM: 0, seq: r.seq })),
        });
    }

    return { sheets, overflowRight: [], overflowLeft: [] };
}

/** 从快照行里挑出**左栏那一行**（主题）—— `columnIndex === 0` */
export function themeRowOfSnapshot(rows: readonly ImitateSnapshotRow[]): ImitateSnapshotRow | null {
    return rows.find((r) => (r.columnIndex || 0) === 0) ?? null;
}

/* ------------------------------------------------------------------ */
/* 量尺：从隐藏容器里读真实高度                                            */
/* ------------------------------------------------------------------ */

/** 隐藏量尺容器的类名（两处调用共用一个：打印预览 / 卷管理页） */
export const IMITATE_MEASURE_CLASS = 'print-review-measure no-print';
/** 左栏每一段的锚点属性（`ImitateSegments` 会给每段加上它） */
export const IMITATE_SEG_ATTR = 'data-imitate-seg';
/** 右栏每个附题块的锚点属性（`ReviewQuestionBlock` 自己带的） */
export const REVIEW_BLOCK_ATTR = 'data-review-block';

/**
 * 从量尺容器里读出真实高度，配回段规格 / 附题清单。
 *
 * ⚠️ 抽出来共用（打印预览与卷管理页都要量）——"逐段读 rect、px 换 mm、按 key 对齐"
 *    这三件事各写一遍，迟早有一处用 px 当 mm、或者漏掉某一段。
 *
 * @param container 量尺容器（必须**在 DOM 里、且已布局**；`display:none` 量出来全是 0）
 * @param specs     左栏的段规格（顺序即版面顺序）—— 高度按 key 对齐着配回去
 * @param blockKeys 右栏附题的 key（顺序即卷内顺序）
 */
export function readImitateHeights(
    container: HTMLElement,
    specs: readonly ImitateSegmentSpec[],
    blockKeys: readonly string[],
): { segments: ImitateSegment[]; blocks: MeasuredBlock[] } {
    const toMM = (px: number) => (px * 25.4) / 96; // CSS 规定 1in = 96px，1in = 25.4mm

    const segHeights: Record<string, number> = {};
    container.querySelectorAll<HTMLElement>(`[${IMITATE_SEG_ATTR}]`).forEach((node) => {
        const key = node.dataset.imitateSeg;
        if (key) segHeights[key] = toMM(node.getBoundingClientRect().height);
    });

    const blockHeights: Record<string, number> = {};
    container.querySelectorAll<HTMLElement>(`[${REVIEW_BLOCK_ATTR}]`).forEach((node) => {
        const key = node.dataset.reviewBlock;
        if (key) blockHeights[key] = toMM(node.getBoundingClientRect().height);
    });

    return {
        /**
         * 缺的高度给 0：最坏是那一段和别的挤在同一页。
         * ⚠️ **不能**在这儿自己拼 `{key, kind, heightMM}` —— 那就得重新判断 kind，
         *    于是"哪种段长什么样"这条规则就有了第二处实现。
         */
        segments: withHeights(specs, (k) => segHeights[k] ?? 0),
        blocks: blockKeys.map((k) => ({ key: k, heightMM: blockHeights[k] ?? 0 })),
    };
}
