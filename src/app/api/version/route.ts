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
  const fromEnv = process.env.APP_VERSION;
  if (fromEnv && fromEnv.trim()) {
    return NextResponse.json({ version: fromEnv.trim(), source: 'env' });
  }

  try {
    const packageJsonPath = join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return NextResponse.json({ version: packageJson.version || 'unknown', source: 'package' });
  } catch {
    return NextResponse.json({ version: 'unknown', source: 'none' });
  }
}
