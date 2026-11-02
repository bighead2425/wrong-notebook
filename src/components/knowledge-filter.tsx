"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { apiClient } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { TagPickerDialog, type PickedTag } from "@/components/tag-picker-dialog";
import { Tag as TagIcon } from "lucide-react";
import { inferSubjectFromName } from "@/lib/knowledge-tags";

interface TagTreeNode {
    id: string;
    name: string;
    code: string | null;
    isSystem: boolean;
    children: TagTreeNode[];
}

interface KnowledgeFilterProps {
    gradeSemester?: string;
    tag?: string | null;
    subjectName?: string;
    /** 本内已锁定年级学期（一本教科书=一个本），无需再按年级筛选 */
    hideGrade?: boolean;
    /**
     * 【2026-11-02 真真】**不显示「章节 / 知识点」两个下拉，改成一个树形多选按钮**。
     *
     * 空空原话："目前是有一个章节的下拉框和一个知识点的下拉框，其实用性是比较差的，
     *          我建议将这两个下拉框去掉……换成一个知识点检索按钮，点击这个按钮跳出一个对话框。"
     *
     * 为什么那两个下拉难用：章节下拉是**平铺一长串**，知识点下拉只列出当前章下面的词，
     * 得先选对章才知道有哪些词 —— 顺序卡死，找起来是"猜两次"。
     * 树形对话框是**一次看全**（科目→册→章→节→知识点），还能多选。
     */
    hideChapterTag?: boolean;
    onFilterChange: (filters: {
        gradeSemester?: string;
        chapter?: string;
        tag?: string;
        /** 【2026-11-02】多选知识点（树形对话框选的），与 `tag` 二选一 */
        tagIds?: string[];
    }) => void;
    className?: string;
}

// 年级编号到学期名称的映射 (用于根据用户入学年份计算当前年级)
const EDUCATION_GRADE_MAP: Record<string, number[]> = {
    'primary': [1, 2, 3, 4, 5, 6],
    'junior_high': [7, 8, 9],
    'senior_high': [10, 11, 12],
};

// 年级编号到学期key的映射
// 注意：小学目前数据库中只存储了"一年级"这种粒度，没有分上下册，后续如果有变化需要更新这里
const GRADE_TO_SEMESTERS: Record<number, string[]> = {
    1: ['一年级'],
    2: ['二年级'],
    3: ['三年级'],
    4: ['四年级'],
    5: ['五年级'],
    6: ['六年级'],
    7: ['七年级上', '七年级下', '七年级'], // 兼容可能存在的不同命名
    8: ['八年级上', '八年级下', '八年级'],
    9: ['九年级上', '九年级下', '九年级'],
    10: ['高一上', '高一下', '高一'],
    11: ['高二上', '高二下', '高二'],
    12: ['高三上', '高三下', '高三'],
};

export function KnowledgeFilter({
    gradeSemester: initialGrade,
    tag: initialTag,
    subjectName,
    hideGrade = false,
    hideChapterTag = false,
    onFilterChange,
    className
}: KnowledgeFilterProps) {
    const [gradeSemester, setGradeSemester] = useState<string>(initialGrade || "");
    const [chapter, setChapter] = useState<string>("");
    const [tag, setTag] = useState<string>(initialTag || "");

    // 从数据库加载的标签树
    const [tagTree, setTagTree] = useState<TagTreeNode[]>([]);
    const [loading, setLoading] = useState(true);

    // 用户信息 (教育阶段和入学年份)
    const [userInfo, setUserInfo] = useState<{ educationStage?: string; enrollmentYear?: number }>({});

    // 可用的年级学期选项 (根据用户信息过滤)
    const [availableGrades, setAvailableGrades] = useState<string[]>([]);

    /** 【2026-11-02】树形多选：对话框开关 + 已选（`{id,name}[]`，筛选只用 id） */
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pickedTags, setPickedTags] = useState<PickedTag[]>([]);

    // Sync with props
    useEffect(() => {
        if (initialGrade !== undefined) setGradeSemester(initialGrade);
    }, [initialGrade]);

    useEffect(() => {
        if (initialTag !== undefined) setTag(initialTag || "");
    }, [initialTag]);

    // 计算用户当前年级 (返回原始年级数值，不进行范围截断，以便判断由初升高等情况)
    const calculateCurrentGrade = useCallback((educationStage: string, enrollmentYear: number): number => {
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1; // 1-12

        // 学年从9月开始
        const academicYear = currentMonth >= 9 ? currentYear : currentYear - 1;
        const yearsInSchool = academicYear - enrollmentYear + 1;

        if (educationStage === 'primary') {
            return yearsInSchool;
        } else if (educationStage === 'junior_high') {
            // 初中: 1年级=7, ...
            return yearsInSchool + 6;
        } else if (educationStage === 'senior_high') {
            // 高中: 1年级=10, ...
            return yearsInSchool + 9;
        }
        return 0;
    }, []);

    // 根据用户信息生成可用年级列表
    const generateAvailableGrades = useCallback((educationStage?: string, enrollmentYear?: number): string[] => {
        let grades: number[] = [];

        // 默认: 显示所有年级
        if (!educationStage) {
            grades = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        } else if (educationStage === 'primary') {
            // 小学生: 显示小学全部
            grades = [1, 2, 3, 4, 5, 6];
        } else if (educationStage === 'junior_high') {
            // 初中生: 默认显示初中全部 (7-9)
            grades = [7, 8, 9];

            // 如果有入学年份，且推算年级已达到高中 (>=10)，则追加高中年级
            if (enrollmentYear) {
                const currentGrade = calculateCurrentGrade(educationStage, enrollmentYear);
                if (currentGrade >= 10) {
                    grades.push(10, 11, 12);
                }
            }
        } else if (educationStage === 'senior_high') {
            // 高中生: 仅显示高中全部
            grades = [10, 11, 12];
        } else {
            // 其他情况
            grades = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        }

        // 可以在这里根据 enrollmentYear 做进一步优化，比如高亮当前年级
        // 但目前先返回该阶段的所有年级

        return grades.flatMap(g => GRADE_TO_SEMESTERS[g] || []);
    }, [calculateCurrentGrade]);

    // 加载用户信息和标签树
    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                // 1. 获取用户信息
                const user = await apiClient.get<{ educationStage?: string; enrollmentYear?: number }>('/api/user');
                setUserInfo(user);

                // 2. 生成可用年级
                const grades = generateAvailableGrades(user.educationStage, user.enrollmentYear);
                setAvailableGrades(grades);

                // 3. 获取标签树 (所有科目)
                const subject = subjectName ? inferSubjectFromName(subjectName) : 'math';
                // 移除仅 math 的限制，尝试获取当前科目的标签
                try {
                    const data = await apiClient.get<{ tags: TagTreeNode[] }>(`/api/tags?subject=${subject}`);
                    setTagTree(data.tags);
                } catch (e) {
                    console.warn(`Failed to fetch tags for subject ${subject}`, e);
                    setTagTree([]);
                }
            } catch (error) {
                console.error("Failed to load filter data:", error);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, [subjectName, generateAvailableGrades]);

    const handleGradeChange = (val: string) => {
        setGradeSemester(val);
        setChapter("");
        setTag("");
        onFilterChange({
            gradeSemester: val === "all" ? undefined : val,
            chapter: undefined,
            tag: undefined
        });
    };

    const handleChapterChange = (val: string) => {
        setChapter(val);
        setTag("");
        onFilterChange({
            gradeSemester: gradeSemester === "all" ? undefined : gradeSemester,
            chapter: val === "all" ? undefined : val,
            tag: undefined
        });
    };

    const handleTagChange = (val: string) => {
        setTag(val);
        onFilterChange({
            gradeSemester: gradeSemester === "all" ? undefined : gradeSemester,
            chapter: chapter === "all" ? undefined : chapter,
            tag: val === "all" ? undefined : val
        });
    };

    // 从标签树中找到当前年级节点
    const currentGradeNode = tagTree.find(node => node.name === gradeSemester);
    // 未选年级（含本内隐藏年级的情况）时把各年级下的章节平铺，
    // 否则「章节」下拉会被前置条件卡死成永远为空
    const chapters = currentGradeNode
        ? currentGradeNode.children
        : tagTree.flatMap(node => node.children || []);

    // 从标签树中找到当前章节节点
    const currentChapterNode = chapters.find(node => node.name === chapter);

    // 递归获取所有叶子标签
    const getLeafTags = (node: TagTreeNode): string[] => {
        if (node.children.length === 0) return [node.name];
        return node.children.flatMap(child => getLeafTags(child));
    };
    // 去重标签，避免 React key 冲突
    const tags = currentChapterNode
        ? [...new Set(getLeafTags(currentChapterNode))]
        : [...new Set(chapters.flatMap(c => getLeafTags(c)))];

    // 过滤可用年级 (只显示数据库中存在的)
    // 对于非数学科目，如果不按照年级结构存储，这里可能会被清空
    // 我们检查 tagTree 的顶层节点是否包含 gradeSemester
    const filteredGrades = availableGrades.filter(g =>
        tagTree.some(node => node.name === g)
    );

    // 如果过滤后没有年级（可能是因为该科目标签结构不同，比如没有按年级分类），
    // 或者 tagTree 为空，我们至少应该显示 availableGrades 或者不显示
    // 但根据现在的 seed 脚本，所有科目都是按年级分类的，所以应该没问题。

    return (
        <div className={`flex gap-2 ${className}`}>
            {!hideGrade && (
                <Select value={gradeSemester} onValueChange={handleGradeChange} disabled={loading}>
                    <SelectTrigger className="w-[140px]">
                        <SelectValue placeholder="年级/学期" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">全部年级</SelectItem>
                        {filteredGrades.map(gs => (
                            <SelectItem key={gs} value={gs}>{gs}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}

            {/**
             * 【2026-11-02】两个下拉换成**一个树形多选按钮**（`hideChapterTag` 时）。
             * 旧的两个下拉保留在 else 分支里 —— 万一别处还想用，不删。
             */}
            {hideChapterTag ? (
                <>
                    <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                        <TagIcon className="mr-1.5 h-3.5 w-3.5" />
                        知识点检索
                        {pickedTags.length > 0 && ` · ${pickedTags.length}`}
                    </Button>
                    <TagPickerDialog
                        open={pickerOpen}
                        onOpenChange={setPickerOpen}
                        multiple
                        /** 学科自动展开：`subjectName` 是中文名，对话框要 key（math/chinese…） */
                        defaultSubject={subjectName ? inferSubjectFromName(subjectName) ?? undefined : undefined}
                        initialPicked={pickedTags}
                        onPick={(picked) => {
                            setPickedTags(picked);
                            /**
                             * 不选 = 不筛（他明确要求"没有知识点被选中点击确定，意为不进行筛选，全部显示"）。
                             * 传空数组而不是 `undefined`，让 `ErrorList` 那边能明确知道"这次是清空"。
                             */
                            onFilterChange({ gradeSemester, tagIds: picked.map((p) => p.id) });
                        }}
                    />
                </>
            ) : (
                <>
                    <Select value={chapter} onValueChange={handleChapterChange} disabled={loading}>
                        <SelectTrigger className="w-[180px]">
                            <SelectValue placeholder="章节" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">全部章节</SelectItem>
                            {chapters.map(c => (
                                <SelectItem key={c.id} value={c.name}>
                                    {c.name.replace(/^第\d+章\s*/, '')}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Select value={tag} onValueChange={handleTagChange} disabled={loading}>
                        <SelectTrigger className="w-[140px]">
                            <SelectValue placeholder="知识点" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">全部知识点</SelectItem>
                            {tags.map(t => (
                                <SelectItem key={t} value={t}>{t}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </>
            )}
        </div>
    );
}
