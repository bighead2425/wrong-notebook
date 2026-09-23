# 错题卡打样 / 回归

```
题目数据  →  卡片 HTML  →  B5 双面 PDF  →  逐题页数 / 尺寸报表  →  判据
```

一条命令，量出"这套版面印出来到底是几页、是不是 B5"。

---

## 一、为什么需要它

错题卡是**一题两页**：正面一页、背面 `.print-tail` 一页。家里打印机不支持自动双面，
所以打印时靠 **「奇数页打正面、偶数页打背面」**（见 print-preview 页面的「手动双面（翻面提示）」开关）。

由此产生一个**屏幕上完全看不出来**的坑：

> 只要有一道题的解析太长、把卡片撑成第 3 页，
> **它后面所有题的正反面就全部错位**，而且可能把背面的错因/答案印到题目那一面。

仓库里已经踩过两次，都留了证据：

| 证据 | 位置 | 现象 |
|---|---|---|
| 代码注释 | `src/app/globals.css:270-273` | 「实测 5 题只出 4 页，且答案与题目同页，孩子一眼看见答案」 |
| 旧打样产物 | 2026-09-24 实测 `real/real1.pdf` | 1 道题占 **4 页**（解析 1000+ 字撑爆）；同期 `real0.pdf` 占 3 页 |
| **本脚本自测** | 2026-09-24 跑内置夹具 | 3 道合成题出 **7 页**（预期 6）。逐页看过：第 2 题的解析太长，把「解析 + 重做区」整块挤到了下一页 —— **它的正面页只剩题头和题目，下面一片空白**；而背面内容顺延到第 5 页 |

> 内置夹具只有 3 道题就复现了 —— 这不算巧，因为**真实题库比夹具更糟**：
> 实测 50 道真实错题，解析长度中位 **588 字**、最长 **1373 字**，而夹具里最长那道才 1000 字出头。
> 也就是说，**现在这套版式在真实数据上大概率会大面积溢出**。

⇒ 结论：**这件事必须真的生成 PDF 去数页数，不能靠肉眼在屏幕上判断。**
这个脚本就是那把尺子。

---

## 二、快速开始

```bash
# 1) 打样必须用「真实构建产物的样式」，否则量出来的不是线上那张纸
npm run build

# 2) 跑
npm run print:sample
#   等同于：node scripts/print-sample/render.mjs
```

产物：

| 文件 | 用途 |
|---|---|
| `scripts/print-sample/out/card.pdf` | 打样 PDF，用浏览器打开逐页核对 |
| `scripts/print-sample/out/card.html` | 生成的 HTML，改版式时对着看很方便 |
| `scripts/print-sample/out/assets/` | 从题目数据里落到本地的图片 |

命令行输出是一张报表，末尾给 `PASS` / `FAIL`：

```
题目数量   3 题
样式表     8ae56d4bd873c4cd.css, fdac6bbf6bfe4fdb.css
字体 class __variable_246ccd
页数       实测 7 页 ｜ 题目 3 题 × 2 页 = 预期 6 页
尺寸       实测 182.0x257.2mm ｜ 预期 182×257mm（国产 B5） ✔
⚠️ 溢出 1 页（平均每题 2.33 页 > 2）
结论：FAIL
```

---

## 三、判据（回归测试就是这两条）

| 项 | 期望 | 不达标意味着 |
|---|---|---|
| **总页数** | `题数 × expect-pages`（默认 2） | 某题的卡片被撑爆（多页）或 `.print-tail` 没断页（少页） |
| **每页尺寸** | `182.0 × 257.0 mm` | 尺寸变成 210×297 = 样式表没生效、退回 A4 了 |

**为什么尺寸这一条同时是"CSS 加载探针"**：`@page { size: 182mm 257mm }` 写在
`@media print` 里（`globals.css:164`）。CSS 没加载成功就退回 Chromium 默认 A4，
尺寸立刻暴露问题 —— 不用再另外写一个"CSS 是否生效"的检查。

> 顺带记住一条硬知识（`globals.css:159-163` 的注释）：
> **CSS 简写 `size: B5` 是 ISO B5 = 176×250mm，比国产纸（JIS B5 = 182×257mm）每边小 6mm，
> 满页排版会跑版**，所以实现里必须写明确毫米数，不能图省事用 `B5`。

---

## 四、常用选项

```bash
node scripts/print-sample/render.mjs --help
```

| 选项 | 说明 |
|---|---|
| `--items <json>` | 用指定题目 JSON（默认内置夹具） |
| `--sqlite <file.db>` | 直接读 Prisma 的 SQLite 库（真实题库） |
| `--limit <n>` | `--sqlite` 时取最近 n 条，默认 50 |
| `--space <mm>` | 重做区留白高度，默认 **35**（与页面滑块默认值一致，下限 30） |
| `--image-scale <%>` | 原图宽度占比，默认 **70** |
| `--duplex` | 加「手动双面」翻面提示 |
| `--expect-pages <n>` | 每题预期页数，默认 2 |
| `--no-analysis` / `--no-mistake` / `--no-answers` / `--no-image` / `--no-question` / `--no-tags` | 关掉对应内容块（**排查"是哪一块把卡片撑爆的"就靠这个**） |
| `--strict` | 不达标时退出码 1（**给 CI / 提交前用**） |
| `--css <file[,file]>` | 手动指定样式表（拿不到 `.next` 时用） |

**排查溢出的推荐手法**（二分法）：

```bash
node scripts/print-sample/render.mjs --no-analysis    # 解析关掉还溢出 → 不是解析的锅
node scripts/print-sample/render.mjs --space 20 --no-answers
```

---

## 五、数据从哪来

### 1. 内置夹具（默认）
`fixtures/sample-3q.json` —— **3 道合成题**，覆盖三种情况（短解析 / 长解析 / 带图）。
任何机器 clone 下来就能跑，不依赖数据库、不依赖网络。

### 2. 真实题库
有两种方式：

**方式 A：从 NAS 导出 JSON**（推荐，最省事）

```bash
node scripts/print-sample/render.mjs --items /path/to/items.json --limit 50
```

JSON 结构（字段名与 `ErrorItem` 表对齐，所以从库里导出来基本能直接用）：

```json
[{
  "source": "SX20260910001",
  "subjectKey": "math",
  "gradeText": "五年级 · 上学期",
  "tags": ["小数乘法"],
  "questionText": "……",
  "originalImageUrl": "img-001.png",
  "analysis": "……",
  "mistakeAnalysis": "……",
  "answerText": "……",
  "printCount": 0
}]
```

兼容写法：`originalImageUrl` / `imageUrl` / `img` 三者任选其一；
`subjectKey` 不填时会**从题号前两位自动推**（`SX` → `math`），
因为题号前两位本来就是学科简拼（见 `components/subject-chip.tsx` 的「天然冗余」注释）。

**方式 B：直接读本地库**

```bash
node scripts/print-sample/render.mjs --sqlite prisma/dev.db --limit 50
```

需要本地有库（`npm run build` 不带库，得先 `prisma db push` 或从 NAS 拷一份）。
它内部用 `better-sqlite3` 只读打开，**不依赖 `prisma generate`**，也不写任何数据。
> `better-sqlite3` 是随 `@prisma/adapter-better-sqlite3` 一起装进来的；
> 若报模块找不到，执行 `npm i -D better-sqlite3`。

---

## 六、⚠️ 隐私红线（最重要的一条）

**孩子的真实题目文本、真实作业照片，一律不得提交进这个仓库。**

- 本仓库可能公开（GitHub: `bighead2425/wrong-notebook`），一旦提交就无法真正撤回；
- `fixtures/` 里**全是合成内容**，`placeholder.svg` 是画出来的占位图，不是任何人的作业；
- 真实数据打样请用 `--items <本地文件>` 或 `--sqlite <本地库>`，**路径指向仓库之外或已被忽略的位置**；
- `scripts/print-sample/out/` 已在 `.gitignore` 里排除（产物会包含真实题目渲染结果）。

> 提交前自查：`git status --short scripts/print-sample/`
> 只应看到 `render.mjs`、`lib/`、`fixtures/`、`README.md`，**不应出现 `out/`**。

---

## 七、已知限制（接手前务必读）

### 1. 这是**复刻**，不是真身（最大的风险）

`lib/card-html.mjs` 复刻自 `src/app/print-preview/page.tsx` 的 `ErrorCard`（309-432 行）。
复刻的理由：打样要能**不启动服务、不登录**就跑（真实页面依赖 NextAuth 登录态 + 客户端勾选状态）。

代价：**真身改了结构而这里没同步 → 打样结果失真，且不会报错。**

- 核对方法：`npm run dev` 打开 `/print-preview`，与打样 PDF 逐块比对；
- 改版式（M3）时：**先改这里，再改真身**，或者干脆走下面的「演进建议」。

### 2. Markdown 渲染是近似

真身用 `MarkdownRenderer`（含 **KaTeX 公式排版**）；这里把 `$...$` 当普通文本。
公式多的题，占高会与真身有差异。

⇒ **页数的绝对值可信度中等；相对变化（改版式后页数有没有降）可信。**
⇒ 要做"页数绝对值"的硬门禁，必须先解决这一条（见下）。

### 3. 二维码是占位框

真身印真二维码（`qrMap`），这里画一个 18×18mm 的虚线框占位（同尺寸）。
**它不测二维码内容**，只保证不因缺码而影响版式。

### 4. 逐题页数读不出来

PDF 里不记录"哪一页属于哪道题"，所以只能给**总数判据** + "平均每题页数"。
想知道是哪道题撑爆的，用 `--no-*` 二分排查（见 §四）。

### 5. 建议的演进（等 M3 版式定稿之后再做）

把打样改成**打真实页面**：起服务 → 用 `storageState` 带上登录态 →
打开 `/print-preview?ids=...` → `page.pdf()`。这样彻底消除 §7.1 和 §7.2 两条偏差。

现在不做的理由：M3 要重写整个卡面，版式未定之前先把复刻做精是白费功夫；
而"能跑、能数页数、能守住尺寸"这条底线，现在已经有了。

---

## 八、与二次设计的关系

⚠️ **当前卡面印着解析、错因、答案 —— 这与二次设计定稿的方向相反。**

二次设计（见 vault `错题本开发/二次设计/`）定的是：**解析、答案、错因一律不上卡**，
正面留给她反思、背面留给她重做（P1–P7）。所以 M3 是**重构**，要先"删"再"加"。

**本脚本不管这件事**，它只负责"量"。但改造完成后，它就变成版面回归的守门人：

```bash
# 把这条放进提交前检查 / CI（--strict 让不达标直接失败）
npm run print:sample -- --strict
```

---

## 九、文件清单

| 文件 | 职责 |
|---|---|
| `render.mjs` | 主链路：读数据 → 起静态服务 → Chromium 打印 → 测量 → 报表 |
| `lib/card-html.mjs` | 卡面 HTML 模板（⚠️ 复刻品，见 §7.1） |
| `lib/measure.mjs` | PDF 测量，**零依赖**（读字节数 `/Type /Page` 与 `/MediaBox`） |
| `fixtures/sample-3q.json` | 合成夹具（3 题，可提交） |
| `fixtures/placeholder.svg` | 占位图（合成，可提交） |
| `out/` | 产物，已 gitignore |

关于 `lib/measure.mjs` 的可靠性：2026-09-24 用 PyMuPDF 逐份对照过 4 个既有产物，
页数与尺寸**全部一致**（`A_noduplex` 2/2、`B_duplex` 2/2、`real0` 3/3、`real1` 4/4）。
所以这里刻意不引 pdf-lib / pdfjs / PyMuPDF —— 少一个依赖，少一台机器装环境。
