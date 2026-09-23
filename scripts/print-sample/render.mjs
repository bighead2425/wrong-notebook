#!/usr/bin/env node
/**
 * 错题卡打样 / 回归 —— 版面改动的「验尸台」
 *
 *   node scripts/print-sample/render.mjs [选项]
 *
 * 做的事：题目数据 → 卡片 HTML → B5 双面 PDF → 逐题页数/尺寸报表 → 判据结果
 *
 * 【为什么需要它】这套卡片是**一题一页正面 + 一页背面**，打印时要靠
 * 「奇数页打正面、偶数页打背面」手动双面（家里打印机不支持自动双面）。
 * 只要有一道题的解析太长、把卡片撑成第 3 页，**它后面所有题的正反面就全部错位**，
 * 而这件事肉眼在屏幕上完全看不出来 —— 必须真的生成 PDF 去数页数。
 * 仓库里已经写着一例（globals.css:270-273 注释）："实测 5 题只出 4 页，
 * 且答案与题目同页，孩子一眼看见答案"。
 *
 * 【与设计的冲突提醒】当前卡面印着解析 / 错因 / 答案，这与二次设计定稿的
 * 「解析、答案、错因一律不上卡」**方向相反**（见 P1–P7）。本脚本不关这个事，
 * 它只负责"量"，先把尺子交出去；版式怎么改是 M3 的活。
 * 改完之后，把 --expect-pages 撑住，这条命令就是版面回归的守门人。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildSampleHtml } from './lib/card-html.mjs';
import { measurePdf, checkSize, EXPECTED } from './lib/measure.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** 学科简拼 → subjectKey（题号前两位就是简拼，见 components/subject-chip.tsx 的「天然冗余」注释） */
const CODE_TO_KEY = {
  SX: 'math', YW: 'chinese', YY: 'english', WL: 'physics', HX: 'chemistry',
  SW: 'biology', ZZ: 'politics', LS: 'history', DL: 'geography',
};

// ---------------------------------------------------------------- 参数

const HELP = `
错题卡打样 / 回归

用法: node scripts/print-sample/render.mjs [选项]

数据源（二选一，默认用内置夹具）
  --items <json>        题目 JSON 文件（默认 fixtures/sample-3q.json）
  --sqlite <file.db>    从 Prisma 的 SQLite 库读 ErrorItem（真实题库）
  --limit <n>           --sqlite 时取最近 n 条（默认 50）

版面参数（默认值与 print-preview 页面一致）
  --space <mm>          重做区留白高度，默认 35（页面滑块默认值，下限 30）
  --image-scale <%>     原图宽度占比，默认 70
  --duplex              加「手动双面」翻面提示
  --expect-pages <n>    每题预期页数，默认 2（一题两页：正面 + 背面）

内容开关（默认全开，与页面默认一致）
  --no-question --no-image --no-analysis --no-mistake --no-answers --no-tags

输出
  --out <dir>           产物目录，默认 scripts/print-sample/out
  --css <file[,file]>   指定 CSS，默认自动扫 .next/static/css/*.css
  --strict              不达标时退出码 1（给 CI / 提交前用）
  --port <n>            本地静态服务端口，默认自动挑
  -h, --help            显示本帮助
`;

function parseArgs(argv) {
  const o = {
    items: null, sqlite: null, limit: 50, out: path.join(HERE, 'out'), css: null,
    spaceMM: 35, imageScale: 70, duplex: false, expectPages: 2, strict: false, port: 0,
    showQuestion: true, showImage: true, showAnalysis: true, showMistake: true,
    showAnswers: true, showTags: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--items': o.items = next(); break;
      case '--sqlite': o.sqlite = next(); break;
      case '--limit': o.limit = Number(next()); break;
      case '--out': o.out = path.resolve(next()); break;
      case '--css': o.css = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--space': o.spaceMM = Number(next()); break;
      case '--image-scale': o.imageScale = Number(next()); break;
      case '--duplex': o.duplex = true; break;
      case '--expect-pages': o.expectPages = Number(next()); break;
      case '--strict': o.strict = true; break;
      case '--port': o.port = Number(next()); break;
      case '--no-question': o.showQuestion = false; break;
      case '--no-image': o.showImage = false; break;
      case '--no-analysis': o.showAnalysis = false; break;
      case '--no-mistake': o.showMistake = false; break;
      case '--no-answers': o.showAnswers = false; break;
      case '--no-tags': o.showTags = false; break;
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      default: fail(`未知参数：${a}（用 --help 看用法）`);
    }
  }
  return o;
}

function fail(msg) {
  console.error(`\n[错误] ${msg}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------- 数据源

function normItem(raw, i) {
  const source = raw.source || `#${i + 1}`;
  const code = String(source).slice(0, 2).toUpperCase();
  return {
    source,
    subjectKey: raw.subjectKey || CODE_TO_KEY[code] || 'other',
    gradeText: raw.gradeText || raw.grade || '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    questionText: raw.questionText || '',
    analysis: raw.analysis || '',
    mistakeAnalysis: raw.mistakeAnalysis || '',
    answerText: raw.answerText || '',
    printCount: raw.printCount || 0,
    // 兼容三种写法：新字段 / 旧脚本的 img / 手写
    image: raw.originalImageUrl || raw.imageUrl || raw.img || null,
    qrText: raw.qrText || null,
  };
}

function loadFromJson(file) {
  if (!fs.existsSync(file)) fail(`题目 JSON 不存在：${file}`);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { fail(`题目 JSON 解析失败：${e.message}`); }
  const arr = Array.isArray(data) ? data : data.items || data.data;
  if (!Array.isArray(arr)) fail('题目 JSON 必须是数组，或含 items / data 数组字段');
  return { items: arr.map(normItem), baseDir: path.dirname(path.resolve(file)) };
}

async function loadFromSqlite(file, limit) {
  if (!fs.existsSync(file)) fail(`数据库不存在：${file}`);
  let Database;
  try {
    // better-sqlite3 随 @prisma/adapter-better-sqlite3 一起装，通常已在 node_modules。
    Database = (await import('better-sqlite3')).default;
  } catch {
    fail('读 SQLite 需要 better-sqlite3。它随 @prisma/adapter-better-sqlite3 安装；\n'
      + '       若报模块找不到，执行：npm i -D better-sqlite3');
  }
  const db = new Database(file, { readonly: true });
  let rows;
  try {
    rows = db.prepare(
      `SELECT source, questionText, answerText, analysis, mistakeAnalysis,
              originalImageUrl, printCount, notebookId
         FROM ErrorItem
        WHERE deletedAt IS NULL
        ORDER BY createdAt DESC
        LIMIT ?`
    ).all(limit);
  } catch (e) {
    db.close();
    fail(`查 ErrorItem 失败（表结构不符？）：${e.message}`);
  }
  // 年级从 Notebook 表补（取不到不致命）
  const nb = new Map();
  try {
    for (const r of db.prepare('SELECT id, subject, gradeSemester FROM Notebook').all()) nb.set(r.id, r);
  } catch { /* Notebook 表名/字段可能不同，忽略 */ }
  db.close();

  const items = rows.map((r, i) => {
    const it = normItem(r, i);
    const n = r.notebookId ? nb.get(r.notebookId) : null;
    if (n) it.gradeText = [n.gradeSemester, n.subject].filter(Boolean).join(' · ');
    return it;
  });
  return { items, baseDir: REPO };
}

// ---------------------------------------------------------------- 图片

const MIME = {
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  html: 'text/html; charset=utf-8', pdf: 'application/pdf',
};

/**
 * 把每题的图片落到 out/assets/，并改写成 out 目录下的相对 URL。
 * 统一复制而不是直接引原路径，是为了避免路径穿越与"图在仓库外"的情况。
 */
function stageImages(items, baseDir, outDir) {
  const assetsDir = path.join(outDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  let copied = 0;
  const missing = [];

  items.forEach((it, i) => {
    if (!it.image) return;
    let src = it.image;
    // 站内绝对路径（如 /uploads/xxx.png）→ 映射到仓库 public 下
    if (src.startsWith('/')) src = path.join(REPO, 'public', src);
    else src = path.resolve(baseDir, src);

    if (!fs.existsSync(src)) { missing.push(it.source); it.image = null; return; }
    const ext = (path.extname(src) || '.png').toLowerCase();
    const name = `img-${String(i + 1).padStart(3, '0')}${ext}`;
    fs.copyFileSync(src, path.join(assetsDir, name));
    it.image = `assets/${name}`;
    copied++;
  });
  return { copied, missing };
}

// ---------------------------------------------------------------- CSS

function resolveCss(opts) {
  if (opts.css) {
    const out = [];
    for (const p of opts.css) {
      const abs = path.resolve(p);
      if (!fs.existsSync(abs)) fail(`指定的 CSS 不存在：${abs}`);
      const rel = path.relative(REPO, abs).split(path.sep).join('/');
      out.push({ href: '/' + rel, abs });
    }
    return out;
  }
  const dir = path.join(REPO, '.next', 'static', 'css');
  if (!fs.existsSync(dir)) {
    fail('找不到 .next/static/css —— 打样必须用**真实构建产物的样式**，\n'
      + '       否则量出来的不是线上那张纸。请先跑：npm run build\n'
      + '       （或从部署中取得 CSS 后，用 --css <file> 指定）');
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.css')).sort();
  if (!files.length) fail(`.next/static/css 目录里没有 .css 文件：${dir}`);
  return files.map((f) => ({ href: `/.next/static/css/${f}`, abs: path.join(dir, f) }));
}

/** next/font 把字体变量挂在 <html> 的 class 上；不打这个 class，字体就会回退、文本占高失真。 */
function findFontClass(cssList) {
  for (const c of cssList) {
    const txt = fs.readFileSync(c.abs, 'utf8');
    const m = txt.match(/\.([_a-zA-Z0-9-]+)\s*\{\s*--font-geist-sans/);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------- 静态服务

function serveRepo(port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const abs = path.join(REPO, urlPath);
    // 防目录穿越：解析后必须仍在 REPO 内
    if (!abs.startsWith(REPO)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(abs, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(abs).slice(1).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const o = parseArgs(process.argv.slice(2));

  const { items, baseDir } = o.sqlite
    ? await loadFromSqlite(path.resolve(o.sqlite), o.limit)
    : loadFromJson(o.items ? path.resolve(o.items) : path.join(HERE, 'fixtures', 'sample-3q.json'));

  if (!items.length) fail('没有拿到任何题目');

  fs.mkdirSync(o.out, { recursive: true });
  const staged = stageImages(items, baseDir, o.out);

  const cssList = resolveCss(o);
  const fontClass = findFontClass(cssList);

  const opts = {
    spaceMM: o.spaceMM, imageScale: o.imageScale, manualDuplex: o.duplex,
    dateText: new Date().toISOString().slice(0, 10).replace(/-/g, '/'),
    showQuestion: o.showQuestion, showImage: o.showImage, showAnalysis: o.showAnalysis,
    showMistake: o.showMistake, showAnswers: o.showAnswers, showTags: o.showTags,
  };

  const html = buildSampleHtml({ items, cssHrefs: cssList.map((c) => c.href), fontClass, opts });
  const htmlPath = path.join(o.out, 'card.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  console.log('='.repeat(78));
  console.log('错题卡打样');
  console.log('='.repeat(78));
  console.log(`题目来源   ${o.sqlite ? o.sqlite : o.items || '内置夹具 fixtures/sample-3q.json'}`);
  console.log(`题目数量   ${items.length} 题`);
  console.log(`样式表     ${cssList.map((c) => c.href.replace('/.next/static/css/', '')).join(', ')}`);
  console.log(`字体 class ${fontClass || '（未找到，字体可能回退 → 文本占高会失真）'}`);
  console.log(`版面参数   留白 ${Math.max(o.spaceMM, 30)}mm · 图片宽 ${o.imageScale}%` +
    ` · 解析 ${yn(o.showAnalysis)} · 错因 ${yn(o.showMistake)} · 答案 ${yn(o.showAnswers)} · 翻面提示 ${yn(o.duplex)}`);
  if (staged.copied) console.log(`图片       已就位 ${staged.copied} 张`);
  if (staged.missing.length) console.log(`⚠️ 图片缺失  ${staged.missing.join(', ')}（该题按无图渲染）`);

  // 起服务 + 打印
  const { server, port } = await serveRepo(o.port);
  const pw = await import('@playwright/test');
  const chromium = pw.chromium || pw.default?.chromium;
  if (!chromium) fail('拿不到 Playwright 的 chromium（@playwright/test 是否已安装？）');

  const browser = await chromium.launch();
  let pdfBuf;
  try {
    const page = await browser.newPage();
    await page.emulateMedia({ media: 'print' });
    await page.goto(`http://127.0.0.1:${port}/` + path.relative(REPO, htmlPath).split(path.sep).join('/'),
      { waitUntil: 'load' });
    // 等字体真正加载完，否则会按回退字体分页
    await page.evaluate(() => document.fonts.ready);
    pdfBuf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close();
    server.close();
  }

  const pdfPath = path.join(o.out, 'card.pdf');
  fs.writeFileSync(pdfPath, pdfBuf);

  // ---------------------------------------------------------------- 报表
  const m = measurePdf(pdfBuf);
  const sizeChecks = checkSize(m.sizes);
  const sizeOk = sizeChecks.every((s) => s.ok);

  const expectTotal = items.length * o.expectPages;
  const perItemFloat = m.pages / items.length;

  console.log('-'.repeat(78));
  console.log('PDF        ' + path.relative(REPO, pdfPath).split(path.sep).join('/') +
    `   ${(m.bytes / 1024).toFixed(0)} KB`);
  console.log(`页数       实测 ${m.pages} 页 ｜ 题目 ${items.length} 题 × ${o.expectPages} 页 = 预期 ${expectTotal} 页`);
  console.log(`尺寸       实测 ${m.sizes.join(' , ')} ｜ 预期 ${EXPECTED.w}×${EXPECTED.h}mm（国产 B5） ${sizeOk ? '✔' : '✘'}`);
  if (m.countHint.length) console.log(`交叉核对   页树 /Count = [${m.countHint.join(',')}]（与上面的页数应一致；不一致说明 PDF 结构特殊）`);
  console.log('-'.repeat(78));

  // 逐题页数无法从 PDF 单独读出（PDF 不记录"哪页属于哪题"）。
  // 但可以给一个很强的统计判据：总页数 + 平均每题页数。
  if (m.pages > expectTotal) {
    console.log(`⚠️ 溢出 ${m.pages - expectTotal} 页（平均每题 ${perItemFloat.toFixed(2)} 页 > ${o.expectPages}）`);
    console.log('   含义：至少有一道题的内容把卡片撑成了第 3 页。');
    console.log('   后果：手动双面时「奇数页打正面、偶数页打背面」会从那道题开始全部错位，');
    console.log('         且可能把背面的错因/答案印到题目的同一面（孩子一眼看见答案）。');
    console.log('   排查：把 --space 调小、或 --no-analysis / --no-mistake 逐个关掉，看是哪一块撑爆的。');
  } else if (m.pages < expectTotal) {
    console.log(`⚠️ 少了 ${expectTotal - m.pages} 页（平均每题 ${perItemFloat.toFixed(2)} 页 < ${o.expectPages}）`);
    console.log('   多半是 .print-tail 的 break-before:page 没生效（父级 break-inside 一旦为 avoid，');
    console.log('   子元素的分页指令会被浏览器直接忽略）——参见 globals.css:270-273 的注释。');
  } else {
    console.log(`✔ 页数正好（每题 ${o.expectPages} 页）`);
  }
  if (!sizeOk) {
    console.log('✘ 尺寸不对：若实测是 210×297mm，说明样式表没生效（退回 A4 了）——检查 CSS 路径。');
    console.log('  参见 globals.css「@page」注释：CSS 简写 `size: B5` 是 ISO B5(176×250)，');
    console.log('  比国产纸小，满页排版会跑版，所以必须写明确毫米数 182mm 257mm。');
  }

  const pass = m.pages === expectTotal && sizeOk;
  console.log('-'.repeat(78));
  console.log(pass ? '结论：PASS' : '结论：FAIL');
  if (o.strict && !pass) process.exit(1);
}

function yn(v) { return v ? '开' : '关'; }

main().catch((e) => { console.error(e); process.exit(2); });
