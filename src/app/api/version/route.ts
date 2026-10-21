import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 当前**部署版本**。
 *
 * 优先级：
 *   ① `process.env.APP_VERSION` —— 发版时由 workflow 用 `--build-arg APP_VERSION=<tag>`
 *      烧进镜像（见 Dockerfile），值是发版填的 tag（如 `custom-v40`）。
 *      这是"NAS 上实际跑的是哪一版"的唯一可信来源。
 *   ② 退回 `package.json` 的 version —— 本地开发（`npm run dev`）没有 ① 时用它。
 *
 * ⚠️ 为什么不让前端直接读 package.json：standalone 产物里它未必在预期位置
 *    （原实现就是这样，于是 About 里常显示 unknown），而环境变量一定在。
 */
export async function GET() {
  /**
   * 【2026-10-22 如如】**带上提交号**。
   *
   * 起因：一次三方审计对着桌面上的旧片吵了一晚上，所有结论都过期 ——
   * 因为报告里只有 `version: 1.9.0`，而两份代码的 version 都是它。
   * tag（custom-v114）是人填的，commit 不是；两个一起看才判得出"审的是哪一版"。
   */
  const commit = (process.env.APP_COMMIT || '').trim() || null;

  const fromEnv = process.env.APP_VERSION;
  if (fromEnv && fromEnv.trim()) {
    return NextResponse.json({ version: fromEnv.trim(), commit, source: 'env' });
  }

  try {
    const packageJsonPath = join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return NextResponse.json({ version: packageJson.version || 'unknown', commit, source: 'package' });
  } catch {
    return NextResponse.json({ version: 'unknown', commit, source: 'none' });
  }
}
