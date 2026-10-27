import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { printServerUrl } from "@/lib/print-server";
import { normalizePrintOptions, normalizePrintServer } from "@/lib/print-route";
import { createLogger } from "@/lib/logger";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:print:submit');

/** 自己先卡一道：EasyPrinter 那边限 100MB，但手机生成的 PDF 正常只有 2~6MB */
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

/**
 * 共享打印 —— 把浏览器生成好的 PDF 递给 NAS 上的 EasyPrinter。
 *
 * ── 为什么由**服务端**转发，而不是手机直连 EasyPrinter ─────────────────
 * ① 手机不在家（走 FN Connect）时，它根本连不到 `192.168.1.10:6310`；
 *    但 NAS 上的错题本容器和 EasyPrinter 在同一个网络里，永远连得到。
 * ② EasyPrinter 的 `/api/print` **没有鉴权**，地址不该出现在手机浏览器的请求里。
 * ③ 纸型/双面的兜底值只有服务端知道（配置 + 当前幅面）。
 *
 * 它接受的就是浏览器的 multipart 表单：`file` + 四格设置。
 * 我们只做三件事：验身份、收敛参数、转发。
 */

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: '请先登录' }, { status: 401 });
    }

    let form: FormData;
    try {
        form = await req.formData();
    } catch {
        return NextResponse.json({ error: '上传内容读不出来' }, { status: 400 });
    }

    const file = form.get('file');
    if (!(file instanceof Blob) || file.size === 0) {
        return NextResponse.json({ error: '没有收到要打印的文件' }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: '文件太大了（超过 40MB）' }, { status: 413 });
    }

    /* 四格设置的兜底：前端已经收敛过一次，服务端**再算一次**。
       理由：这个接口是本机局域网上谁都能调的（EasyPrinter 本身无鉴权），
       不能假设调用方一定是我们的前端。 */
    const opts = normalizePrintOptions({
        copies: form.get('copies'),
        duplex: form.get('duplex'),
        paper: form.get('paper'),
        range: form.get('range'),
    });

    const target = printServerUrl();
    const out = new FormData();
    const name = typeof form.get('filename') === 'string' && form.get('filename')
        ? String(form.get('filename'))
        : 'wrong-notebook.pdf';
    out.append('file', file, name.endsWith('.pdf') ? name : `${name}.pdf`);
    /* printer 留空 = 用 EasyPrinter 的默认打印机（家里只有一台，没必要让用户选） */
    out.append('printer', '');
    out.append('copies', String(opts.copies));
    out.append('paper_size', opts.paper);
    out.append('orientation', 'portrait');
    /* EasyPrinter 认的是 none / long / short；这里只放单面与长边翻转两种 */
    out.append('duplex', opts.duplex);
    out.append('color_mode', 'color');
    out.append('page_range', '');

    try {
        const res = await fetch(`${target}/api/print`, {
            method: 'POST',
            body: out,
            signal: AbortSignal.timeout(120_000),
        });
        const text = await res.text();
        let data: { success?: boolean; job_id?: number; error?: string } = {};
        try {
            data = JSON.parse(text);
        } catch {
            /* 非 JSON 就别装作读懂了 */
        }
        if (!res.ok || !data.success) {
            logger.warn(`EasyPrinter rejected job: HTTP ${res.status} ${text.slice(0, 200)}`);
            return NextResponse.json(
                { error: data.error || `共享打印机没接受这个任务（HTTP ${res.status}）` },
                { status: 502 },
            );
        }
        logger.info(`Print job submitted: id=${data.job_id ?? '-'} paper=${opts.paper} duplex=${opts.duplex}`);
        return NextResponse.json({ ok: true, jobId: data.job_id ?? null });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`EasyPrinter unreachable: ${target} ${msg}`);
        return NextResponse.json(
            {
                error: `连不上共享打印机（${target}）。检查它是否还在运行、以及设置里的地址对不对。`,
            },
            { status: 502 },
        );
    }
}

/**
 * 「测试连接」——给设置页用。
 *
 * 为什么用"空表单 POST"探测：EasyPrinter 的 `/api/printers` 要登录，
 * 而 `/api/print` 不用；空 POST 会被它判成 400「No file provided」。
 * 能拿回这个 400，就说明**地址对、服务活着、打印接口开着**——
 * 这比"首页能不能打开"更能说明问题（首页 302 到登录页也算活，但接口可能被挡）。
 *
 * `?url=` 是为了"还没保存时先试一下"。⚠️ **只有管理员能用这个参数** ——
 * 它是服务端会去 fetch 的地址，不能让任何登录用户拿它当探针扫内网。
 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ ok: false, error: '请先登录' }, { status: 401 });
    }
    const isAdmin = (session.user as { role?: string }).role === 'admin';
    const candidate = isAdmin ? new URL(req.url).searchParams.get('url') : null;
    const target = candidate ? normalizePrintServer(candidate) : printServerUrl();
    try {
        const res = await fetch(`${target}/api/print`, {
            method: 'POST',
            body: new FormData(),
            signal: AbortSignal.timeout(8_000),
        });
        const text = await res.text();
        const looksLikeEasyPrinter = /No file provided|file/i.test(text);
        return NextResponse.json({
            ok: true,
            target,
            reachable: true,
            looksLikeEasyPrinter,
            status: res.status,
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`Print server probe failed: ${target} ${msg}`);
        return NextResponse.json({ ok: false, target, reachable: false, error: '连不上' });
    }
}
