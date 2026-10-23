"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppConfig } from "@/types/api";
import { DEFAULT_ANALYZE_TEMPLATE, DEFAULT_SIMILAR_TEMPLATE, DEFAULT_INSIGHTS_TEMPLATE } from "@/lib/ai/prompts";
import { RotateCcw, AlertTriangle, Info } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

type PromptKind = 'analyze' | 'similar' | 'insights';

const KINDS: readonly PromptKind[] = ['analyze', 'similar', 'insights'] as const;

interface PromptSettingsProps {
    config: AppConfig;
    /**
     * 【2026-10-18】加了第三项 `insights`（日积月累整理）。
     * 为什么它必须可配置：这一项是**开放场景**（不是固定靶），提示词一定反复调；
     * 写死在代码里 ⇒ 每调一次就要发一次版，等于不能调。
     */
    onUpdate: (type: PromptKind, value: string) => void;
}

interface VariableInfoProps {
    name: string;
    description: string;
}

function VariableInfo({ name, description }: VariableInfoProps) {
    return (
        <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-2 text-xs py-1">
            <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-primary shrink-0 w-fit">{`{{${name}}}`}</code>
            <span className="text-muted-foreground">{description}</span>
        </div>
    );
}

/**
 * 修改提示词前的警告框。
 *
 * ⚠️ 定义在**模块级**，不能挪进 `PromptSettings` 里 —— 在组件内部定义组件，
 *    每次渲染都会造出一个新的组件类型，React 会当成"换了个组件"而把它内部
 *    的 state 全清掉（eslint 的 `react-hooks/static-components` 就是拦这个的）。
 */
function WarningBox({ caution, warning }: { caution: string; warning: string }) {
    return (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-3 flex items-start gap-3 text-amber-900 text-sm mb-4">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
            <div className="space-y-1">
                <p className="font-medium">{caution}</p>
                <p className="text-amber-800/90 text-xs">{warning}</p>
            </div>
        </div>
    );
}

export function PromptSettings({ config, onUpdate }: PromptSettingsProps) {
    const { t } = useLanguage();

    /**
     * 【2026-10-24 空空】三个子页 ⇒ 一个下拉。
     *
     * 原来那三个横向标签在手机上会挤成一团、字压字（"题目分析提示词"七个字
     * 塞进三分之一屏宽）。改成下拉之后，屏幕上永远只出现"当前在编的那一份"，
     * 地方只占一块，也不用再横着划。
     */
    const [kind, setKind] = useState<PromptKind>('analyze');

    const defaultValueOf = (type: PromptKind): string =>
        type === 'analyze'
            ? DEFAULT_ANALYZE_TEMPLATE
            : type === 'similar'
              ? DEFAULT_SIMILAR_TEMPLATE
              : DEFAULT_INSIGHTS_TEMPLATE;

    /**
     * 文本框里显示什么 —— **直接读 config，不留本地副本**。
     *
     * `onUpdate` 是即时回写 config 的，所以这里不用 state，也就不需要一个
     * effect 去"把 config 同步进 state"。那种写法每次输入都会先落盘再同步回来，
     * 既多一轮渲染，又会在清空时把默认值又填回去（见下）。
     *
     * ⚠️ 用 `??` 而不是 `||`：配置里存 `''` 的意思是"这份用默认模板"，
     *    它是个**合法的、用户可以选择的值**；用 `||` 会把 `''` 也吞掉，
     *    于是用户根本没法把框清空。
     */
    const templateOf = (type: PromptKind): string =>
        config.prompts?.[type] ?? defaultValueOf(type);

    const titleOf = (type: PromptKind): string =>
        type === 'analyze'
            ? (t.settings?.prompts?.customAnalysis || "Custom Analysis Template")
            : type === 'similar'
              ? (t.settings?.prompts?.customSimilar || "Custom Similar Question Template")
              : (t.settings?.prompts?.customInsights || "日积月累 · 整理提示词");

    const labelOf = (type: PromptKind): string =>
        type === 'analyze'
            ? (t.settings?.prompts?.analysisTab || "Analysis Prompt")
            : type === 'similar'
              ? (t.settings?.prompts?.similarTab || "Similar Question Prompt")
              : (t.settings?.prompts?.insightsTab || "日积月累提示词");

    /**
     * 【2026-10-24】「重置」= 把这份存成**空**，而不是把默认模板抄一份进去。
     *
     * 差别在以后：下游读模板时是 `customTemplate || DEFAULT_XXX`
     * （见 `lib/ai/prompts.ts`），空串就等于"用默认"。存空 ⇒ 以后默认模板
     * 升级了，他这份会跟着长；存全文 ⇒ 被钉死在今天这一版，再也不会更新。
     */
    const handleReset = (type: PromptKind) => {
        if (!confirm(t.settings?.prompts?.resetConfirm || "Are you sure you want to reset to default?")) return;
        onUpdate(type, '');
    };

    /** 每份提示词能用的变量不一样 —— 跟着选中的那份走 */
    const varsOf = (type: PromptKind) => {
        const v = t.settings?.prompts?.vars;
        if (type === 'analyze') {
            return [
                { name: 'language_instruction', description: v?.languageInstruction || "Injects instructions based on target language (e.g., keep English questions in English but analysis in Chinese)." },
                { name: 'knowledge_points_list', description: v?.knowledgePointsList || "Injects the standard list of knowledge point tags for the specific subject." },
                { name: 'provider_hints', description: v?.providerHints || "System-injected hints (e.g., enforcing JSON format)." },
            ];
        }
        if (type === 'similar') {
            return [
                { name: 'difficulty_level', description: v?.difficultyLevel || "Target difficulty level." },
                { name: 'difficulty_instruction', description: v?.difficultyInstruction || "Specific writing instructions for the target difficulty." },
                { name: 'original_question', description: v?.originalQuestion || "The full text of the original question." },
                { name: 'knowledge_points', description: v?.knowledgePoints || "List of knowledge points to test." },
                { name: 'language_instruction', description: v?.languageInstructionShort || "Language formatting instructions." },
            ];
        }
        return [
            { name: 'raw_content', description: "她写/记录的内容（原文，最多取 4000 字）" },
            { name: 'question_text', description: "关联的题干（没关联时是占位文字）" },
            { name: 'mistake_reason', description: "错因（8 种之一，没打错因时是占位文字）" },
            { name: 'mistake_analysis', description: "错因分析（可空）" },
            { name: 'subject', description: "学科（当前未传，恒为占位）" },
            { name: 'language_instruction', description: "按目标语言注入的指令" },
        ];
    };

    return (
        <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
            {/* 下拉选哪一份，下面永远只显示一份 —— 手机上不会再把三个标签挤成一团 */}
            <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                    {t.settings?.prompts?.selectLabel || "选择要编辑的提示词"}
                </Label>
                <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as PromptKind)}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                    {KINDS.map((k) => (
                        <option key={k} value={k}>{labelOf(k)}</option>
                    ))}
                </select>
            </div>

            <div className="space-y-4">
                <div className="flex justify-between items-center gap-2">
                    <Label className="text-base font-semibold">{titleOf(kind)}</Label>
                    <Button variant="outline" size="sm" onClick={() => handleReset(kind)}>
                        <RotateCcw className="w-4 h-4 mr-2" />
                        {t.settings?.prompts?.reset || "Reset Default"}
                    </Button>
                </div>

                <WarningBox
                    caution={t.settings?.prompts?.caution || "Modify with Caution"}
                    warning={t.settings?.prompts?.warning || "Variables in {{brackets}} are used to inject dynamic content. Please preserve these variables, otherwise the AI providing may fail to get question context or return invalid formats."}
                />

                {/* 只有日积月累这份有"纸面格式"的硬要求 —— 它会真的印到纸上 */}
                {kind === 'insights' && (
                    <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground leading-relaxed">
                        输出必须符合纸面格式：第一行 #### + emoji + 不超过 12 个汉字的概括；正文不超过 120 字；
                        AI 的补充写成 &gt; *AI: …*（没有就不写）。
                        <br />
                        ⚠️ 结构由程序再兜一次（写错标题级别、写成 **AI:** 都会被自动纠正）；
                        但内容好不好只能靠这份提示词。
                    </div>
                )}

                <div className="space-y-2 border rounded-md p-3 bg-background">
                    <h4 className="text-xs font-medium flex items-center gap-1.5 mb-2">
                        <Info className="h-3.5 w-3.5" />
                        {t.settings?.prompts?.variables || "Available Variables"}
                    </h4>
                    <div className="space-y-1.5">
                        {varsOf(kind).map((v) => (
                            <VariableInfo key={v.name} name={v.name} description={v.description} />
                        ))}
                    </div>
                </div>

                {/*
                  ⚠️ placeholder 只放一句短话，**不能放默认模板全文** ——
                     默认模板是几百行，一旦框被清空，满屏都是灰色占位字，
                     看起来像内容还在，实际一个字都没存。
                */}
                {templateOf(kind) === '' && (
                    <p className="text-xs text-muted-foreground">
                        框里空着 ⇒ 用默认模板（会跟着软件升级走）。直接写就会覆盖它。
                    </p>
                )}
                <Textarea
                    value={templateOf(kind)}
                    onChange={(e) => onUpdate(kind, e.target.value)}
                    className="font-mono text-xs min-h-[400px]"
                    placeholder="留空 = 使用默认模板"
                />
            </div>
        </div>
    );
}
