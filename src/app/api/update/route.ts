/**
 * 【2026-11-01】软件内更新 —— 检查 + 触发。
 *
 * ── 背景与约束 ────────────────────────────────────────────────────
 *   部署方式：NAS 上 watchtower 每 300 秒拉一次 `custom-latest` 镜像并重建容器。
 *   容器里**没有 docker 权限**（没挂 docker.sock），它自己拉不了镜像、也重启不了自己。
 *   但 watchtower 支持 HTTP API 触发（`--http-api-update`），而且和错题本容器
 *   在同一个 compose 网络（`dockerssd_default`）⇒ **发一个请求就能让它立刻重建**。
 *
 * ── 检查（GET /api/update/check）──────────────────────────────────
 *   对比 GitHub Actions 最近一次**成功的手动构建**（那才是镜像的来源）的 commit
 *   与当前运行的 `APP_COMMIT`。不同 ⇒ 有新版。
 *   不去问 GHCR 的 digest —— 容器没有 docker 权限，拿不到自己镜像的 digest。
 *
 * ── 触发（POST /api/update/apply）─────────────────────────────────
 *   POST http://watchtower:8080/v1/update（token 从配置读）。
 *   **这一步会把当前容器干掉重建 ⇒ 这个请求本身多半等不到响应** ——
 *   所以客户端要按"发出后约 2 分钟断线"来处理，更新成功与否看版本号变没变。
 */

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getAppConfig } from '@/lib/config';
import { unauthorized, internalError, badRequest } from '@/lib/api-errors';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api:update');

const REPO = 'bighead2425/wrong-notebook';

interface RunInfo {
    headSha: string;
    displayTitle: string;
    createdAt: string;
}

async function latestSuccessfulBuild(): Promise<RunInfo | null> {
    const url = `https://api.github.com/repos/${REPO}/actions/runs?branch=main&event=workflow_dispatch&status=success&per_page=5`;
    const res = await fetch(url, {
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'wrong-notebook-updater',
        },
        /* 国内直连 api.github.com 时好时坏 —— 给 15 秒，失败就当"查不到" */
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
        workflow_runs?: Array<{ head_sha: string; display_title?: string; created_at: string }>;
    };
    const run = data.workflow_runs?.[0];
    if (!run) return null;
    return {
        headSha: run.head_sha,
        displayTitle: run.display_title || '',
        createdAt: run.created_at,
    };
}

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized('Authentication required');

    const currentCommit = (process.env.APP_COMMIT || '').trim() || null;
    const currentVersion = (process.env.APP_VERSION || '').trim() || null;

    try {
        const latest = await latestSuccessfulBuild();
        if (!latest) {
            return NextResponse.json({
                current: { version: currentVersion, commit: currentCommit },
                latest: null,
                hasUpdate: false,
                error: '没能查到最新构建（GitHub 连不上或没有记录）',
            });
        }

        const hasUpdate = !!currentCommit && latest.headSha.slice(0, 7) !== currentCommit.slice(0, 7);
        return NextResponse.json({
            current: { version: currentVersion, commit: currentCommit },
            latest: { commit: latest.headSha.slice(0, 7), builtAt: latest.createdAt, title: latest.displayTitle },
            hasUpdate,
        });
    } catch (e) {
        logger.warn({ err: String(e) }, '检查更新失败');
        return NextResponse.json({
            current: { version: currentVersion, commit: currentCommit },
            latest: null,
            hasUpdate: false,
            error: '检查更新失败（GitHub 连不上）',
        });
    }
}

export async function POST() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized('Authentication required');

    const cfg = getAppConfig();
    const token = cfg.updater?.watchtowerToken?.trim();
    const url = (cfg.updater?.watchtowerUrl || 'http://watchtower:8080').replace(/\/$/, '');

    if (!token) {
        return badRequest(
            '还没配置 watchtower 的触发令牌。需要先在 NAS 上给 watchtower 开启 HTTP API（见说明书），'
            + '再把令牌填进 /vol2/1000/dockerssd/config/app-config.json 的 updater.watchtowerToken。',
        );
    }

    try {
        /**
         * 触发后 watchtower 会立刻拉镜像并**重建这个容器** ⇒ 我们自己会被杀掉，
         * 这个 fetch 八成等不到响应。给 8 秒：能拿到响应就记状态，拿不到也没关系。
         */
        const res = await fetch(`${url}/v1/update`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000),
        });
        const text = await res.text().catch(() => '');
        logger.info({ status: res.status, body: text.slice(0, 200) }, '已触发 watchtower 更新');
        return NextResponse.json({
            triggered: true,
            watchtowerStatus: res.status,
            note: '更新已触发。容器会在一两分钟内重建，期间服务会短暂中断；页面稍后刷新就能看到新版本。',
        });
    } catch (e) {
        /**
         * 超时/连接被重置 **多半是正常的** —— 容器正在被杀。
         * 只有"明确被拒"（401/403）才是配置问题，但那个分支上面 res.ok 已经能拿到。
         */
        const msg = String(e);
        const aborted = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
        if (aborted || /ECONNRESET|socket hang up/i.test(msg)) {
            logger.info('触发更新后连接中断（预期内：容器正在被重建）');
            return NextResponse.json({
                triggered: true,
                watchtowerStatus: null,
                note: '更新已触发（连接中断是预期的——容器正在重建）。约两分钟后刷新页面看新版本。',
            });
        }
        logger.error({ err: msg }, '触发更新失败');
        return internalError(`触发更新失败：${msg.slice(0, 200)}`);
    }
}
