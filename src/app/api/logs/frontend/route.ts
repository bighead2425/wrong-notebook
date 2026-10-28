import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';

const logger = createLogger('frontend-logs');

export const runtime = 'nodejs';

interface FrontendLogEntry {
  level: 'info' | 'warn' | 'error';
  prefix: string;
  message: string;
  context?: Record<string, any>;
  timestamp: string;
  url?: string;
  userAgent?: string;
}

interface BatchLogRequest {
  logs: FrontendLogEntry[];
}

/**
 * POST /api/logs/frontend
 *
 * Receives frontend logs and writes them to backend logger
 * Supports both single log and batch log formats.
 */
/**
 * 【2026-10-29 审计修复】**这个接口保持匿名可用，但要设上限。**
 *
 * 为什么不能加登录：`frontendLogger` 在登录页也会上报（登录失败、接口 500 之类），
 * 加了鉴权就会把最有价值的那批日志丢掉。
 * 但也不能什么都不限：原来 `logs` 数组多长都收、`message` 多长都写，
 * 匿名者可以往里灌几 MB 把磁盘写满，也能伪造日志掩盖真实错误。
 * ⇒ 三条上限：请求体大小、条数、单条长度。
 */
const MAX_BODY_BYTES = 200_000;
const MAX_LOGS_PER_REQUEST = 20;
const MAX_MESSAGE_CHARS = 500;
const MAX_CONTEXT_CHARS = 2_000;

function clip(value: unknown, max: number): string {
  const s = typeof value === "string" ? value : String(value ?? "");
  return s.length > max ? `${s.slice(0, max)}…(截断)` : s;
}

export async function POST(request: NextRequest) {
  try {
    const declared = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return NextResponse.json({ success: false, error: "payload too large" }, { status: 413 });
    }

    const body = await request.json();

    // 支持批量日志格式 { logs: [...] } 和单条日志格式
    const rawList = Array.isArray(body.logs) ? body.logs : [body];
    const logs: FrontendLogEntry[] = rawList.slice(0, MAX_LOGS_PER_REQUEST);

    for (const entry of logs) {
      const { level, prefix, message, context = {}, timestamp, url, userAgent } = entry;

      // Build log context
      /* context 交给客户端构造 ⇒ 必须夹：先序列化看长度，超了就只报"有多大" */
      const contextJson = (() => {
        try {
          return JSON.stringify(context ?? {});
        } catch {
          return '"[unserializable]"';
        }
      })();
      const safeContext =
        contextJson.length > MAX_CONTEXT_CHARS
          ? { truncated: true, bytes: contextJson.length, head: contextJson.slice(0, 200) }
          : (context as Record<string, unknown>);

      const logContext = {
        source: 'frontend',
        prefix: clip(prefix, 50),
        url: clip(url || request.headers.get('referer'), 300),
        userAgent: clip(userAgent || request.headers.get('user-agent'), 300),
        clientTime: timestamp,
        ...safeContext,
      };

      // Log to backend using appropriate level
      switch (level) {
        case 'error':
          logger.error(logContext, clip(message, MAX_MESSAGE_CHARS));
          break;
        case 'warn':
          logger.warn(logContext, clip(message, MAX_MESSAGE_CHARS));
          break;
        case 'info':
        default:
          logger.info(logContext, clip(message, MAX_MESSAGE_CHARS));
          break;
      }
    }

    return NextResponse.json({ success: true, count: logs.length });
  } catch (error) {
    logger.error({ error }, 'Failed to process frontend log');
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
