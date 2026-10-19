/**
 * Shared AI prompt templates
 * This module provides centralized prompt management
 */

/**
 * 将 gradeSemester 字符串转换为年级数字（用于标签过滤）
 * 支持格式：初一/七年级/7年级/小学三年级/高一 等
 * @returns 7-12 或 null（无法识别时）
 */
export function gradeSemesterToGradeNumber(gradeSemester: string): 7 | 8 | 9 | 10 | 11 | 12 | null {
  if (!gradeSemester) return null;
  const gs = gradeSemester.toLowerCase();

  // 小学：primary_3 → 不映射到 7-12，返回 null
  if (gs.startsWith('primary') || gs.includes('小学') || gs.match(/[一二三四五六]年级/)) {
    return null;
  }

  // 初中
  if (gs.includes('初一') || gs.includes('七年级') || gs.includes('7年级') || gs === 'junior_high_1') return 7;
  if (gs.includes('初二') || gs.includes('八年级') || gs.includes('8年级') || gs === 'junior_high_2') return 8;
  if (gs.includes('初三') || gs.includes('九年级') || gs.includes('9年级') || gs === 'junior_high_3') return 9;

  // 高中
  if (gs.includes('高一') || gs.includes('10年级') || gs === 'senior_high_1') return 10;
  if (gs.includes('高二') || gs.includes('11年级') || gs === 'senior_high_2') return 11;
  if (gs.includes('高三') || gs.includes('12年级') || gs === 'senior_high_3') return 12;

  return null;
}

/**
 * 将 gradeSemester 字符串转换为中文年级显示名称
 * 用于注入到 AI 提示词中
 * @returns 中文年级名（如"小学三年级"、"初中二年级"）或 null
 */
export function gradeSemesterToDisplayName(gradeSemester: string): string | null {
  if (!gradeSemester) return null;
  const gs = gradeSemester;

  // 小学
  const primaryMatch = gs.match(/primary[_\s]?(\d)/);
  if (primaryMatch) {
    const numMap: Record<string, string> = { '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六' };
    return `小学${numMap[primaryMatch[1]] || primaryMatch[1]}年级`;
  }
  if (gs.includes('小学')) {
    // "小学三年级" 格式，直接返回年级部分
    const m = gs.match(/小学([一-龥\d]+年级?)/);
    if (m) return `小学${m[1].replace('年级', '')}年级`.replace('小学小学', '小学');
    return gs.replace(/[上下]$/, '').replace(/[，,].*$/, '').trim();
  }
  if (gs.match(/[一二三四五六]年级/) && !gs.includes('初') && !gs.includes('高')) {
    return `小学${gs.replace(/[上下]$/, '').replace(/[，,].*$/, '').trim()}`;
  }

  // 初中
  const juniorMatch = gs.match(/junior_high[_\s]?(\d)/);
  if (juniorMatch) {
    const numMap: Record<string, string> = { '1': '一', '2': '二', '3': '三' };
    return `初中${numMap[juniorMatch[1]] || juniorMatch[1]}年级`;
  }
  if (gs.includes('初一')) return '初中一年级';
  if (gs.includes('初二')) return '初中二年级';
  if (gs.includes('初三')) return '初中三年级';
  if (gs.includes('七年级')) return '初中一年级';
  if (gs.includes('八年级')) return '初中二年级';
  if (gs.includes('九年级')) return '初中三年级';

  // 高中
  const seniorMatch = gs.match(/senior_high[_\s]?(\d)/);
  if (seniorMatch) {
    const numMap: Record<string, string> = { '1': '一', '2': '二', '3': '三' };
    return `高中${numMap[seniorMatch[1]] || seniorMatch[1]}年级`;
  }
  if (gs.includes('高一')) return '高中一年级';
  if (gs.includes('高二')) return '高中二年级';
  if (gs.includes('高三')) return '高中三年级';

  return null;
}

/**
 * 生成学历约束指令
 * @param gradeSemester - 年级学期字符串
 * @returns 约束指令字符串，无学历信息时返回空字符串
 */
export function generateGradeInstruction(gradeSemester?: string | null): string {
  if (!gradeSemester) return '';
  const displayName = gradeSemesterToDisplayName(gradeSemester);
  if (!displayName) return '';

  return `\n【学历约束】\n本题目标年级：${displayName}\n请严格使用该年级课程标准范围内的方法解答，禁止使用超纲知识。\n`;
}

/**
 * Options for customizing prompts
 */
export interface PromptOptions {
  providerHints?: string; // Provider-specific instructions
  additionalTags?: {
    subject: string;
    tags: string[];
  }[];
  customTemplate?: string; // Custom template to override default
  // Pre-fetched tags from database (optional, per subject)
  prefetchedMathTags?: string[];
  prefetchedPhysicsTags?: string[];
  prefetchedChemistryTags?: string[];
  prefetchedBiologyTags?: string[];
  prefetchedEnglishTags?: string[];
}

export const DEFAULT_ANALYZE_TEMPLATE = `【角色与核心任务 (ROLE AND CORE TASK)】
你是一位世界顶尖的、经验丰富的、专业的跨学科考试分析专家（Interdisciplinary Exam Analysis Expert）。你的核心任务是极致准确地分析用户提供的考试题目图片，全面理解所有文本、图表和隐含约束，并提供一个完整、高度结构化且专业的解决方案。

{{language_instruction}}

【核心输出要求 (OUTPUT REQUIREMENTS)】
你的响应输出**必须严格遵循以下自定义标签格式**。**严禁**使用 JSON 或 Markdown 代码块。**严禁**对 LaTeX 公式中的反斜杠进行二次转义（如 "\\frac" 是错误的，必须是 "\frac"）。

请严格按照以下结构输出内容：

<subject>
在此处填写学科，必须是以下之一："数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"。
</subject>

<knowledge_points>
在此处填写知识点，使用逗号分隔，例如：知识点1, 知识点2, 知识点3
</knowledge_points>

<requires_image>
判断这道题是否需要依赖图片才能正确解答。如果题目包含几何图形、函数图像、实验装置图、电路图等必须看图才能理解的内容，填写 true；如果只需要文字描述即可理解（如英语题、纯文字数学题），填写 false。
</requires_image>

<wrong_answer_text>
如果图片中包含学生已经写出的错误解答、错误步骤、草稿或错误答案，请尽量按原样摘录；如果没有看到学生错误解答，请留空。
</wrong_answer_text>

<mistake_status>
填写以下值之一：wrong_attempt（图片中有错误解答或错误步骤）、not_attempted（没有错误解答，像是完全不会做或未作答）、unknown（无法判断）。
</mistake_status>

<mistake_analysis>
如果图片中包含错误解答，请分析错误可能发生在哪一步、为什么错、导致了什么后果；如果没有错误解答，请留空。
</mistake_analysis>

<question_text>
在此处填写题目的完整文本。使用 Markdown 格式。所有数学公式使用 LaTeX 符号（行内 $...$，块级 $$...$$）。

【表格处理规则】
如果图片中包含表格，必须完整转录表格内容，遵循以下原则：

1. **标准表格**：使用 Markdown 表格语法
   | 列标题1 | 列标题2 | 列标题3 |
   |---------|---------|---------|
   | 数据1   | 数据2   | 数据3   |

2. **复杂表格**（合并单元格/多级表头/不规则布局）：
   - 优先尝试用 Markdown 表格近似表示
   - 如果 Markdown 无法准确表达，在表格前用文字说明结构，然后用简化的 Markdown 表格 + 注释
   - 示例：
     > 注：第1行为主标题，横跨3列；第2-3行为数据行

     | 项目 | 数值A | 数值B |
     |------|-------|-------|
     | 测试1 | 10 | 20 |
     | 测试2 | 15 | 25 |

3. **表格完整性要求**：
   - 必须转录所有单元格内容（包括空单元格用 - 或空格表示）
   - 保留表格标题、单位、注释
   - 保留数据的对齐关系和分组信息
   - 表格中的数学公式使用 LaTeX 语法

4. **表格上下文**：
   - 如果表格有标题或编号（如"表1"），保留在表格前
   - 如果表格后有注释或说明，保留在表格后
   - 保持表格在题目中的位置关系

5. **特殊情况处理**：
   - 图表混合：如果表格旁边有图形，用文字说明位置关系
   - 手写表格：尽力识别手写内容，不确定的用 [?] 标注
   - 模糊表格：如果表格不清晰，在表格前注明"（表格内容可能不完整）"
</question_text>

<answer_text>
在此处填写正确答案。使用 Markdown 和 LaTeX 符号。如果答案包含表格，遵循上述【表格处理规则】。
</answer_text>

<analysis>
在此处填写详细的步骤解析。
* 必须使用简体中文。
* **直接使用标准的 LaTeX 符号**（如 $\frac{1}{2}$），**不要**进行 JSON 转义（不要写成 \\frac）。
* 如果解析过程需要表格（如列表对比、分步计算表），遵循上述【表格处理规则】。
</analysis>

【知识点标签列表（KNOWLEDGE POINT LIST）】
{{knowledge_points_list}}

【标签使用规则 (TAG RULES)】
- 标签必须与题目实际考查的知识点精准匹配。
- 每题最多 5 个标签。

【!!! 关键格式与内容约束 (CRITICAL RULES) !!!】
1. **格式严格**：必须严格包含上述 9 个 XML 标签，除此之外不要输出任何其他“开场白”或“结束语”。
2. **纯文本**：内容作为纯文本处理，**不要转义反斜杠**。
3. **内容完整**：如果包含子问题，请在 question_text 中完整列出。
4. **禁止图片**：严禁包含任何图片链接或 markdown 图片语法。

{{grade_instruction}}
{{provider_hints}}`;

export const DEFAULT_SIMILAR_TEMPLATE = `你是一位资深的K12教育题目生成专家，具备跨学科的题目创作能力。你的核心任务是**根据以下原题和知识点，举一反三生成高质量教学题目**，帮助学生巩固知识并拓展解题思路。
### 角色定义
1. **学科全能专家**  
   - 精通K12阶段所有学科（数学/语文/英语/物理/化学/生物/历史/地理/政治）
   - 熟悉各年级课程标准与知识点分布
   - 能准确识别题目考察的核心能力点（计算/推理/分析/应用/创新）
2. **题目变异大师**  
   - 掌握12种变式技法：条件替换/情境迁移/问题转化/数据重构/图形变形/角色反转/跨学科融合/难度阶梯/开放拓展/陷阱设计/逆向思维/生活应用
   - 确保变式题目保持原题核心考点，改变题目表现形式
3. **学情分析师**  
   - 预判学生易错点（认知盲区/概念混淆/计算失误/审题偏差）
   - 在变式题目中针对性强化易错点训练
### 执行流程
1. **接收任务**  
	原题: "{{original_question}}"
	{{language_instruction}}
	DIFFICULTY LEVEL: {{difficulty_level}}
	{{difficulty_instruction}}
	Knowledge Points: {{knowledge_points}}  
2. **解构分析**  
   - 提取核心考点与能力要求
   - 分析题目陷阱与解题路径
3.  **质量管控**  
   - 确保每道题：  
     ✓ 覆盖相同核心知识点  
     ✓ 保持解题逻辑一致性  
     ✓ 答案唯一且可验证  
     ✓ 无知识性错误
### 输出规范
你的响应输出**必须严格遵循以下自定义标签格式**。**严禁**使用 JSON 或 Markdown 代码块。**严禁**返回 \`\`\`json ... \`\`\`。

请严格按照以下结构输出内容（不要包含任何其他文字）：

<question_text>
在此处填写新生成的题目文本。包含选项（如果是选择题）。
</question_text>

<answer_text>
在此处填写新题目的正确答案。
</answer_text>

<analysis>
在此处填写新题目的详细解析。
* 必须使用简体中文。
* **直接使用标准的 LaTeX 符号**（如 $\frac{1}{2}$），**不要**进行 JSON 转义。
</analysis>

###关键格式与内容约束 (CRITICAL RULES) !!!
1. **纯文本**：内容作为纯文本处理，**不要转义反斜杠**。

{{grade_instruction}}
{{provider_hints}}`;

/**
 * Helper to replace placeholders in template
 */
function replaceVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] || "";
  });
}

/**
 * 获取指定年级的累进数学标签
 * 初一(7)：只包含七年级标签
 * 初二(8)：包含七年级+八年级标签
 * 初三(9)：包含七年级+八年级+九年级标签
 * 高一(10)：只包含高一标签（不含初中）
 * 高二(11)：包含高一+高二标签
 * 高三(12)：包含高一+高二+高三标签
 * @param grade - 年级 (7-9:初中, 10-12:高中) 或 null
 * @returns 标签数组
 */
/**
 * 获取指定年级的数学标签
 * 必须由调用方预先从数据库获取标签并通过 prefetchedTags 传入
 * @param grade - 年级（已弃用，保留接口兼容）
 * @param prefetchedTags - 从数据库预获取的标签数组
 * @returns 标签数组
 */
export function getMathTagsForGrade(
  grade: 7 | 8 | 9 | 10 | 11 | 12 | null,
  prefetchedTags?: string[]
): string[] {
  // 必须使用预获取的数据库标签
  if (prefetchedTags && prefetchedTags.length > 0) {
    return prefetchedTags;
  }

  // 如果没有预获取标签，返回空数组（AI 将自由标注）
  console.warn('[prompts] No prefetched tags provided, AI will tag freely');
  return [];
}

/**
 * Generates the analyze image prompt
 * @param language - Target language for analysis ('zh' or 'en')
 * @param grade - Optional grade level (7-9:初中, 10-12:高中) for cumulative tag filtering
 * @param options - Optional customizations
 */
export function generateAnalyzePrompt(
  language: 'zh' | 'en',
  grade?: 7 | 8 | 9 | 10 | 11 | 12 | null,
  subject?: string | null,
  options?: PromptOptions,
  gradeSemester?: string | null
): string {
  const langInstruction = language === 'zh'
    ? "IMPORTANT: For the 'analysis' field, use Simplified Chinese. For 'questionText' and 'answerText', YOU MUST USE THE SAME LANGUAGE AS THE ORIGINAL QUESTION. If the original question is in Chinese, the new question MUST be in Chinese. If the original is in English, keep it in English. If the original question is in English, the new 'questionText' and 'answerText' MUST be in English, but the 'analysis' MUST be in Simplified Chinese (to help the student understand). "
    : "Please ensure all text fields are in English.";

  // 获取各学科标签（优先使用预获取的数据库标签）
  const mathTags = getMathTagsForGrade(grade || null, options?.prefetchedMathTags);
  const mathTagsString = mathTags.length > 0 ? mathTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  const physicsTags = options?.prefetchedPhysicsTags || [];
  const physicsTagsString = physicsTags.length > 0 ? physicsTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  const chemistryTags = options?.prefetchedChemistryTags || [];
  const chemistryTagsString = chemistryTags.length > 0 ? chemistryTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  const biologyTags = options?.prefetchedBiologyTags || [];
  const biologyTagsString = biologyTags.length > 0 ? biologyTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  const englishTags = options?.prefetchedEnglishTags || [];
  const englishTagsString = englishTags.length > 0 ? englishTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  // 根据科目决定显示哪些标签（节省 token，提高准确性）
  let tagsSection = "";

  if (subject === '数学') {
    tagsSection = `**数学标签 (Math Tags):**
使用人教版课程大纲中的**精确标签名称**，可选标签如下：
${mathTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else if (subject === '物理') {
    tagsSection = `**物理标签 (Physics Tags):**
使用课程大纲中的**精确标签名称**，可选标签如下：
${physicsTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else if (subject === '化学') {
    tagsSection = `**化学标签 (Chemistry Tags):**
使用课程大纲中的**精确标签名称**，可选标签如下：
${chemistryTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else if (subject === '生物') {
    tagsSection = `**生物标签 (Biology Tags):**
使用课程大纲中的**精确标签名称**，可选标签如下：
${biologyTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else if (subject === '英语') {
    tagsSection = `**英语标签 (English Tags):**
使用课程大纲中的**精确标签名称**，可选标签如下：
${englishTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else {
    // 未知科目：显示所有标签让 AI 判断
    tagsSection = `**数学标签 (Math Tags):**
${mathTagsString}

**物理标签 (Physics Tags):**
${physicsTagsString}

**化学标签 (Chemistry Tags):**
${chemistryTagsString}

**生物标签 (Biology Tags):**
${biologyTagsString}

**英语标签 (English Tags):**
${englishTagsString}`;
  }

  const template = options?.customTemplate || DEFAULT_ANALYZE_TEMPLATE;

  return replaceVariables(template, {
    language_instruction: langInstruction,
    knowledge_points_list: tagsSection,
    grade_instruction: generateGradeInstruction(gradeSemester),
    provider_hints: options?.providerHints || ''
  }).trim();
}

/**
 * Generates the "similar question" prompt
 * @param language - Target language ('zh' or 'en')
 * @param originalQuestion - The original question text
 * @param knowledgePoints - Knowledge points to test
 * @param difficulty - Difficulty level
 * @param options - Optional customizations
 */
export function generateSimilarQuestionPrompt(
  language: 'zh' | 'en',
  originalQuestion: string,
  knowledgePoints: string[],
  difficulty: 'easy' | 'medium' | 'hard' | 'harder' = 'medium',
  options?: PromptOptions,
  gradeSemester?: string | null
): string {
  const langInstruction = language === 'zh'
    ? "IMPORTANT: Provide the output based on the 'Original Question' language. If the original question is in English, the new 'questionText' and 'answerText' MUST be in English, but the 'analysis' MUST be in Simplified Chinese (to help the student understand). If the original is in Chinese, everything MUST be in Simplified Chinese."
    : "Please ensure the generated question is in English.";

  const difficultyInstruction = {
    'easy': "Make the new question EASIER than the original. Use simpler numbers and more direct concepts.",
    'medium': "Keep the difficulty SIMILAR to the original question.",
    'hard': "Make the new question HARDER than the original. Combine multiple concepts or use more complex numbers.",
    'harder': "Make the new question MUCH HARDER (Challenge Level). Require deeper understanding and multi-step reasoning."
  }[difficulty];

  const template = options?.customTemplate || DEFAULT_SIMILAR_TEMPLATE;

  return replaceVariables(template, {
    difficulty_level: difficulty.toUpperCase(),
    difficulty_instruction: difficultyInstruction,
    language_instruction: langInstruction,
    original_question: originalQuestion.replace(/"/g, '\\"').replace(/\n/g, '\\n'), // Escape for template safety
    knowledge_points: knowledgePoints.join(", "),
    grade_instruction: generateGradeInstruction(gradeSemester),
    provider_hints: options?.providerHints || ''
  }).trim();
}

/**
 * 重新解题提示词模板
 * 用于根据校正后的题目文本重新生成答案和解析
 */
export const DEFAULT_REANSWER_TEMPLATE = `【角色与核心任务 (ROLE AND CORE TASK)】
你是一位经验丰富的专业教师。用户已经提供了一道**校正后的题目文本**，请你为这道题目提供正确的答案和详细的解析。

{{language_instruction}}

【题目内容 (QUESTION)】
{{question_text}}

【学科提示 (SUBJECT HINT)】
{{subject_hint}}

【核心输出要求 (OUTPUT REQUIREMENTS)】
你的响应输出**必须严格遵循以下自定义标签格式**。**严禁**使用 JSON 或 Markdown 代码块。

请严格按照以下结构输出内容（不要包含任何其他文字）：

<answer_text>
在此处填写正确答案。使用 Markdown 和 LaTeX 符号。
</answer_text>

<analysis>
在此处填写详细的步骤解析。
* 必须使用简体中文。
* **直接使用标准的 LaTeX 符号**（如 $\\frac{1}{2}$），**不要**进行 JSON 转义。
* 解析要清晰、完整，适合学生理解。
</analysis>

<knowledge_points>
在此处填写知识点，使用逗号分隔，例如：知识点1, 知识点2, 知识点3
</knowledge_points>

<wrong_answer_text>
请只根据校正后的题目文本和当前图片中可见的学生作答痕迹重新判断学生错误解答。如果当前图片中可见错误解答、错误步骤、草稿或错误答案，请尽量按原样摘录；如果看不到学生作答痕迹，请留空，不要猜测。
</wrong_answer_text>

<mistake_status>
重新判断并填写以下值之一：wrong_attempt（当前题目文本或当前图片中明确有错误解答或错误步骤）、not_attempted（当前图片明确显示未作答或空白）、unknown（看不到学生作答痕迹或无法判断）。不要猜测。
</mistake_status>

<mistake_analysis>
请基于校正后的题目和当前图片中可见的学生作答痕迹重新判断错因。如果有可见错误解答，请分析错误可能发生在哪一步、为什么错、导致了什么后果；如果看不到学生作答痕迹或无法判断，请留空，不要猜测。
</mistake_analysis>

【!!! 关键格式与内容约束 (CRITICAL RULES) !!!】
1. **格式严格**：必须严格包含上述 6 个 XML 标签，不要输出其他内容。
2. **纯文本**：内容作为纯文本处理，**不要转义反斜杠**。
3. **题目不变**：不要修改或重复题目内容，只提供答案和解析。

{{grade_instruction}}
{{provider_hints}}`;

/**
 * 生成重新解题提示词
 * @param language - 语言 ('zh' 或 'en')
 * @param questionText - 校正后的题目文本
 * @param subject - 学科提示（可选）
 * @param options - 自定义选项
 */
export function generateReanswerPrompt(
  language: 'zh' | 'en',
  questionText: string,
  subject?: string | null,
  options?: PromptOptions,
  gradeSemester?: string | null
): string {
  const langInstruction = language === 'zh'
    ? "IMPORTANT: 解析必须使用简体中文。如果题目是英文，答案保持英文，但解析用中文。"
    : "Please ensure all text fields are in English.";

  const subjectHint = subject
    ? `本题学科：${subject}`
    : "请根据题目内容判断学科。";

  const template = options?.customTemplate || DEFAULT_REANSWER_TEMPLATE;

  return replaceVariables(template, {
    language_instruction: langInstruction,
    question_text: questionText,
    subject_hint: subjectHint,
    grade_instruction: generateGradeInstruction(gradeSemester),
    provider_hints: options?.providerHints || ''
  }).trim();
}

/**
 * 【2026-10-04】**回录分析**（深挖纸回录）—— 读孩子手写的反思。
 *
 * 这是"纸回录"的第一步：她在深挖纸正面下半部分手写"我卡在哪"，拍张照；
 * 我们把照片 + 这道题的题干一起交给 AI，让它把她的手写内容整理成一条日积月累。
 *
 * ⚠️ 提示词的三条红线（他反复强调，也是这个功能存在的意义）：
 *   ① **只整理、不编造** —— 只依据照片里她真正写下的字；看不清就说看不清，判不准留空。
 *   ② **保留她的口吻** —— 不改成"标准答案腔"，不加"建议你……"这类说教。
 *   ③ **区分"她的话"与"AI 整理"** —— 所以输出分 `her_words` / `organized` / `unclear`
 *      三段（客户端把 organized 包成斜体批注，见 `lib/recover-analysis.ts` 的 compose）。
 *
 * ⚠️ 题干是当"地图"用的：帮她（其实是帮 AI）对上"她写的是哪一步"，**不是**让它去做题。
 */
export const DEFAULT_RECOVER_ANALYSIS_TEMPLATE = `【角色与核心任务 (ROLE AND CORE TASK)】
你现在在读一个**小学五年级**的孩子在"错题分析纸（深挖纸）"**正面下半部分**手写的反思。
她在那里写的是"我卡在哪 / 我当时是怎么想的 / 我现在明白了什么"。
你的任务是：**把她手写的这几句话读出来、理顺**，作为一条"日积月累"的正文。

{{language_instruction}}

【这道题是什么（已知的上下文，只用来帮你对上她写的步骤）】
{{question_context}}
⚠️ 这段题干只是"地图"：用它判断她写的是哪一步，**不要**替她做题、不要复核题目对错。

【这道题以前记过的日积月累（可能是空的）】
{{previous_insight}}
⚠️ 上面**有内容** ⇒ 说明这道题**以前回录过**，这次要**有机合并**：
   · \`her_words\` **仍然只**输出**这次照片里**她写的那几句 —— **不要把上次的原话抄回来**
     （上次她的话由客户端自己留着并与这次拼接，你只管这次的）；
   · \`organized\` 要把**上次的整理**和**这次的整理**融合成通顺的正文：
     去掉重复、保留两边都在意的点，把前后两次的意思理顺成一条。**不许只是把两段话接在一起**。
   · 如果这次她写的内容和上次说的是一回事，就把它合成一句，不要重复说两遍。
⚠️ 上面**是空的** ⇒ 就是第一次回录，照常整理即可。

【三条铁规矩 (HARD RULES) —— 违反就等于没做】
1. **只依据照片里她真正写下的字**。看不清的字词，就写「［看不清］」或留空；
   **绝对不许**用你自己的猜想去补全，也不许"合理推测"她的意思。
2. **不许编造**：不要补充你自己的错因、解法、正确步骤或学习建议；
   不要写"你应该……""建议你……"这类说教；不要给题目解析，也不要给正确答案。
   判不准的地方，**留空比乱写好**。
3. **保留她的口吻**：用她的原话和视角（"我这次卡在……""我当时以为……"），
   不要改写成标准答案腔，不要堆术语，也不要替她拔高或美化。

【输出格式 (OUTPUT FORMAT)】
严格只输出下面三个标签，不要输出任何其它文字，不要用 JSON、不要用 Markdown 代码块：

<her_words>
尽量**原样**转录她写在纸上的话：可以顺标点和断句，但**不许**改她的用词与口吻。
看不清的位置就地写「［看不清］」。她一个字都没写清楚就留空。
</her_words>

<organized>
把她的内容**理顺**成通顺的"日积月累"正文。**可以分成若干段**：
段与段之间**必须空一行**（一段说一件事 / 一个想法）。
⚠️ 别为了分段而分段 —— 内容少的时候一段就够（1～3 句）。
⚠️ 每一段**内部不要换行**（客户端会给每一段单独包斜体批注；段内换行会把斜体断开）。
仍然用她的口吻，仍然只讲她写过的内容。
</organized>

<unclear>
一句话说明你觉得哪里看不清 / 拿不准（她复核时要看的一栏）。没有就留空。
</unclear>

{{grade_instruction}}
{{provider_hints}}`;

/**
 * 生成回录分析提示词。
 * @param questionContext - 由 `buildRecoverQuestionContext()` 拼好的"这道题是什么"上下文块
 * @param language - 输出语言（默认简体中文）
 * @param options - 自定义选项（customTemplate 可整段覆盖）
 * @param gradeSemester - 年级学期（用于注入学历约束，可空）
 * @param previousInsight - 【2026-10-04 他要求】**这道题上次记过的日积月累正文**：
 *        有 ⇒ 让 AI 做**有机合并**（`organized` 融合前后两次，而不是拼接）；
 *        没有 ⇒ 传入空/null（模板里会显示"以前没有记过"）。
 *        ⚠️ 她写的**原话**不靠 AI 合并 —— 上次的原话由客户端保留（见
 *        `lib/recover-analysis.ts` 的 `previousHersOf` + `composeRecoveryContent`），
 *        这样"她的话"永远不会被模型改写或丢掉。
 */
export function generateRecoverAnalysisPrompt(
  questionContext: string,
  language: 'zh' | 'en' = 'zh',
  options?: PromptOptions,
  gradeSemester?: string | null,
  previousInsight?: string | null
): string {
  const langInstruction = language === 'zh'
    ? '请用**简体中文**输出。'
    : 'Please output in English.';

  const template = options?.customTemplate || DEFAULT_RECOVER_ANALYSIS_TEMPLATE;

  const prev = (previousInsight ?? '').trim();

  return replaceVariables(template, {
    language_instruction: langInstruction,
    question_context: questionContext,
    // 空的时候给一句明确的"没有" —— 比留白更不容易让模型自己脑补
    previous_insight: prev || '（这道题以前没有记过日积月累）',
    grade_instruction: generateGradeInstruction(gradeSemester),
    provider_hints: options?.providerHints || ''
  }).trim();
}

/**
 * 【2026-10-04】**复练纸回录**（纸回录的第二步）—— 读她**在纸面上标的记号**。
 *
 * 与第一步（深挖纸回录）根本不同：这一步**根本不判卷**。
 * 复练纸上每道题右边有一个**灰圆**（圆里是本卷流水号）：她已经自己把它点成/画成了
 * 三态之一 —— 灰底白数字 = 没标、绿底白勾 = 做对、粉底灰叉 = 做错。系统要做的只有一件事：
 *   **在已知的位置上，把她标的记号读出来**（对 / 错 / 没标 / 看不清）。
 *
 * ⚠️ 提示词的红线（他反复强调，也是这个功能存在的意义）：
 *   ① **不许判卷** —— 不许看题目、不许自己判断这道题做没做对；**她标的比 AI 看照片准**，
 *      而且那是她的判断，本就该以她为准。AI 读不到就写 `unclear`，绝不猜对错。
 *   ② **版面是给定的** —— 左栏/右栏、从上到下哪一格是哪题，都写在 {{page_map}} 里，
 *      不需要（也不许）去"认版面"。
 *   ③ **升降框与这一步无关** —— 右下角那个打了勾的升降框是"要不要改题目类型"，
 *      **不看、不读、不据此输出任何东西**。
 */
export const DEFAULT_RECOVER_REVIEW_TEMPLATE = `【角色与核心任务 (ROLE AND CORE TASK)】
你在读一张**复练纸**的照片。这张纸的**版面是已知的**（见下面的「版面地图」）：每一页分若干栏，
每栏从上到下排着几道题；每道题右边有一个**灰圆**（圆里印着本卷流水号）。
孩子已经**自己在纸上标了**每道题的结果 —— 你的任务**只有一件**：
   **在下面地图给出的位置上，读出她标了什么记号**（对 / 错 / 没标 / 看不清）。

{{language_instruction}}

【这一页的版面地图（数据库里已知，**不需要你认版面**）】
{{page_map}}

【圆的三态长什么样（照着读，别猜）】
- **灰底、白数字**（素灰的圆圈里是数字）⇒ 她**没标** ⇒ 写 \`none\`
- **绿底、白勾（✓）** ⇒ 她标了**做对** ⇒ 写 \`right\`
- **粉底、灰叉（✗）** ⇒ 她标了**做错** ⇒ 写 \`wrong\`
- 看不清是哪一态（反光、糊了、被挡）⇒ 写 \`unclear\`

【三条铁规矩 (HARD RULES) —— 违反就等于没做】
1. **绝不判卷**：不许看题目内容去判断这道题做没做对，不许替她打分、不许改她的判断。
   你唯一的依据是**她标在纸上的记号**。读不到就写 \`unclear\`，**不许猜**。
2. **只读灰圆，别管升降框**：右下角那个打了勾的"升降框"讲的是"要不要改题目类型"，
   与本次记录**无关** —— **不看、不读、不据此输出任何东西**。
3. **按地图给的槽位对齐**：地图里每一格的代号（如 \`L1\`、\`R2\`）就是它在你输出里要用的代号，
   **照抄代号**，不要自己另起一套编号。

【输出格式 (OUTPUT FORMAT)】
按**地图的顺序**，**每一格输出一行**下面这种标签（不要输出任何其它文字，不要用 JSON、不要用 Markdown 代码块）：

<mark slot="L1">right</mark>
<mark slot="L2">none</mark>
<mark slot="R1">wrong</mark>

- 每行的值只能是：\`right\` / \`wrong\` / \`none\` / \`unclear\` 这四个词之一。
- 地图里**有**的槽位都要出现一行（哪怕她没标，也要写 \`none\`）。

<unclear>
一句话说明你哪里看不清 / 拿不准（她复核时要看的一栏）。没有就留空。
</unclear>

{{provider_hints}}`;

/**
 * 生成复练纸回录提示词。
 * @param pageMap - 由 `buildReviewPageMap()` 拼好的"这一页版面地图"
 * @param language - 输出语言（默认简体中文）
 * @param options - 自定义选项（customTemplate 可整段覆盖）
 */
export function generateRecoverReviewPrompt(
  pageMap: string,
  language: 'zh' | 'en' = 'zh',
  options?: PromptOptions
): string {
  const langInstruction = language === 'zh'
    ? '请用**简体中文**输出标签外的说明文字（标签里的取值必须是英文的 right / wrong / none / unclear）。'
    : 'Please output in English (the tag values must still be right / wrong / none / unclear).';

  const template = options?.customTemplate || DEFAULT_RECOVER_REVIEW_TEMPLATE;

  return replaceVariables(template, {
    language_instruction: langInstruction,
    page_map: pageMap,
    provider_hints: options?.providerHints || ''
  }).trim();
}

/* ==========================================================================================
 * 【2026-10-18 如如】日积月累 · 整理提示词（默认版）
 *
 * ⚠️ 这份提示词**不是**"把话写漂亮"，它只有三个可检验的目标（写成数字，不写形容词）：
 *   ① 30 秒内读完（标题 ≤ 12 个汉字 + 正文 ≤ 120 字 + AI 段 ≤ 60 字）
 *   ② 读完能立刻想起"这道题我错在哪、下次怎么办"
 *   ③ **保留她自己的说法**（尤其是比喻、口头禅）—— 那是记忆的钩子，删了就唤不起来
 *
 * 为什么规则写成"可数的数字"而不是"短小精悍"：
 *   模型对形容词的理解各家不同（"精悍"可能理解成 80 字，也可能 300 字）；
 *   但"≤120 字"它是会数的。同理"最多 3 条""全文最多 3 个 emoji"。
 *
 * 为什么必须有 1 个正例 + 1 个反例：
 *   这类"风格类"任务，**一个例子胜过五条形容词**。正例定调子，反例挡"教辅腔"。
 *
 * ⚠️ 结构**不完全交给模型**：`#### ` 标题、`> *AI: …*` 这两处由程序再规范化一次
 *    （`lib/insight-note.ts` 的 `normalizeInsightMarkdown`）—— 纸面排版不能靠模型守规矩。
 * ========================================================================================== */

export const DEFAULT_INSIGHTS_TEMPLATE = `你是一位带过很多小学生、很会"把话说进孩子心里"的老师。孩子在攒一本**自己的小词典**——「日积月累」。里面不是标准答案，而是她自己碰到过、想过、被点醒过的那些东西：一道错题上的道理、书里划下来的一段、老师课上随口一句、她自己冒出来的一个念头。你的任务**不是写教辅**，而是把她这段原料整理成一张**她愿意反复翻的小卡片**。

【这是一个"词条"，不是一篇文章】
- 一张卡只讲**一件事**。原料里要是掺了好几件事，挑最要紧的写，其余留给她自己。
- 标题就是这件的"词"：她以后是靠这行字把它想起来的，所以标题要**具体**，
  不要写成"关于××的思考"这种放之四海皆准的废话。

{{language_instruction}}

【这次的目标，只有一个】
让她下次翻到这张卡片时，**30 秒内**重新认出"这是我当时想明白的那个点"。
不是让她学会更多新知识，也不是让卡片看起来漂亮。

【硬性要求（请逐条遵守，这些会被程序检查）】
1. 第一行必须是四级标题：以四个井号加空格开头，然后一个 emoji，再跟**不超过 12 个汉字**的概括。
   例：#### 🧠 分数比大小要看分母
2. 标题下面空一行，然后写正文。正文**总数不超过 120 字**。
   能分条就分条（每条以 - 开头，一条一件事）；分不了就用一段话，不要硬凑。
   **条数不设上限**：有两件事就两条，有五件事就五条 —— 别为了"看起来整齐"把两件事硬塞进一条。
   但要是超过五条，说明这段原料其实够写好几张卡了 —— 只写最要紧的那几件，别贪多。
3. 正文里可以用**加粗**和==高亮==标出关键那几个词；**全文 emoji 最多 3 个**（标题里那个不算）。
   不要每句都加装饰。
4. **优先保留她自己的说法**：她的比喻、她的口头禅、她自己发明的记法，尽量原样留下。
   要压缩的是重复和跑题，不是她的语气。
5. **她把道理说错了，正文必须写成对的**。这一点比"写得好看"重要得多：
   这张卡她会反复看，错的东西记一遍就多错一遍。
   但**不许悄悄改**：在下面的 AI 段里点明她原来错在哪（"你原来以为……其实……"）。
   · 正文用**正确**的说法，她那一句错的**不要原样留在正文里**；
   · 她的**比喻、语气、自己发明的记法**要是在理，原样保留 —— 那是这张卡的魂；
   · 她只是在记一句感受、一段摘抄、一个疑问（谈不上对错）时，**照原样写，不要纠正**。
6. 正文之后，如果你**确实**有话想跟她说，另起一段写成：以大于号加空格开头，整段用星号包成斜体，
   开头写 AI: ，后面接你的话。**不超过 60 字**，一到两句。
   · 只写"补充"：记忆口诀、思路提示、学习方法、课外的一点延伸、**或者她刚才错在哪**、或者一句鼓励。
   · **不要复述上面正文的内容**，不要写"总之""希望对你有帮助"这类空话。
   · **没有什么可补的，就整段不要写**（宁缺勿滥，空着比凑一句强）。
7. 不要输出任何解释、不要输出"以下是整理结果"、不要用代码块包裹。直接给卡片本身。

【什么样的算好（正例）】
输入大意：孩子写"分数比大小我总是错，我以为分子大就大，后来发现 1/2 和 1/3，分的东西越多每份越小，所以分母大反而小，老师说这叫分的份数多。"

输出：
#### 🧠 分母越大，每份越小

- 分子一样时，**分母越大，这个分数反而越小**（分的人多了，每人拿到的就少）。
- 我原来的错：以为分子大就大，其实要先看**分子一样不一样**。

> *AI: 记住这句话就够了——"分的人越多，拿到的越少"。下次先比分子，一样再比分母。*

（注意这张卡怎么处理她的错：**正文写的全是对的**，她原来错在哪放在第二条里点明，
AI 段只补一句记忆钩子 —— 既没把错的那句留在正文里，也没悄悄改掉不说。）

【什么样的算坏（反例，别这样写）】
- ❌ 写成长篇："分数是小学数学的重要内容，比较分数大小有多种方法，包括通分、化小数、交叉相乘……"（这是教辅，不是她的卡片）
- ❌ 标题超过一行：#### 📚 关于分数大小比较这个知识点我的一些思考与总结
- ❌ AI 段复述正文："AI: 上面说了分母越大每份越小，所以你要记住这一点。"
- ❌ 把她错的地方悄悄改对，却不说她原来错在哪（她会以为自己一直就是这么想的）。
- ❌ 把三件事硬压成三条，最后一条塞了两件事，谁也说不清。

【她以前记过的同类（可能有，也可能没有）】
{{related_notes}}

上面如果真有内容，先扫一眼 —— 这本词典的价值就在"不同时期的看法能串起来"：
· **只在你确实看到"同一个点"时**，才在 AI 段里回指，写法：
  AI: 这个你在 JL20261012003 那条里也写过，那次你举的是分蛋糕的例子。
· 回指的意思是"你以前也想过这个"，**不是**"你以前错了"；
· **没有真的相关就一个字都别提**（硬凑的关联比不关联更烦人）；
· 她这次要是写得更清楚了，可以点一句"比上次多走了哪一步"。

【她这次的原料】
学科：{{subject}}
题目：{{question_text}}
错因：{{mistake_reason}}
错因分析：{{mistake_analysis}}

【她写/记录的内容】
{{raw_content}}
`;

/**
 * 【2026-10-19 空空第 2 条】**让 AI 顺手判学科** —— 这段**固定追加在模板末尾**。
 *
 * 为什么不写进 `DEFAULT_INSIGHTS_TEMPLATE`：模板在设置页里可以被用户改得面目全非，
 * 而"判学科"是**程序要读的结构**（不是文案）—— 放进模板里，用户一改就丢。
 * ⇒ 不管模板长什么样，这段都由程序补在后面。
 *
 * ⚠️ 模型不照做（漏写、写成别的格式）只是"这次没判出学科"，不影响卡片本身：
 *    解析在 `lib/insight-subject.ts`，认不出就返回 null，绝不猜。
 */
const SUBJECT_MARK_INSTRUCTION = `

【最后还有一行，是给程序读的，不是卡片内容】
在卡片的**最末尾另起一行**，原样输出这条积累属于哪个学科：
[[学科:数学]]
· 只能从这十个里选一个填进去：数学 / 语文 / 英语 / 物理 / 化学 / 生物 / 政治 / 历史 / 地理 / 其他
· 真的看不出是哪一科，就写"其他"。
· 这一行程序会删掉，不会印到纸上；除了这一行，不要再写任何解释。`;

/**
 * 拼「日积月累 · 整理」的完整提示词。
 *
 * ⚠️ 变量都做**长度截断**：原料可能是一整页手写 OCR（几千字），
 *    全塞进去既慢又容易让模型"被细节淹掉"（它的注意力是有限的，不是越多越准）。
 */
export function generateInsightsPrompt(opts: {
    rawContent: string;
    subject?: string | null;
    questionText?: string | null;
    mistakeReason?: string | null;
    mistakeAnalysis?: string | null;
    /**
     * 【2026-10-18】她以前记过的同类条目（服务端按学科取的最近几条）。
     * 目的只有一个：让 AI 能"回指" —— 空空原话："这样积累和积累之间的关系就建立起来了"。
     * ⚠️ 只给**标题 + 开头一小段**，不给全文：给多了模型会拿旧内容糊弄，
     *    写成"总结"而不是"整理她这一次的原料"。
     */
    relatedNotes?: { code: string; content: string | null }[] | null;
    customTemplate?: string | null;
    languageInstruction?: string;
}): string {
    const template = opts.customTemplate || DEFAULT_INSIGHTS_TEMPLATE;

    /**
     * 旧条目的拼法：一条一行，`编号（日期不必进模型）：标题 + 开头`。
     * 每条正文截 120 字 —— 8 条 × 120 = 不到 1K 字，不会把原料淹掉。
     */
    const relatedText =
        opts.relatedNotes && opts.relatedNotes.length > 0
            ? opts.relatedNotes
                  .map((n) => `· ${n.code}：${(n.content || '').replace(/\s+/g, ' ').slice(0, 120)}`)
                  .join('\n')
            : '（她以前还没记过类似的。）';

    return replaceVariables(template, {
        language_instruction: opts.languageInstruction || '',
        subject: opts.subject || '（没填）',
        question_text: (opts.questionText || '（没有题干——这条可能与某道题无关，按笔记处理）').slice(0, 1500),
        mistake_reason: opts.mistakeReason || '（没打错因）',
        mistake_analysis: (opts.mistakeAnalysis || '').slice(0, 600) || '（无）',
        raw_content: opts.rawContent.slice(0, 4000),
        related_notes: relatedText,
    }).trim() + SUBJECT_MARK_INSTRUCTION;
}
