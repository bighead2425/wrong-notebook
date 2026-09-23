/**
 * 卡面 HTML 模板 —— 复刻 `src/app/print-preview/page.tsx` 的「错题卡（G7）」结构
 *
 * ⚠️⚠️ 读这份文件的人请注意（这句话很重要）
 * ------------------------------------------------------------------
 * 这是**复刻**，不是真身。真身是 React 组件 `ErrorCard`（print-preview/page.tsx:309-432）。
 * 复刻的理由：打样脚本要能在**不起服务、不登录**的情况下跑，而真实页面依赖
 * NextAuth 登录态 + 客户端状态（勾选、滑块）。
 *
 * 由此带来两个**已知会漂移**的地方，改版式时务必留意：
 *   ① 真身改了结构而这里没同步 → 打样结果失真，**且不会报错**。
 *      核对方法：`npm run dev` 打开 /print-preview，与打样 PDF 逐块比对。
 *   ② Markdown 渲染是**近似**：真身用 MarkdownRenderer（含 KaTeX 公式排版），
 *      这里把 `$...$` 原样当文本，公式占高会与真身不同。
 *      ⇒ 页数的**绝对值**可信度中等；**相对变化**（改了版式以后页数有没有降）可信。
 *      ⇒ 彻底解决办法见 README「已知限制」：改打真实页面。
 *
 * 结构对应关系（行号为 2026-09-24 的 print-preview/page.tsx）：
 *   318-335 题头（学科色标 + 题号 + 二维码占位）  → subjectChip() / qrPlaceholder()
 *   337-348 元信息行（第 N 题｜年级｜知识点｜日期｜已打 N 次）
 *   351-356 原题圆角框（文字 + 虚线 + 原图）
 *   359-390 解析左 / 重做区右（B9：右手在纸右边写字方便）
 *   393-429 背面 .print-tail（翻面提示 + 重做续 + 错因框 + 参考答案）
 */

/** 学科色标 —— 复制自 src/lib/subject-colors.ts:21-30。改动需同步。 */
const SUBJECTS = {
  math:      { code: 'SX', label: '数学', hex: '#D32F2F' },
  chinese:   { code: 'YW', label: '语文', hex: '#E65100' },
  english:   { code: 'YY', label: '英语', hex: '#1565C0' },
  physics:   { code: 'WL', label: '物理', hex: '#6A1B9A' },
  chemistry: { code: 'HX', label: '化学', hex: '#00838F' },
  biology:   { code: 'SW', label: '生物', hex: '#2E7D32' },
  politics:  { code: 'ZZ', label: '政治', hex: '#AD1457' },
  history:   { code: 'LS', label: '历史', hex: '#795548' },
  geography: { code: 'DL', label: '地理', hex: '#455A64' },
  other:     { code: 'OT', label: '其他', hex: '#212121' },
};

export function subjectDef(key) {
  return SUBJECTS[key] || SUBJECTS.other;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 极简 Markdown → HTML（近似，见文件头警告 ②）
 * 只处理打样会遇到的：标题、粗体、行内代码、无序列表、表格、分段、公式占位。
 */
export function mdToHtml(md) {
  if (!md) return '';
  const lines = esc(String(md).replace(/\r\n/g, '\n')).split('\n');
  const out = [];
  let buf = [];      // 当前段落
  let list = [];     // 当前列表
  let table = [];    // 当前表格

  const flushP = () => {
    if (buf.length) { out.push(`<p>${buf.join(' ')}</p>`); buf = []; }
  };
  const flushList = () => {
    if (list.length) { out.push(`<ul>${list.map((t) => `<li>${t}</li>`).join('')}</ul>`); list = []; }
  };
  const flushTable = () => {
    if (!table.length) return;
    // 去掉 Markdown 表格的分隔行（|---|---|）
    const rows = table.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
    const cells = rows.map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    const head = cells[0] || [];
    const body = cells.slice(1);
    out.push(
      '<table style="border-collapse:collapse;font-size:9.5pt;width:100%">' +
        `<tr>${head.map((c) => `<th style="border:1px solid #999;padding:0.8mm 1.5mm">${c}</th>`).join('')}</tr>` +
        body.map((r) => `<tr>${r.map((c) => `<td style="border:1px solid #999;padding:0.8mm 1.5mm">${c}</td>`).join('')}</tr>`).join('') +
      '</table>'
    );
    table = [];
  };
  const flushAll = () => { flushP(); flushList(); flushTable(); };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushAll(); continue; }

    if (/^\|.*\|/.test(line.trim())) { flushP(); flushList(); table.push(line.trim()); continue; }
    flushTable();

    if (/^[-*+]\s+/.test(line.trim())) {
      flushP();
      list.push(inline(line.trim().replace(/^[-*+]\s+/, '')));
      continue;
    }
    flushList();

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushP();
      out.push(`<p style="font-weight:700">${inline(h[2])}</p>`);
      continue;
    }

    // 独立成行的公式：真身用 KaTeX 排版，这里保留文本并标注（见文件头警告 ②）
    buf.push(inline(line));
  }
  flushAll();
  return out.join('');
}

/** 行内标记：粗体 + 行内代码。公式 $...$ 保持原样。 */
function inline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="font-size:0.95em">$1</code>');
}

function subjectChip(item) {
  const def = subjectDef(item.subjectKey);
  return `<span class="subject-chip" style="display:inline-flex;align-items:center;justify-content:center;gap:1.5mm;min-width:9mm;padding:0 2mm;height:7mm;border-radius:1.5mm;background:${def.hex};color:#FFFFFF;font-size:10pt;font-weight:700;letter-spacing:0.3px;line-height:1;flex-shrink:0"><span>${esc(def.label)}</span></span>`;
}

/** 二维码位置：真身印真码（qrMap）。打样用同尺寸占位框，避免脚本里再跑一遍二维码生成。 */
function qrPlaceholder(item) {
  const label = item.qrText ? esc(item.qrText) : 'QR';
  return `<div class="print-qr" title="${label}" style="width:18mm;height:18mm;flex-shrink:0;border:1px dashed #bbb;border-radius:1mm;display:flex;align-items:center;justify-content:center;font-size:6pt;color:#bbb">QR</div>`;
}

/** 正面：题头 + 元信息 + 原题框 + 两栏（解析左 / 重做区右） */
function front(item, index, o) {
  const tags = (item.tags || []).join('；');
  const hasText = o.showQuestion && !!item.questionText;
  const hasImg = o.showImage && !!item.imageUrl;

  return `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:3mm;margin-bottom:2mm">
                    <div style="display:flex;align-items:center;gap:2mm;min-width:0">
                        ${subjectChip(item)}
                        <span style="font-size:12pt;font-weight:700;letter-spacing:0.5px">${esc(item.source || `#${index + 1}`)}</span>
                    </div>
                    ${qrPlaceholder(item)}
                </div>

                <div style="display:flex;justify-content:space-between;gap:4mm;font-size:9pt;color:#444;margin-bottom:2.5mm">
                    <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">第 ${index + 1} 题 ｜ ${esc(item.gradeText || '')}${o.showTags && tags ? ` ｜ ${esc(tags)}` : ''}</span>
                    <span style="white-space:nowrap;flex-shrink:0">${esc(o.dateText)}${typeof item.printCount === 'number' && item.printCount > 0 ? ` ｜已打 ${item.printCount} 次` : ''}</span>
                </div>

                <div class="print-rounded-box" style="border:1.5px solid #333;border-radius:2mm;padding:2.5mm;margin-bottom:3mm">
                    ${hasText ? `<div style="margin-bottom:2mm">${mdToHtml(item.questionText)}</div>` : ''}
                    ${hasText && hasImg ? '<div style="border-top:1px dashed #888;margin-bottom:3mm"></div>' : ''}
                    ${hasImg ? `<img src="${esc(item.imageUrl)}" alt="" style="max-width:${o.imageScale}%;height:auto;display:block">` : ''}
                </div>

                <div class="print-two-col" style="display:flex;gap:3mm;align-items:flex-start">
                    <div style="flex:1 1 52%;min-width:0">
                        ${o.showAnalysis && item.analysis ? `<div class="print-sub-title" style="font-weight:600;font-size:10pt;margin-bottom:1mm">解析</div>` : ''}
                        ${o.showAnalysis && item.analysis ? `<div style="font-size:10pt">${mdToHtml(item.analysis)}</div>` : ''}
                    </div>
                    <div style="flex:1 1 48%;min-width:0;align-self:stretch;border-left:2px solid #555;padding-left:3mm">
                        <div style="font-size:9pt;color:#666;margin-bottom:1mm">重做区</div>
                        <div class="print-answer-space" style="height:${Math.max(o.spaceMM, 30)}mm"></div>
                    </div>
                </div>`;
}

/** 背面：翻面提示 + 重做续 + 错因框 + 参考答案 */
function tail(item, o) {
  const hasCause = o.showMistake && !!item.mistakeAnalysis;
  return `
                <div class="print-tail" style="margin-top:6mm">
                    ${o.manualDuplex ? `<div class="print-flip-hint" style="border:1px dashed #888;border-radius:2mm;padding:2.5mm;margin-bottom:4mm;font-size:9pt;color:#555">↩ 请在此处翻面 —— 下面是本题的背面（把纸按「短边翻转」放回纸盒）</div>` : ''}
                    <div style="font-size:9pt;color:#666;margin-bottom:1mm">重做区（续）</div>
                    <div class="print-answer-space" style="height:${Math.max(o.spaceMM, 30)}mm;margin-bottom:4mm"></div>
                    ${hasCause ? `<div class="print-rounded-box" style="border:1.5px solid #999;border-radius:2mm;padding:2.5mm;margin-bottom:3mm">
                        <div class="print-sub-title" style="font-weight:600;font-size:10pt;margin-bottom:1mm">错因分析</div>
                        <div style="font-size:10pt">${mdToHtml(item.mistakeAnalysis)}</div>
                    </div>` : ''}
                    ${o.showAnswers && item.answerText ? `<div class="print-faint" style="font-size:11pt">
                        <div class="print-sub-title" style="font-weight:700;margin-bottom:1mm">参考答案</div>
                        ${mdToHtml(item.answerText)}
                    </div>` : ''}
                </div>`;
}

/**
 * 生成整份打样 HTML。
 *
 * ⚠️ 所有卡片必须放在**同一个 `.print-sheet` 容器内**：
 * `.print-card { break-before: page }` 靠 `:first-of-type { break-before: auto }`
 * 让第一张卡不起新页。若每题各包一层容器，每张卡都会变成 first-of-type ⇒ 全都不断页、挤成一坨。
 * （对应 print-preview/page.tsx:559-568）
 */
export function buildSampleHtml({ items, cssHrefs, fontClass, opts }) {
  const cards = items
    .map((it, i) => `<div class="print-card">${front(it, i, opts)}${tail(it, opts)}</div>`)
    .join('\n');

  const links = cssHrefs.map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN"${fontClass ? ` class="${esc(fontClass)}"` : ''}>
<head>
<meta charset="utf-8">
<title>错题卡打样 · ${items.length} 题</title>
${links}
<style>
  /* 静态服务器下的兜底：真身由 Next 的 html/body class 提供这些，这里补齐以免背景色差异 */
  html, body { background: #ffffff; color: #111111; margin: 0; }
  @media screen { body { padding: 8mm 0; } }
</style>
</head>
<body>
<div class="print-sheet">
${cards}
</div>
</body>
</html>
`;
}
