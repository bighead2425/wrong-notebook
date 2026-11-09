import { ParsedQuestion } from "@/lib/ai/types";
import type { PaperConfig } from "@/lib/paper";

// 通用分页响应类型
export interface PaginatedResponse<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export interface Tag {
    id: string;
    name: string;
    /**
     * 【2026-11-05 空空】**是不是教材词表里的节点**。
     *
     * 他的规则（一句话）：
     *   · `true` = 词表标签 ⇒ 已经归类，灰色空心，不用再想
     *   · `false` = 自建标签 ⇒ **词表里找不到的**，标紫色 —— 它是一个"待办"：
     *     要么补进词表（变灰），要么确认它就是超纲（保持标记）
     *
     * ⚠️ 不区分"自建但大纲内"和"自建且超纲" ——
     *    那样会让他每次看到一个自建标签都要多判断一层，反而不知道该不该改词表。
     */
    isSystem?: boolean;
    category: string;
    subject: string;
    subcategory?: string | null;
    createdAt: string;
    updatedAt: string;
    _count?: {
        errorItems: number;
    };
}

// AI Model types
export interface AIModel {
    id: string;
    name: string;
    owned_by?: string;
}

export interface ModelsResponse {
    models: AIModel[];
    error?: string;
}

export interface Notebook {
    id: string;
    displayName: string;      // 自由显示名，如 "小五上数学"
    gradeStage: string;       // primary / junior / senior
    grade: string;            // 如 "五年级"
    semester: string;         // 上 / 下
    subject: string;          // subjectKey: math / chinese / ...
    archiveStatus: string;    // active / archived
    userId: string;
    createdAt: string;
    updatedAt: string;
    _count?: {
        errorItems: number;
    };
}

export interface ErrorItem {
    id: string;
    userId: string;
    notebookId?: string | null;
    notebook?: Notebook | null;
    originalImageUrl: string;
    ocrText?: string | null;
    questionText?: string | null;
    answerText?: string | null;
    analysis?: string | null;
    wrongAnswerText?: string | null;
    mistakeAnalysis?: string | null;
    mistakeStatus?: 'not_attempted' | 'wrong_attempt' | 'unknown' | string | null;
    knowledgePoints?: string | null;

    source?: string | null;
    errorType?: string | null;
    userNotes?: string | null;
    tags?: Tag[];

    masteryLevel: number;
    gradeSemester?: string | null;
    paperLevel?: string | null;

    /**
     * 【2026-09-28 新增】**错题等级**：deep（深挖）/ review（复练）。
     * null/空 = **未定**（老数据与还没定过的题）。
     * ⚠️ 只有两个值 ——「积累」不在这一层（积累点背后可以没有错题）。
     * 取值与判据一律走 `lib/manage-type.ts`，别在调用处手写字符串比较。
     */
    manageType?: string | null;
    /** 这个等级怎么来的：default / derived / ai / manual / upgrade（决定能不能被自动派生改写） */
    manageTypeSource?: string | null;
    /**
     * 【M0 字段 · 2026-09-28 接上界面，**2026-09-30 换新枚举**】错因（受控枚举 **8 值、分 3 组**）：
     *   不掌握：concept_vague 概念模糊 / knowledge_gap 知识盲区 / memory_weak 记忆不牢
     *   没做对：misread 审题不清 / calc_slip 计算失误 / fixed_mindset 思维定式
     *   其他：  just_record 就想记录 / unknown_reason 未知错因
     * ⚠️ 与 `errorType`（外部导入透传的英文自由文本）**不是一回事**，别混用。
     * 复习类型就是从它按"**组**"派生的（见 `lib/manage-type.ts` 的 GROUP_TO_TYPE）。
     * 一题只留一个：多个原因同时存在时按 `MISTAKE_CATEGORIES` 的顺序取最靠前的。
     */
    mistakeCategory?: string | null;

    // 状态字段（5.3 单一事实来源）
    printCount?: number;
    /**
     * 【2026-10-01】「深挖了还没印」提醒的**手动按掉**标记。
     * 提醒条件（类型=deep 且 printCount=0 且 本标记为假）由 `lib/manage-type.ts` 的
     * `needsDeepPrintNudge()` 一处判定；类型被改动时服务端会把它复位。
     */
    deepNudgeDismissed?: boolean;
    /** 【2026-09-30】复练纸印刷次数（印一次卷，卷内每道题 +1）—— 与 printCount 分开记 */
    reviewPrintCount?: number;
    attention?: number;
    /**
     * 【2026-09-30】**复习结果**（卡片底部四个圆圈的原材料）。
     * JSON 字符串：`{"planned":["right",null,null],"last":"wrong"}`
     * 前三个 = 第 1/7/21 天计划复习，最后一个 = 最近一次复习（规则见 lib/review-outcomes.ts）。
     */
    reviewOutcomes?: string | null;
    redoCount?: number;
    mergeSource?: string | null;
    /**
     * 【2026-10-10】题间从属关系（主题 / 附题）。
     * `parentId` = 一个指针（附题指向主题）；"主题有哪些附题"**反查**得出，不存第二份。
     * `linkRole` 由**接口算好**发下来（列表接口按这一页算一次；详情页走返回里的 `link` 对象）
     * —— 前端不去猜"有没有人挂我名下"，那件事猜不出来。
     */
    parentId?: string | null;
    linkRole?: 'lone' | 'root' | 'child';
    /**
     * 【2026-10-10】从属关系的**完整视图** —— 只有单条详情接口（`GET /api/error-items/[id]`）
     * 会带它（主题卡 / 附题清单 / 能否恢复）；列表接口只带上面的 `linkRole`（省流量）。
     * 这里只声明界面用得到的角色，完整形状见 `lib/item-link.ts` 的 `LinkView`。
     */
    link?: { role: 'lone' | 'root' | 'child' } | null;
    /**
     * 【2026-10-03 需求第 10 条】这道题**深挖纸**的随机 emoji 标识
     * （印在页眉「印于 …」左边，一题一张纸给一个）。
     * 拿不到时由 `/api/error-items/emoji-marks` 惰性生成写回；取值见 `lib/emoji-mark.ts`。
     */
    emojiMark?: string | null;
    deletedAt?: string | null;
    lastPrintedAt?: string | null;
    inputMethod?: string | null;

    /**
     * 【M3】框坐标落库（P7「存坐标、不烧像素」）。
     * JSON 字符串：{"boxes":[{kind,x,y,w,h}],"base":{w,h,rotation}}，
     * 解析一律走 `lib/crop-regions.ts` 的 parseCropRegions（形状不对返回 null，
     * 绝不在调用处随手 JSON.parse）。
     */
    cropRegions?: string | null;

    createdAt: string;
    updatedAt: string;
}

// For creation/updates
export interface CreateErrorItemRequest extends ParsedQuestion {
    originalImageUrl: string;
    notebookId?: string;
    gradeSemester?: string;
    paperLevel?: string;
}

export type AnalyzeResponse = ParsedQuestion;

export interface UserProfile {
    id: string;
    email: string;
    name?: string | null;
    educationStage?: string | null;
    enrollmentYear?: number | null;
    role: string;
    isActive: boolean;
}

export interface UpdateUserProfileRequest {
    name?: string;
    email?: string;
    educationStage?: string;
    enrollmentYear?: number;
    password?: string;
}

export interface OpenAIInstance {
    id: string;           // 唯一标识 (UUID)
    name: string;         // 用户自定义名称
    apiKey: string;
    baseUrl: string;
    model: string;
    /**
     * 【2026-11-09 空空】**最大输出长度（token）。**
     * 超过模型硬上限会直接 400，所以设置页会按探测到的 `capabilities.maxOutput` 收窄。
     */
    maxTokens?: number;
    /** 思考强度。留空 = 按探测结果自动取最省的 */
    reasoningEffort?: 'off' | 'low' | 'high' | 'max';
    /** 探测出来的能力（测试连接时写入） */
    capabilities?: {
        image: boolean;
        reasoning: boolean;
        thinkingOff: boolean;
        effortLevels: string[];
        maxOutput?: number;
    };
}

export interface AppConfig {
    aiProvider: 'gemini' | 'openai' | 'azure';
    /**
     * 【2026-10-28 打印出口】电脑 / 手机分别走哪个出口。
     * 缺项由 `lib/print-route.ts` 给默认值（电脑本地、手机共享），老配置不需要迁移。
     */
    print?: {
        desktop?: 'local' | 'shared' | 'ask';
        mobile?: 'local' | 'shared' | 'ask';
        serverUrl?: string;
    };
    allowRegistration?: boolean;
    openai?: {
        instances?: OpenAIInstance[];
        activeInstanceId?: string;
    };
    gemini?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
    };
    azure?: {
        apiKey?: string;
        endpoint?: string;       // Azure 资源端点 (https://xxx.openai.azure.com)
        deploymentName?: string; // 部署名称
        apiVersion?: string;     // API 版本 (如 2024-02-15-preview)
        model?: string;          // 显示用模型名 (如 gpt-4o)
    };
    prompts?: {
        analyze?: string;
        similar?: string;
        /** 【2026-10-18】日积月累整理提示词（空 = 用默认模板） */
        insights?: string;
        /** 【2026-11-01 两段式】第二段（在候选里挑）的提示词（空 = 用默认模板） */
        stage2?: string;
    };
    timeouts?: {
        analyze?: number; // 毫秒
    };
    /** 【2026-11-01 两段式】总开关；关着 = 走原来的单段逻辑 */
    /** 【2026-11-01】两段式：默认开启（关掉 = 回到以前的单段，一次出标签） */
    twoStage?: {
        enabled?: boolean;
        maxRetries?: number;
    };
    /**
     * 【custom-v30】扫描收件箱：根目录由 Docker 挂载决定，这里只存根下的相对子路径
     *
     * 【2026-10-24 空空】三种用途各一个目录：录错题 / 回录分析 / PDF 中转。
     * 混在一个目录里，三条流水线会互相看见对方的照片。
     * `subPath` 是老字段，只归「录错题」这一槽，读取时兼容、不必迁移。
     */
    scanInbox?: {
        subPath?: string;
        /** 录错题 */
        wrong?: string;
        /** 回录分析 */
        recover?: string;
        /** PDF 中转 */
        pdf?: string;
    };
    /** 【2026-10-24 幅面】四种纸各用多大；缺项一律按 B5 */
    paper?: PaperConfig;
}


export interface AnalyticsData {
    totalErrors: number;
    masteredCount: number;
    masteryRate: number;
    subjectStats: { name: string; value: number }[];
    activityData: { date: string; count: number }[];
}

export interface PracticeStatsData {
    /**
     * 【2026-11-04 审计 C3】近 6 个月的**活跃天数**（按天去重）。
     *
     * 原来那个数字是 `activityStats.filter(d => d.total > 0).length`，
     * 而 `activityStats` 是**按月**的（最多 6 个点）⇒ 那个"活跃天数"最多只能显示 6，
     * 等于一个永远不会超过 6 的数 —— 看不出"她一共坚持了多少天"。
     */
    activeDays?: number;
    subjectStats: { name: string; value: number }[];
    activityStats: { date: string; total: number; correct: number;[key: string]: number | string }[];
    difficultyStats: { name: string; value: number }[];
    overallStats: { total: number; correct: number; rate: string };
}

/**
 * 【2026-11-06 空空】**使用统计要能按年级/学科分组排行，所以一条记录得知道"它是谁、在哪、属哪科"。**
 *
 * 原来的形状只有 `{ tag, count }`（名字 + 次数），既点不进题（没有 id），
 * 也分不了组（没有册和学科）—— 这就是为什么它只能做一个 top20 的列表。
 */
export interface TagStats {
    /** 标签 id —— 点一下跳到 `/by-tag/<id>` 看这个标签下的题 */
    id: string | null;
    /** 标签名（展示用；老数据没有 id 时只有它） */
    name: string;
    /** 学科：math / chinese / english / physics / chemistry / biology / history / geography / politics */
    subject: string | null;
    /** 册或学段（标签树的根节点名）：数学是"五年级上"，语文/英语/政史地是"小学/初中/高中" */
    stage: string | null;
    /** 词表标签 = true；自建 = false；老数据无从判断 = null */
    isSystem: boolean | null;
    count: number;
}

export interface TagStatsResponse {
    stats: TagStats[];
}

export interface TagSuggestionsResponse {
    /**
     * 【2026-11-04 审计 A1】**带上 id**。
     *
     * 原来只回名字 ⇒ 输入框下拉里点中的标签，保存时只能按名字猜；
     * 「小数减法」这种跨册重名的一猜就废（真真 11-02 只修了「从标签库选」那条路，
     * 这条更常用的漏了 —— 他第二天用出来的正是漏的那条）。
     */
    suggestions: { id: string; name: string }[];
    total?: number;
}

export interface AdminUser extends UserProfile {
    createdAt: string;
    _count: {
        errorItems: number;
        practiceRecords: number;
    };
}

export interface AdminDashboardData {
    overview: {
        totalUsers: number;
        totalErrorItems: number;
        totalPracticeRecords: number;
        totalSubjects: number;
    };
    userStats: AdminUserStats[];
    subjectDistribution: { name: string; count: number }[];
    dailyTrend: { date: string; count: number }[];
    masteryDistribution: {
        new: number;
        reviewing: number;
        mastered: number;
    };
}

export interface AdminUserStats {
    id: string;
    name: string | null;
    email: string;
    role: string;
    isActive: boolean;
    createdAt: string;
    educationStage: string | null;
    enrollmentYear: number | null;
    errorCount: number;
    practiceCount: number;
    notebookCount: number;
}

export interface AdminUserDetail {
    user: {
        id: string;
        name: string | null;
        email: string;
        role: string;
        isActive: boolean;
        createdAt: string;
        educationStage: string | null;
        enrollmentYear: number | null;
    };
    notebooks: { id: string; displayName: string; errorCount: number }[];
    errorCount: number;
    practiceCount: number;
    notebookCount: number;
    recent7DaysCount: number;
    masteryDistribution: {
        new: number;
        reviewing: number;
        mastered: number;
    };
    subjectDistribution: { name: string; count: number }[];
    recentErrorItems: {
        id: string;
        questionText: string | null;
        ocrText: string | null;
        masteryLevel: number;
        createdAt: string;
        notebook: { displayName: string } | null;
    }[];
}

export interface RegisterRequest {
    name: string;
    email: string;
    password: string;
    educationStage: string;
    enrollmentYear: number;
}
