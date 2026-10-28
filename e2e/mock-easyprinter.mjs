/**
 * 假的 EasyPrinter —— **只为 E2E 存在**。
 *
 * 真打印机在 NAS 的局域网里，CI 连不到；但"共享打印"这条链真正要验的是：
 *   浏览器把纸面拍成 PDF → POST /api/print/submit → 服务端转成 EasyPrinter 认的表单。
 * 这三步都不需要真纸，所以用一个 60 行的 HTTP 服务替它收件、记账。
 *
 * 接口与真实 EasyPrinter 对齐（见 NAS 上 /app/app.py 的 api_print）：
 *   POST /api/print   multipart：file / printer / copies / paper_size / orientation
 *                     / duplex / color_mode / page_range
 *   → {"success": true, "job_id": N}
 *
 * 额外两个只给测试用的口子：
 *   GET /health   —— Playwright 的 webServer 就绪探针
 *   GET /_last    —— 回看"上一次收到了什么"，用例据此断言纸型/双面/份数
 *
 * ⚠️ 端口 6399 是刻意选的：既不是 EasyPrinter 的 6310、也不是 CUPS 的 631。
 */

import http from 'node:http';

const PORT = Number(process.env.MOCK_EASYPRINTER_PORT || 6399);

/** 上一次收到的任务（用例读它做断言） */
let last = null;

/** 从 multipart 的文本里抠一个普通字段（够用就行，这里不做完整解析） */
function field(text, name) {
    const m = text.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`));
    return m ? m[1] : null;
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
    }

    if (req.method === 'GET' && req.url === '/_last') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(last));
        return;
    }

    if (req.method === 'POST' && req.url === '/api/print') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const buf = Buffer.concat(chunks);
            /* latin1：PDF 是二进制，用 utf8 解会把字节改掉，%PDF 头就对不上了 */
            const text = buf.toString('latin1');
            const nameAt = text.indexOf('filename="');
            last = {
                at: Date.now(),
                bytes: buf.length,
                /* 真正要证的是"发过来的是 PDF"，不是一坨空表单 */
                isPdf: text.includes('%PDF-'),
                fileName: nameAt >= 0 ? text.slice(nameAt + 10, text.indexOf('"', nameAt + 10)) : null,
                printer: field(text, 'printer'),
                copies: field(text, 'copies'),
                paper_size: field(text, 'paper_size'),
                orientation: field(text, 'orientation'),
                duplex: field(text, 'duplex'),
                color_mode: field(text, 'color_mode'),
                page_range: field(text, 'page_range'),
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: true, job_id: 4242 }));
        });
        return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[mock-easyprinter] listening on http://127.0.0.1:${PORT}`);
});
