import { ParsedQuestion } from "@/lib/ai/types";

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
}

export interface AppConfig {
    aiProvider: 'gemini' | 'openai' | 'azure';
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
    };
    timeouts?: {
        analyze?: number; // 毫秒
    };
    /** 【custom-v30】扫描收件箱：根目录由 Docker 挂载决定，这里只存根下的相对子路径 */
    scanInbox?: {
        subPath?: string;
    };
}


export interface AnalyticsData {
    totalErrors: number;
    masteredCount: number;
    masteryRate: number;
    subjectStats: { name: string; value: number }[];
    activityData: { date: string; count: number }[];
}

export interface PracticeStatsData {
    subjectStats: { name: string; value: number }[];
    activityStats: { date: string; total: number; correct: number;[key: string]: number | string }[];
    difficultyStats: { name: string; value: number }[];
    overallStats: { total: number; correct: number; rate: string };
}

export interface TagStats {
    tag: string;
    count: number;
}

export interface TagStatsResponse {
    stats: TagStats[];
}

export interface TagSuggestionsResponse {
    suggestions: string[];
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
