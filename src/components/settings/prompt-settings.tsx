"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AppConfig } from "@/types/api";
import { DEFAULT_ANALYZE_TEMPLATE, DEFAULT_SIMILAR_TEMPLATE, DEFAULT_INSIGHTS_TEMPLATE } from "@/lib/ai/prompts";
import { RotateCcw, AlertTriangle, Info } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

type PromptKind = 'analyze' | 'similar' | 'insights';

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

export function PromptSettings({ config, onUpdate }: PromptSettingsProps) {
    const { language, t } = useLanguage();
    const [analyzeTemplate, setAnalyzeTemplate] = useState("");
    const [similarTemplate, setSimilarTemplate] = useState("");
    const [insightsTemplate, setInsightsTemplate] = useState("");

    useEffect(() => {
        setAnalyzeTemplate(config.prompts?.analyze || DEFAULT_ANALYZE_TEMPLATE);
        setSimilarTemplate(config.prompts?.similar || DEFAULT_SIMILAR_TEMPLATE);
        setInsightsTemplate(config.prompts?.insights || DEFAULT_INSIGHTS_TEMPLATE);
    }, [config.prompts]);

    const handleReset = (type: PromptKind) => {
        if (!confirm(t.settings?.prompts?.resetConfirm || "Are you sure you want to reset to default?")) return;

        const defaultValue =
            type === 'analyze'
                ? DEFAULT_ANALYZE_TEMPLATE
                : type === 'similar'
                  ? DEFAULT_SIMILAR_TEMPLATE
                  : DEFAULT_INSIGHTS_TEMPLATE;
        if (type === 'analyze') {
            setAnalyzeTemplate(defaultValue);
        } else if (type === 'similar') {
            setSimilarTemplate(defaultValue);
        } else {
            setInsightsTemplate(defaultValue);
        }
        onUpdate(type, defaultValue);
    };

    const handleChange = (type: PromptKind, value: string) => {
        if (type === 'analyze') {
            setAnalyzeTemplate(value);
        } else if (type === 'similar') {
            setSimilarTemplate(value);
        } else {
            setInsightsTemplate(value);
        }
        onUpdate(type, value);
    };

    const WarningBox = () => (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-3 flex items-start gap-3 text-amber-900 text-sm mb-4">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
            <div className="space-y-1">
                <p className="font-medium">
                    {t.settings?.prompts?.caution || "Modify with Caution"}
                </p>
                <p className="text-amber-800/90 text-xs">
                    {t.settings?.prompts?.warning || "Variables in {{brackets}} are used to inject dynamic content. Please preserve these variables, otherwise the AI providing may fail to get question context or return invalid formats."}
                </p>
            </div>
        </div>
    );

    return (
        <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
            <Tabs defaultValue="analyze" className="w-full">
                <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="analyze">
                        {t.settings?.prompts?.analysisTab || "Analysis Prompt"}
                    </TabsTrigger>
                    <TabsTrigger value="similar">
                        {t.settings?.prompts?.similarTab || "Similar Question Prompt"}
                    </TabsTrigger>
                    <TabsTrigger value="insights">
                        {t.settings?.prompts?.insightsTab || "日积月累提示词"}
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="analyze" className="space-y-4 py-4">
                    <div className="space-y-4">
                        <div className="flex justify-between items-center">
                            <Label className="text-base font-semibold">
                                {t.settings?.prompts?.customAnalysis || "Custom Analysis Template"}
                            </Label>
                            <Button variant="outline" size="sm" onClick={() => handleReset('analyze')}>
                                <RotateCcw className="w-4 h-4 mr-2" />
                                {t.settings?.prompts?.reset || "Reset Default"}
                            </Button>
                        </div>

                        <WarningBox />

                        <div className="space-y-2 border rounded-md p-3 bg-background">
                            <h4 className="text-xs font-medium flex items-center gap-1.5 mb-2">
                                <Info className="h-3.5 w-3.5" />
                                {t.settings?.prompts?.variables || "Available Variables"}
                            </h4>
                            <div className="space-y-1.5">
                                <VariableInfo
                                    name="language_instruction"
                                    description={t.settings?.prompts?.vars?.languageInstruction || "Injects instructions based on target language (e.g., keep English questions in English but analysis in Chinese)."}
                                />
                                <VariableInfo
                                    name="knowledge_points_list"
                                    description={t.settings?.prompts?.vars?.knowledgePointsList || "Injects the standard list of knowledge point tags for the specific subject."}
                                />
                                <VariableInfo
                                    name="provider_hints"
                                    description={t.settings?.prompts?.vars?.providerHints || "System-injected hints (e.g., enforcing JSON format)."}
                                />
                            </div>
                        </div>

                        <Textarea
                            value={analyzeTemplate}
                            onChange={(e) => handleChange('analyze', e.target.value)}
                            className="font-mono text-xs min-h-[400px]"
                            placeholder={DEFAULT_ANALYZE_TEMPLATE}
                        />
                    </div>
                </TabsContent>

                <TabsContent value="similar" className="space-y-4 py-4">
                    <div className="space-y-4">
                        <div className="flex justify-between items-center">
                            <Label className="text-base font-semibold">
                                {t.settings?.prompts?.customSimilar || "Custom Similar Question Template"}
                            </Label>
                            <Button variant="outline" size="sm" onClick={() => handleReset('similar')}>
                                <RotateCcw className="w-4 h-4 mr-2" />
                                {t.settings?.prompts?.reset || "Reset Default"}
                            </Button>
                        </div>

                        <WarningBox />

                        <div className="space-y-2 border rounded-md p-3 bg-background">
                            <h4 className="text-xs font-medium flex items-center gap-1.5 mb-2">
                                <Info className="h-3.5 w-3.5" />
                                {t.settings?.prompts?.variables || "Available Variables"}
                            </h4>
                            <div className="space-y-1.5">
                                <VariableInfo
                                    name="difficulty_level"
                                    description={t.settings?.prompts?.vars?.difficultyLevel || "Target difficulty level."}
                                />
                                <VariableInfo
                                    name="difficulty_instruction"
                                    description={t.settings?.prompts?.vars?.difficultyInstruction || "Specific writing instructions for the target difficulty."}
                                />
                                <VariableInfo
                                    name="original_question"
                                    description={t.settings?.prompts?.vars?.originalQuestion || "The full text of the original question."}
                                />
                                <VariableInfo
                                    name="knowledge_points"
                                    description={t.settings?.prompts?.vars?.knowledgePoints || "List of knowledge points to test."}
                                />
                                <VariableInfo
                                    name="language_instruction"
                                    description={t.settings?.prompts?.vars?.languageInstructionShort || "Language formatting instructions."}
                                />
                            </div>
                        </div>

                        <Textarea
                            value={similarTemplate}
                            onChange={(e) => handleChange('similar', e.target.value)}
                            className="font-mono text-xs min-h-[400px]"
                            placeholder={DEFAULT_SIMILAR_TEMPLATE}
                        />
                    </div>
                </TabsContent>

                {/* ═══ 【2026-10-18】日积月累 · 整理提示词 ═══
                    与上面两份的差别要说清：那两份是"固定靶"（输入题干 ⇒ 输出固定结构的标签），
                    这一份是"开放场景"（输入她的碎片 ⇒ 输出一张给人读的小卡片）。
                    ⇒ 规则更多是"风格与边界"（保留她的话 / 错了不要偷偷改 / AI 只补充不复述），
                      而且**一定会反复调**，所以必须能在这里改。 */}
                <TabsContent value="insights" className="space-y-4 py-4">
                    <div className="space-y-4">
                        <div className="flex justify-between items-center">
                            <Label className="text-base font-semibold">
                                {t.settings?.prompts?.customInsights || "日积月累 · 整理提示词"}
                            </Label>
                            <Button variant="outline" size="sm" onClick={() => handleReset('insights')}>
                                <RotateCcw className="w-4 h-4 mr-2" />
                                {t.settings?.prompts?.reset || "Reset Default"}
                            </Button>
                        </div>

                        <WarningBox />

                        <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground leading-relaxed">
                            输出必须符合纸面格式：第一行 #### + emoji + 不超过 12 个汉字的概括；正文不超过 120 字；
                            AI 的补充写成 &gt; *AI: …*（没有就不写）。
                            <br />
                            ⚠️ 结构由程序再兜一次（写错标题级别、写成 **AI:** 都会被自动纠正）；
                            但内容好不好只能靠这份提示词。
                        </div>

                        <div className="space-y-2 border rounded-md p-3 bg-background">
                            <h4 className="text-xs font-medium flex items-center gap-1.5 mb-2">
                                <Info className="h-3.5 w-3.5" />
                                {t.settings?.prompts?.variables || "Available Variables"}
                            </h4>
                            <div className="space-y-1.5">
                                <VariableInfo name="raw_content" description="她写/记录的内容（原文，最多取 4000 字）" />
                                <VariableInfo name="question_text" description="关联的题干（没关联时是占位文字）" />
                                <VariableInfo name="mistake_reason" description="错因（8 种之一，没打错因时是占位文字）" />
                                <VariableInfo name="mistake_analysis" description="错因分析（可空）" />
                                <VariableInfo name="subject" description="学科（当前未传，恒为占位）" />
                                <VariableInfo name="language_instruction" description="按目标语言注入的指令" />
                            </div>
                        </div>

                        <Textarea
                            value={insightsTemplate}
                            onChange={(e) => handleChange('insights', e.target.value)}
                            className="font-mono text-xs min-h-[400px]"
                            placeholder={DEFAULT_INSIGHTS_TEMPLATE}
                        />
                    </div>
                </TabsContent>
            </Tabs>
        </div>
    );
}
