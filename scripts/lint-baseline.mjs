#!/usr/bin/env node
/**
 * lint 基线门禁（波 0）
 * ============================================================================
 * 用法：
 *   npm run lint:gate            # 跑 eslint，与基线比对；有新增 error 则失败（退出码 1）
 *   npm run lint:gate -- --update  # 顺手还了债之后，把基线下调到当前实测值
 *
 * 为什么是"基线式"而不是"一次清零"：
 *   2026-09-24 实测 `eslint src` 共 189 error / 88 warning，其中
 *   **167 个是 `no-explicit-any`**，散在 66 个文件里。若直接把 `npm run lint`
 *   挂进 CI，现存欠账会把每一次 push / 发版全部挡在门外；而若为了过门禁去
 *   大规模改这 66 个文件，又会和紧接着的卡片版面重排（M3）撞车。
 *
 *   所以这里采用**只允许下降、不允许上升**的基线门禁：
 *     · 存量欠账不阻塞任何人；
 *     · 新写的代码**再加一个 any 就会红**——债立刻停止增长；
 *     · 谁顺手还了债，跑一次 `-- --update` 把基线收紧，闸门只进不退。
 *
 * 为什么只卡 error、不卡 warning：
 *   warning 里 74 条是 `no-unused-vars`（调试期常见，用它卡人得不偿失），
 *   9 条 `exhaustive-deps`、5 条 `no-img-element`。真正危险的两类——
 *   `no-explicit-any`（类型逃逸）、`react-hooks/*`（状态误用）——都在 error 侧。
 *   warning 仍然会打印出来，只是不作为门禁，避免用噪声把真信号淹掉。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(ROOT, "scripts", "lint-baseline.json");
const LINT_TARGET = "src";

/**
 * 把 eslint 的 JSON 报告压成两个数字。
 * eslint -f json 的形状是 [{ filePath, messages: [{ severity, ruleId, ... }] }]，
 * severity: 2 = error，1 = warning。
 */
export function summarize(report) {
    let errors = 0;
    let warnings = 0;
    const byRule = new Map();
    for (const file of report) {
        for (const msg of file.messages ?? []) {
            const isError = msg.severity === 2;
            if (isError) errors += 1;
            else warnings += 1;
            const rule = msg.ruleId ?? "(parse)";
            const key = `${isError ? "error" : "warning"}:${rule}`;
            byRule.set(key, (byRule.get(key) ?? 0) + 1);
        }
    }
    return { errors, warnings, byRule };
}

/**
 * 基线比对。返回 { ok, regressions, improvements }。
 * 只把 `error` 当作门禁；`warning` 仅报告。
 */
export function compare(baseline, current) {
    const regressions = [];
    const improvements = [];

    if (current.errors > baseline.errors) {
        regressions.push(
            `error 数 ${baseline.errors} → ${current.errors}（新增 ${current.errors - baseline.errors} 条，门禁失败）`
        );
    } else if (current.errors < baseline.errors) {
        improvements.push(`error 数 ${baseline.errors} → ${current.errors}（减少 ${baseline.errors - current.errors} 条）`);
    }

    if (current.warnings > baseline.warnings) {
        improvements.push(""); // 占位
        improvements.pop();
        // warning 不作为门禁，仅在下文打印对比
    }

    return { ok: regressions.length === 0, regressions, improvements };
}

function readBaseline() {
    const raw = readFileSync(BASELINE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.errors !== "number" || typeof parsed.warnings !== "number") {
        throw new Error(`基线文件格式不对（需要 errors / warnings 两个数字）：${BASELINE_PATH}`);
    }
    return parsed;
}

/**
 * 定位 eslint 入口。
 *
 * ⚠️ 不能直接 spawn `npx.cmd`：Node 20 起（CVE-2024-27980 的修复）在 Windows 上
 * 拒绝不带 shell 直接执行 .cmd/.bat，会抛 `spawnSync npx.cmd EINVAL`。
 * 也不用 `shell: true` 绕——那等于把参数交给 cmd.exe 再解析一遍。
 * 最稳的是**用当前这个 Node 直接跑 node_modules 里的 eslint 入口**：
 * 跨平台、无 shell、省掉 npx 的一次进程开销。
 */
function resolveEslint() {
    const local = path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js");
    if (existsSync(local)) {
        return { cmd: process.execPath, args: [local, LINT_TARGET, "-f", "json"], shell: false };
    }
    // 依赖没装齐时的兜底；CI 里 `npm ci` 之后一定走上面那条
    const isWin = process.platform === "win32";
    return { cmd: isWin ? "npx.cmd" : "npx", args: ["eslint", LINT_TARGET, "-f", "json"], shell: isWin };
}

function runEslint() {
    const { cmd, args, shell } = resolveEslint();
    let stdout;
    try {
        stdout = execFileSync(cmd, args, {
            cwd: ROOT,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            stdio: ["ignore", "pipe", "inherit"],
            shell,
        });
    } catch (err) {
        // eslint 发现 error 时以非 0 退出，但 stdout 里的 JSON 是完整的，必须捕获异常后从中读
        if (typeof err.stdout !== "string" || err.stdout.trim() === "") throw err;
        stdout = err.stdout;
    }
    return JSON.parse(stdout);
}

function main() {
    const update = process.argv.includes("--update");
    const baseline = readBaseline();
    const current = summarize(runEslint());

    console.log(`\nlint 基线门禁（目标：${LINT_TARGET}）`);
    console.log(`  基线：${baseline.errors} error / ${baseline.warnings} warning`);
    console.log(`  实测：${current.errors} error / ${current.warnings} warning`);

    const topRules = [...current.byRule.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, n]) => `${k}=${n}`)
        .join("  ");
    if (topRules) console.log(`  主要来源：${topRules}`);

    if (update) {
        writeFileSync(
            BASELINE_PATH,
            `${JSON.stringify({ ...baseline, errors: current.errors, warnings: current.warnings }, null, 2)}\n`,
            "utf8"
        );
        console.log(`\n✅ 基线已更新为 ${current.errors} error / ${current.warnings} warning`);
        return;
    }

    const { ok, regressions, improvements } = compare(baseline, current);
    for (const line of improvements) console.log(`\n⬇️  ${line}　（可跑 \`npm run lint:gate -- --update\` 收紧基线）`);
    for (const line of regressions) console.error(`\n❌ ${line}`);
    if (current.warnings > baseline.warnings) {
        console.log(`\n⚠️  warning 比基线多了 ${current.warnings - baseline.warnings} 条（不阻塞，但值得看一眼）`);
    }

    if (!ok) {
        console.error(
            "\n门禁未通过：本次改动引入了新的 lint error。\n" +
                "  修掉它；若确属历史欠账被重新计算，请核对后手动更新 scripts/lint-baseline.json。\n"
        );
        process.exit(1);
    }
    console.log("\n✅ 未引入新的 lint error。\n");
}

// 仅在直接执行时跑 main（被单测 import 时不跑）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
