import fs from "fs/promises";
import path from "path";

/**
 * 把错题导出为 NAS 上的 Obsidian 笔记。
 * 仓库根目录由环境变量 OBSIDIAN_VAULT_PATH 指定（容器内默认 /app/obsidian-vault），
 * 其下固定子目录 花生学习/错题本/<年级学期>/<学科>/<题号>.md
 */

const OBSIDIAN_BASE = process.env.OBSIDIAN_VAULT_PATH || "/app/obsidian-vault";
const VAULT_SUBDIR = "花生学习/错题本";

export interface ObsidianExportInput {
    questionNo: string; // 例如 sx20260912008
    subjectName: string; // 例如 数学
    gradeSemester: string; // 例如 五年级上
    tags: string[]; // 知识点名称列表
    questionText?: string | null;
    originalImageUrl?: string | null; // data:image/jpeg;base64,...
    analysis?: string | null;
    answerText?: string | null;
    mistakeAnalysis?: string | null;
}

export interface ObsidianExportResult {
    ok: boolean;
    notePath?: string;
    imagePath?: string;
    error?: string;
}

/** 把 knowledgePoints(JSON 字符串) 解析成标签名数组 */
export function parseTags(knowledgePoints?: string | null): string[] {
    if (!knowledgePoints) return [];
    try {
        const arr = JSON.parse(knowledgePoints);
        return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
    } catch {
        return [];
    }
}

/** 去掉文件系统非法字符，避免文件夹/文件名出错 */
function sanitize(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名";
}

function buildMarkdown(d: ObsidianExportInput): string {
    const frontmatter = [
        "---",
        `title: ${d.questionNo}`,
        `subject: ==${d.subjectName}== ${d.gradeSemester}`,
        `tags: [${d.tags.join(", ")}]`,
        "---",
        "",
    ].join("\n");

    // 标签双链（正文顶部，便于 Obsidian 反链/图谱）
    const tagLinks = d.tags.length ? d.tags.map((t) => `[[${t}]]`).join(" ") : "";

    const imageRef =
        d.originalImageUrl && d.originalImageUrl.startsWith("data:")
            ? `![[图${d.questionNo}.jpg]]`
            : "";

    const blocks: string[] = [];

    if (tagLinks) blocks.push(tagLinks);

    // 题目
    blocks.push(["#### 题目", "", d.questionText || "", imageRef].filter(Boolean).join("\n"));

    // 重新解答（预留 7 行手写空间）
    blocks.push(
        ["#### 重新解答", "", "更新作答", "<br><br><br><br><br><br><br>"].join("\n")
    );

    if (d.analysis) blocks.push(["#### 解析", "", d.analysis].join("\n"));
    if (d.answerText) blocks.push(["#### 参考答案", "", d.answerText].join("\n"));
    if (d.mistakeAnalysis) blocks.push(["#### 错因分析", "", d.mistakeAnalysis].join("\n"));

    return frontmatter + "\n" + blocks.join("\n\n---\n\n") + "\n";
}

async function writeImage(dir: string, questionNo: string, dataUrl: string): Promise<string | undefined> {
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx < 0) return undefined;
    const base64 = dataUrl.slice(commaIdx + 1);
    if (!base64) return undefined;
    const imgPath = path.join(dir, `图${questionNo}.jpg`);
    await fs.writeFile(imgPath, Buffer.from(base64, "base64"));
    return imgPath;
}

export async function exportErrorItemToObsidian(d: ObsidianExportInput): Promise<ObsidianExportResult> {
    try {
        const grade = sanitize(d.gradeSemester || "未分年级");
        const subject = sanitize(d.subjectName || "未分学科");
        const dir = path.join(OBSIDIAN_BASE, VAULT_SUBDIR, grade, subject);
        await fs.mkdir(dir, { recursive: true });

        const mdPath = path.join(dir, `${d.questionNo}.md`);
        await fs.writeFile(mdPath, buildMarkdown(d), "utf-8");

        let imagePath: string | undefined;
        if (d.originalImageUrl && d.originalImageUrl.startsWith("data:")) {
            imagePath = await writeImage(dir, d.questionNo, d.originalImageUrl);
        }

        return { ok: true, notePath: mdPath, imagePath };
    } catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
