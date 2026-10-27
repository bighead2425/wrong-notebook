import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { DEFAULT_PAPER_CONFIG, type PaperConfig } from './paper';
import type { PrintSettings } from './print-route';

const logger = createLogger('config');

const CONFIG_FILE_PATH = path.join(process.cwd(), 'config', 'app-config.json');

// OpenAI 实例配置
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
        apiVersion?: string;     // API 版本
        model?: string;          // 显示用模型名
    };
    prompts?: {
        analyze?: string;
        similar?: string;
        /**
         * 【2026-10-18】日积月累"整理"的提示词。
         * 空 = 用 `lib/ai/prompts.ts` 的 `DEFAULT_INSIGHTS_TEMPLATE`。
         * 这个场景是**开放的**（不是固定靶），提示词一定会反复调 ⇒ 必须可配置、不能写死。
         */
        insights?: string;
    };
    timeouts?: {
        analyze?: number; // 毫秒
    };
    /**
     * 【custom-v30】扫描收件箱
     *
     * 只存**根目录下的相对子路径**（如 "scan2wrong"），绝对路径不在这里 ——
     * 容器能看到哪个根目录由 docker-compose 的 volumes 决定，改不了；
     * 但这个子路径随时可改，改完立即生效、不用重建容器（"开一次门，门后随便挑"）。
     */
    /**
     * 【2026-10-24 空空】三个收件箱**槽位**。
     *
     * 收件箱从"一个目录"变成"三种用途各一个目录"：
     *   wrong   = 录错题（默认那个，老配置里的 subPath 归它）
     *   recover = 回录分析（扫回来的纸，认领并记账）
     *   pdf     = PDF 中转（举一反三从收件箱拉 PDF）
     *
     * 只存**根目录下的相对子路径**，绝对路径不在这里 —— 容器能看到哪个根目录
     * 由 docker-compose 的 volumes 决定，改不了；但子路径随时可改、立即生效。
     */
    scanInbox?: {
        /** 老字段，只归"录错题"这一槽；新配置请写 wrong。读取时兼容，不必迁移 */
        subPath?: string;
        /** 录错题 */
        wrong?: string;
        /** 回录分析 */
        recover?: string;
        /** PDF 中转 */
        pdf?: string;
    };
    /**
     * 【2026-10-24 幅面】四种纸各用多大。
     *
     * ⚠️ **缺省（或任何一项缺失）= B5** —— 与加这个字段之前完全一致。
     * 读的时候一律走 `paperFor(kind, config.paper)`，它对 undefined 退回 B5，
     * 所以这里**不需要**深合并，老配置文件原样能用。
     *
     * 与"卷"无关：幅面是**渲染规则**，同一份卷切到 A4 就用 A4 渲染（页内题数照旧）。
     */
    /**
     * 【2026-10-28 打印出口】电脑 / 手机分别走哪个出口。
     *
     * 三个值：`local`（本机浏览器打印）/ `shared`（送 NAS 上的 EasyPrinter）/
     * `ask`（每次点打印都问一遍）。
     * 缺项一律走 `lib/print-route.ts` 的默认值（电脑本地、手机共享），
     * 所以老配置原样能用，**不需要迁移**。
     */
    print?: PrintSettings;
    paper?: PaperConfig;
}

// 旧版 OpenAI 配置格式（用于迁移检测）
interface LegacyOpenAIConfig {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
}

// 检测是否为旧版配置格式
function isLegacyOpenAIConfig(config: unknown): config is LegacyOpenAIConfig {
    if (!config || typeof config !== 'object') return false;
    // 旧版配置包含 apiKey 直接字段，而新版包含 instances 数组
    return 'apiKey' in config && !('instances' in config);
}

// 生成唯一 ID
function generateId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// 迁移旧版 OpenAI 配置到新版多实例格式
function migrateOpenAIConfig(legacy: LegacyOpenAIConfig): AppConfig['openai'] {
    if (!legacy.apiKey) {
        // 没有有效配置，返回空实例数组
        return { instances: [], activeInstanceId: undefined };
    }

    const defaultInstance: OpenAIInstance = {
        id: generateId(),
        name: 'Default',
        apiKey: legacy.apiKey,
        baseUrl: legacy.baseUrl || 'https://api.openai.com/v1',
        model: legacy.model || 'gpt-4o',
    };

    return {
        instances: [defaultInstance],
        activeInstanceId: defaultInstance.id,
    };
}

const DEFAULT_CONFIG: AppConfig = {
    aiProvider: (process.env.AI_PROVIDER as 'gemini' | 'openai' | 'azure') || 'gemini',
    allowRegistration: true,
    openai: {
        instances: process.env.OPENAI_API_KEY ? [{
            id: 'env-default',
            name: 'Default (ENV)',
            apiKey: process.env.OPENAI_API_KEY,
            baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            model: process.env.OPENAI_MODEL || 'gpt-4o',
        }] : [],
        activeInstanceId: process.env.OPENAI_API_KEY ? 'env-default' : undefined,
    },
    gemini: {
        apiKey: process.env.GOOGLE_API_KEY,
        baseUrl: process.env.GEMINI_BASE_URL,
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    },
    azure: {
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview',
        model: process.env.AZURE_OPENAI_MODEL || 'gpt-4o',
    },
    prompts: {
        analyze: '',
        similar: '',
        insights: '',
    },
    timeouts: {
        analyze: 180000,
    },
    scanInbox: {
        // 沿用既有约定：老用户升级后不用做任何设置就是这个名字
        subPath: 'scan2wrong',
    },
    // 【2026-10-24】四种纸默认全是 B5 —— 新部署/老配置都走这一套
    paper: { ...DEFAULT_PAPER_CONFIG },
};

export function getAppConfig(): AppConfig {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
        try {
            const fileContent = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
            const userConfig = JSON.parse(fileContent);

            // 检测并迁移旧版 OpenAI 配置
            let openaiConfig = userConfig.openai;
            if (isLegacyOpenAIConfig(userConfig.openai)) {
                logger.info('Detected legacy OpenAI config, migrating to multi-instance format...');
                openaiConfig = migrateOpenAIConfig(userConfig.openai);
                // 持久化迁移结果
                const migratedConfig = {
                    ...userConfig,
                    openai: openaiConfig,
                };
                fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(migratedConfig, null, 2));
                logger.info('Legacy OpenAI config migrated successfully');
            }

            // Merge with default to ensure all fields exist
            return {
                ...DEFAULT_CONFIG,
                ...userConfig,
                openai: {
                    instances: openaiConfig?.instances || DEFAULT_CONFIG.openai?.instances || [],
                    activeInstanceId: openaiConfig?.activeInstanceId || DEFAULT_CONFIG.openai?.activeInstanceId,
                },
                gemini: { ...DEFAULT_CONFIG.gemini, ...userConfig.gemini },
                azure: { ...DEFAULT_CONFIG.azure, ...userConfig.azure },
                prompts: { ...DEFAULT_CONFIG.prompts, ...userConfig.prompts },
                timeouts: { ...DEFAULT_CONFIG.timeouts, ...userConfig.timeouts },
                scanInbox: { ...DEFAULT_CONFIG.scanInbox, ...userConfig.scanInbox },
            };
        } catch (error) {
            logger.error({ error }, 'Failed to read config file');
            return DEFAULT_CONFIG;
        }
    }
    return DEFAULT_CONFIG;
}

export function updateAppConfig(newConfig: Partial<AppConfig>) {
    const currentConfig = getAppConfig();
    const updatedConfig = {
        ...currentConfig,
        ...newConfig,
        openai: {
            instances: newConfig.openai?.instances ?? currentConfig.openai?.instances ?? [],
            activeInstanceId: newConfig.openai?.activeInstanceId ?? currentConfig.openai?.activeInstanceId,
        },
        gemini: { ...currentConfig.gemini, ...newConfig.gemini },
        azure: { ...currentConfig.azure, ...newConfig.azure },
        prompts: { ...currentConfig.prompts, ...newConfig.prompts },
        timeouts: { ...currentConfig.timeouts, ...newConfig.timeouts },
        scanInbox: { ...currentConfig.scanInbox, ...newConfig.scanInbox },
        /* 【2026-10-28】必须深合并：普通用户保存设置时只会回传 desktop/mobile，
           浅合并会把管理员填的 serverUrl 一起冲掉。 */
        print: { ...currentConfig.print, ...newConfig.print },
    };

    try {
        fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(updatedConfig, null, 2));
        return updatedConfig;
    } catch (error) {
        logger.error({ error }, 'Failed to write config file');
        throw error;
    }
}

// 获取当前激活的 OpenAI 实例配置
export function getActiveOpenAIConfig(): OpenAIInstance | undefined {
    const config = getAppConfig();
    const instances = config.openai?.instances || [];
    const activeId = config.openai?.activeInstanceId;

    if (!activeId || instances.length === 0) {
        return undefined;
    }

    return instances.find(i => i.id === activeId);
}

// 最大实例数限制
export const MAX_OPENAI_INSTANCES = 10;

