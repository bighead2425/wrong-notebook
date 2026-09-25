/**
 * T1 深挖纸 —— 版面常量与复习日期格（P5 / P9 / P20 / P24）。
 *
 * ⚠️ 适用范围：**现阶段唯一在做的纸型就是 T1 深挖纸**（2026-09-24 晚澄清）。
 *    T0 极简重做卡等其余纸型**本轮不涉及**，这里只留架构口子（见 `PAPER_TYPES`）。
 *
 * 本模块是纯计算：不碰 DOM、不碰数据库，所以日期口径能被单测钉死。
 */

import { formatIsoDate } from './date-format';

/* ======================== 纸张尺寸（实测，别改） ======================== */

/**
 * 国内市售 B5 = 182mm × 257mm（**JIS B5**）。
 * ⚠️ CSS 的 `size: B5` 是 ISO B5 = 176×250mm，比国产纸每边小 6mm，满页排版会跑版，
 *    所以 globals.css 的 `@page` 里写的是明确毫米数，这里也必须与之一致。
 */
export const PAPER_B5_MM = { w: 182, h: 257 } as const;

/** `@page` 的四边页边距（14mm 上 / 15mm 左右 / 16mm 下），与 globals.css 保持一致 */
export const PAGE_MARGIN_MM = { top: 14, right: 15, bottom: 16, left: 15 } as const;

/** 可排版的内容区 = 152mm × 227mm。整张纸的版面都按这两个数算。 */
export const CONTENT_MM = {
    w: PAPER_B5_MM.w - PAGE_MARGIN_MM.left - PAGE_MARGIN_MM.right,
    h: PAPER_B5_MM.h - PAGE_MARGIN_MM.top - PAGE_MARGIN_MM.bottom,
} as const;

/**
 * 每一面**实际占**的高度：内容区 227mm 再留 2mm 呼吸。
 *
 * 为什么不直接用 227mm：一面是"固定版式"，要靠显式高度把页脚与页脚细线钉在底部。
 * 但把高度写成与页边距算出来的内容区**一模一样**时，浏览器排版取整只要多出一点点，
 * 就会判定"这一块装不下"而把它整体挪到下一页 —— 表现是每道题前面空一张白纸。
 * 留 2mm 松量对这个风险免疫，代价只是页脚离纸边多 2mm（本来也该留白）。
 */
export const SIDE_HEIGHT_MM = CONTENT_MM.h - 2;

/**
 * 打孔装订位：正面**左**侧、反面**右**侧各空出这么宽，不许排内容。
 *
 * 为什么是"正面左、反面右"：家里活页夹按**一个物理边**打孔。
 * 纸是**长边翻转**（像翻书一样左右翻），翻到背面看时，原来那条物理边
 * 出现在**右边** —— 于是正面留左、反面留右，两面的孔才落在同一条边上。
 *
 * ⚠️ 这个是把"装得进活页夹"变成常量，而不是靠打印出来拿尺子量。
 *   不用活页夹 / 改成侧面粘贴装订时，把它改成 0 即可。
 */
export const PUNCH_GUTTER_MM = 12;

/** 扣掉打孔位之后**真正能排版**的宽度 = 152 − 12 = 140mm */
export const USABLE_WIDTH_MM = CONTENT_MM.w - PUNCH_GUTTER_MM;

export type SheetSide = 'front' | 'back';

/**
 * 每一面的左右内缩量。
 * 正面：左侧让出打孔位；反面：右侧让出（同一条物理边）。
 */
export function sidePaddingMM(side: SheetSide): { left: number; right: number } {
    return side === 'front'
        ? { left: PUNCH_GUTTER_MM, right: 0 }
        : { left: 0, right: PUNCH_GUTTER_MM };
}

/* ============================ 版面分块高度 ============================ */

export const T1_LAYOUT_MM = {
    /** 身份条（学科色标 + 题号 + 年级学期 + 二维码）—— P9 定的 9mm */
    identityBar: 9,
    /**
     * 身份条下面那一行「知识点」（靠左，各知识点用 · 隔开）—— **一行**的高度。
     *
     * ⚠️ 2026-09-26：他嫌知识点"位置太靠下"，两处一起改 ——
     *   ① 文字**贴着上面的横线**（组件里 `align-items: flex-start` + 0.4mm 上内边距，
     *      不再是垂直居中：居中会在这行上下各留 1.6mm 空气，看着就"掉下来了"）；
     *   ② 一行放不下时允许折到**第二行**（见 `knowledgeRowMax`）。
     */
    knowledgeRow: 6,
    /** 知识点最多占的高度（**两行**）。再多就不印了 —— 说明知识点标签打得太碎，该合并。 */
    knowledgeRowMax: 9.5,
    /**
     * 正面各块之间的竖向间隙合计：照片上 1.5mm + 分析区上 1.5mm（见组件）。
     * 这条**必须**进尺寸自检：不把它算进去，两行知识点时最后一排会溢出被裁掉。
     */
    frontGaps: 3,
    /** 正面原题照片高度区间（P9：45–95mm） */
    photoMin: 45,
    photoMax: 95,
    /** 正面十字象限留白下限（P9：≥110mm） */
    crosshairMin: 110,
    /**
     * 反面页脚高度。
     * ⚠️ 2026-09-26 从 20mm 加到 26mm：页脚改成上下两行
     *    （上行 = 二维码 + 横线共享页宽；下行 = 三个日期格 + 末尾虚线框）。
     */
    footer: 26,
    /** 反面手写内容区下限 —— 低于这个值说明题目太长，该拆成两张了 */
    writingMin: 60,
} as const;

/**
 * 反面页脚最末那个**虚线框**（印章 / 她手写"已会"）。
 *
 * ⚠️ 版面上**不许写它的用途**（他 2026-09-26 的原话）：
 *    写上"已会"就等于替她把答案定了，也把这块框死了；
 *    留白，她想盖章就盖章、想写"已会"就写、想画个勾也行。
 *
 * 尺寸：比颜色格（5.5mm 见方）**宽得多、略高一点**，是个扁长方形。
 */
export const STAMP_BOX_MM = { w: 28, h: 8, radius: 1.5 } as const;

/** 颜色格边长（虚线框要比它大，这条是参照系） */
export const SLOT_SIZE_MM = 5.5;

/**
 * 正面尺寸自检（P9）：身份条 + 照片 + 十字留白 必须装得进内容区。
 * 返回富余的毫米数；负数表示装不下。
 *
 * 做成函数而不是常量，是为了以后改纸型（比如换 A4）时**这一条能直接单测**，
 * 不用靠拿尺子量。
 */
export function frontSideSlackMM(photoHeightMM: number): number {
    const used =
        T1_LAYOUT_MM.identityBar +
        T1_LAYOUT_MM.knowledgeRow +
        photoHeightMM +
        T1_LAYOUT_MM.crosshairMin;
    return SIDE_HEIGHT_MM - used;
}

/**
 * 正面照片**最大可印**的高度。
 *
 * 三个上限取小：① P9 定的照片上限 95mm；② 别把十字留白挤到 110mm 以下；
 * ③ **按"知识点占两行"的最坏情况算**（2026-09-26）——
 *    原来只按一行算，知识点一折行，最后 1.5mm 就被侧边 `overflow:hidden` 裁掉，
 *    裁掉的正好是分析区的**下边框和下面两个角标**（OCR 靠它们定方向）。
 *    代价是照片少 1.5mm（93.5 而不是 95），肉眼无感，换来"两行也不会出事"。
 *
 * 组件直接拿它当 `max-height`，于是"装得下"是**算出来的**，不是打印出来拿尺子量才知道。
 */
export function maxFrontPhotoHeightMM(): number {
    const maxAllowed =
        SIDE_HEIGHT_MM -
        T1_LAYOUT_MM.identityBar -
        T1_LAYOUT_MM.knowledgeRowMax -
        T1_LAYOUT_MM.crosshairMin -
        T1_LAYOUT_MM.frontGaps;
    return Math.max(
        T1_LAYOUT_MM.photoMin,
        Math.min(T1_LAYOUT_MM.photoMax, maxAllowed),
    );
}

/**
 * 正面尺寸自检 · **最坏情况**（知识点占满两行）。
 * 返回富余的毫米数；负数表示装不下（会把分析区下沿裁掉）。
 */
export function frontSideSlackWorstMM(photoHeightMM: number): number {
    return (
        SIDE_HEIGHT_MM -
        T1_LAYOUT_MM.identityBar -
        T1_LAYOUT_MM.knowledgeRowMax -
        photoHeightMM -
        T1_LAYOUT_MM.crosshairMin -
        T1_LAYOUT_MM.frontGaps
    );
}

/* ======================== 反面页脚：三个日期格 ======================== */

/**
 * 复习间隔（天）—— **相对「打印日」**。
 *
 * P20 与 R14 曾有两个口径（打印日 vs 首次深挖日），差约 2 天，2026-09-24 定案：
 * 统一以**打印日**为基准，且第一个格是 **+1 而不是 +2**。
 * 理由（原话）：*"当天打印可能是晚上了，可能是做不成的，第二天是 24 小时，比较合理。"*
 * ⇒ 全项目只此一处定义，别处引用这里，不再各写各的。
 */
export const REVIEW_OFFSETS_DAYS = [1, 7, 21] as const;

/**
 * 反面页脚三个进度格的配色（2026-09-25 他要"俏皮一点、让人想往上爬"）。
 *
 * **浅粉 → 嫩绿 → 金黄**，对应她第 1 / 2 / 3 次复做（像"花苞 → 生长 → 结果"）。
 *
 * ⚠️ 第三格原本定的是**棕黄**，2026-09-25 采纳我的反对意见改成**金黄**：
 *    棕黄带褐，容易读成"枯黄 / 旧了 / 干了"；金黄才读成"结果 / 点亮 / 通关"。
 *    而第三格是她**最后一次**、也是最该有成就感的一格 —— 那格的颜色不该往下掉。
 *
 * ⚠️ 每个色给**三个值**，不是只给一个：
 *   `fill` 格子底色（浅）· `border` 边框（同色系中深）· `text` 日期文字（同色系**深**色）。
 *   为什么文字必须是深色：浅色当正文在纸上几乎看不清，而**打印/复印还会把浅色再吃掉一层**。
 *   所以"颜色只负责分区和情绪，可读性由深色兜底"。
 *
 * ⚠️ 灰度/黑白复印下三者会趋同 —— 但三个格的**位置是固定的**（第 1/2/3 次），
 *    顺序本身就携带语义，所以不会因为褪色而读错。
 */
export interface SlotColor {
    /** 人话名（后台/文档里用） */
    name: string;
    /** 格子底色 */
    fill: string;
    /** 格子边框 */
    border: string;
    /** 日期文字（同色系深色，保证可读） */
    text: string;
}

export const SLOT_COLORS: readonly SlotColor[] = [
    { name: '浅粉', fill: '#ffe3ec', border: '#e79ab8', text: '#a8386b' },
    { name: '嫩绿', fill: '#e4f5d8', border: '#8fc766', text: '#42741f' },
    { name: '金黄', fill: '#fff0c2', border: '#f0c33c', text: '#8a6410' },
];

/** 三格里她自判的结果（P20：空 / 对 / 错 三态，她自己打勾打叉） */
export type ProgressMark = 'blank' | 'right' | 'wrong';

export const PROGRESS_MARK_LABEL: Record<ProgressMark, string> = {
    blank: '还没做',
    right: '做对了',
    wrong: '做错了',
};

export interface ReviewSlot {
    /** 第几格，1 / 2 / 3 —— 对应她第 1 / 2 / 3 次复做 */
    index: 1 | 2 | 3;
    /** 距打印日多少天 */
    offsetDays: number;
    date: Date;
    /**
     * 纸面文字，如 `2026-09-25`。
     * ⚠️ 原先写 `9/25`（月/日、不补零），2026-09-24 改定 **yyyy-mm-dd**——
     *    纸面上月/日的写法看着不舒服，而且跨年时"10/1"分不清是哪一年。
     */
    label: string;
}

/** 只按「年月日」加减，**不碰毫秒**。 */
export function addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * 三个日期格。
 * @param printDate 打印那一刻（只用它的年月日，时分秒忽略）
 */
export function reviewDateSlots(printDate: Date): ReviewSlot[] {
    return REVIEW_OFFSETS_DAYS.map((offsetDays, i) => {
        const date = addDays(printDate, offsetDays);
        return {
            index: (i + 1) as 1 | 2 | 3,
            offsetDays,
            date,
            label: formatIsoDate(date),
        };
    });
}

/* ======================== 纸型家族（架构口子） ======================== */

/**
 * T0–T5 的**架构口子**（P4）。
 * ⚠️ 本轮**只做 T1**；其余纸型没有设计，`implemented: false` 的不要排在打印列表里。
 *
 * ⚠️ 2026-09-26 T2 / T3 的**名字已按新方案改口**（他当天定的"三类题 × 三种纸"）：
 *    T2 = 复练纸（RE…）· T3 = 积累纸（BU…）。名字先对齐，**实现仍为 false**。
 */
export interface PaperTypeDef {
    code: 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
    name: string;
    implemented: boolean;
}

export const PAPER_TYPES: readonly PaperTypeDef[] = [
    { code: 'T0', name: '极简重做卡', implemented: false },
    { code: 'T1', name: '深挖纸', implemented: true },
    { code: 'T2', name: '复练纸', implemented: false },
    { code: 'T3', name: '积累纸', implemented: false },
    { code: 'T4', name: '家长档案', implemented: false },
    { code: 'T5', name: '给她的信', implemented: false },
];

/** 现阶段唯一能打印的纸型 */
export const CURRENT_PAPER_TYPE = 'T1' as const;
