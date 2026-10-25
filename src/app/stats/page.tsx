"use client";

import { useLanguage } from "@/contexts/LanguageContext";
import { WrongAnswerStats } from "@/components/wrong-answer-stats";
import { PracticeStats } from "@/components/practice-stats";
import { ReviewQueueStats } from "@/components/review-queue-stats";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { BarChart3, TrendingUp, Activity, House, Target } from "lucide-react";
import Link from "next/link";

export default function StatsPage() {
    const { t, language } = useLanguage();

    return (
        <div className="container mx-auto px-4 py-8 max-w-6xl">
            <div className="flex items-center gap-4 mb-6">
                <BackButton fallbackUrl="/" />
                <div>
                    <h1 className="text-3xl font-bold flex items-center gap-2">
                        <BarChart3 className="h-8 w-8" />
                        {t.stats?.headerTitle || "Statistics Center"}
                    </h1>
                    <p className="text-muted-foreground mt-1">
                        {t.stats?.headerDesc || "View your learning progress and data analysis"}
                    </p>
                </div>
                <div className="ml-auto flex items-center">
                    <Link href="/">
                        <Button variant="ghost" size="icon">
                            <House className="h-5 w-5" />
                        </Button>
                    </Link>
                </div>
            </div>

            <Tabs defaultValue="wrong" className="w-full">
                <TabsList className="grid w-full grid-cols-3 mb-6">
                    <TabsTrigger value="wrong" className="flex items-center gap-2">
                        <Activity className="h-4 w-4" />
                        {t.wrongAnswerStats?.title || "Wrong Answer Stats"}
                    </TabsTrigger>
                    <TabsTrigger value="practice" className="flex items-center gap-2">
                        <TrendingUp className="h-4 w-4" />
                        {t.stats?.title || "Practice Stats"}
                    </TabsTrigger>
                    {/* 【2026-10-25】"该练什么" —— 现有两个 tab 看的是"积累了多少"，
                        这一个回答"接下来干什么"。 */}
                    <TabsTrigger value="queue" className="flex items-center gap-2">
                        <Target className="h-4 w-4" />
                        {language === "zh" ? "该练什么" : "What to practice"}
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="wrong" className="space-y-4">
                    <WrongAnswerStats />
                </TabsContent>
                <TabsContent value="practice" className="space-y-4">
                    <PracticeStats />
                </TabsContent>
                <TabsContent value="queue" className="space-y-4">
                    <ReviewQueueStats />
                </TabsContent>
            </Tabs>
        </div>
    );
}
