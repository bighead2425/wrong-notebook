"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BookOpen, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface NotebookCardProps {
    id: string;
    displayName: string;      // 自由显示名，如 "小五上数学"
    errorCount: number;
    meta?: string;            // 副标题，如 "五年级 · 上 · 数学"
    archived?: boolean;       // 已归档本置灰（H2 四分法）
    onClick: () => void;
    onRename?: () => void;
    onDelete?: (id: string) => void;
    itemLabel?: string;
}

export function NotebookCard({ id, displayName, errorCount, meta, archived = false, onClick, onRename, onDelete, itemLabel = "items" }: NotebookCardProps) {
    return (
        <Card
            className={`cursor-pointer hover:border-primary/50 transition-colors relative group ${archived ? "opacity-60" : ""}`}
            onClick={onClick}
        >
            <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                        <BookOpen className="h-5 w-5 text-primary shrink-0" />
                        <div className="min-w-0">
                            <CardTitle className="text-lg truncate">{displayName}</CardTitle>
                            {meta && (
                                <p className="text-xs text-muted-foreground truncate">{meta}</p>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        {onRename && (
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                className="h-8 w-8"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onRename();
                                }}
                            >
                                <Pencil className="h-4 w-4" />
                            </Button>
                        )}
                        {onDelete && (
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                className="h-8 w-8"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDelete(id);
                                }}
                            >
                                <Trash2 className={`h-4 w-4 ${errorCount > 0 ? "text-muted-foreground" : "text-destructive"}`} />
                            </Button>
                        )}
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                <div className="flex items-center gap-2">
                    <Badge variant="secondary">
                        {errorCount} {itemLabel}
                    </Badge>
                </div>
            </CardContent>
        </Card>
    );
}
