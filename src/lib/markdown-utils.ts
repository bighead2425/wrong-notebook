import { remark } from 'remark';
import stripMarkdown from 'strip-markdown';

/**
 * Clean markdown content to plain text.
 * Note: This function is synchronous and uses remark.processSync.
 */
export function cleanMarkdown(content: string): string {
    if (!content) return "";

    try {
        // 1. First, handle custom LaTeX-like escape sequences that remark might not catch or handle as we want
        // Specifically, handle escaped underscores manually before markdown stripping
        // because we want "\_" to become "_" (plain text underscore), not removed entirely
        let text = content.replace(/\\_/g, '_');

        // 2. Use remark to strip markdown formatting
        const file = remark().use(stripMarkdown as any).processSync(text);
        text = String(file);

        // 3. Post-processing: specific cleanups for this app
        // Remove common LaTeX commands that might remain as plain text
        text = text
            // Layout commands
            .replace(/\\left/g, '')
            .replace(/\\right/g, '')
            .replace(/\\begin\{.*?\}/g, '')
            .replace(/\\end\{.*?\}/g, '')
            .replace(/\\text\{.*?\}/g, '')
            .replace(/\\mbox\{.*?\}/g, '')
            // Math structures (Simple recursive patterns are not supported in JS regex, so we handle basic cases)
            .replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '$1/$2')
            .replace(/\\sqrt\s*\{([^{}]+)\}/g, '√$1')
            .replace(/\^\{([^{}]+)\}/g, '^$1')
            .replace(/_\{([^{}]+)\}/g, '_$1')
            // Symbols map
            .replace(/\\times/g, '×')
            .replace(/\\div/g, '÷')
            .replace(/\\cdot/g, '·')
            .replace(/\\le/g, '≤')
            .replace(/\\ge/g, '≥')
            .replace(/\\neq/g, '≠')
            .replace(/\\approx/g, '≈')
            .replace(/\\pm/g, '±')
            .replace(/\\infty/g, '∞')
            .replace(/\\circ/g, '°')
            .replace(/\\triangle/g, '△')
            .replace(/\\angle/g, '∠')
            .replace(/\\because/g, '∵')
            .replace(/\\therefore/g, '∴')
            // Explicitly remove math delimiters ($)
            .replace(/\$/g, '')
            // Cleanup remaining backslashes
            .replace(/\\/g, '')
            .trim();

        return text;
    } catch (error) {
        console.error("Failed to strip markdown:", error);
        // Fallback to original content if stripping fails
        return content;
    }
}

/**
 * 【2026-10-10 从 `components/print/review-card.tsx` 搬到这里】
 * 把正文里的 **markdown 图片语法**去掉，只留文字。
 *
 * 为什么要它：纸上的题图是**橙框单独裁出来**的（见 `use-print-images`），
 * 不靠正文里那段 markdown；不剥掉的话，同一张图会**印两遍**
 * （正文里一遍、裁切的那份一遍）。
 *
 * ⚠️ 它本来是组件文件里的一个工具，搬过来是因为 `lib/imitate-card.ts`（纯逻辑）
 *    也要用它 —— **纯逻辑不该去 import 组件文件**。
 *    原来那处保留了 re-export，所以既有调用方一行都不用改。
 */
export function stripMarkdownImages(text: string): string {
    return text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
