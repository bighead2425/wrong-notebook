# ROADMAP · Smart Wrong Notebook

> 本文件只记录**做什么、什么顺序、怎么算做完**。
> 背景推演、真实题库统计与设计取舍放在私有笔记里，不进仓库（本仓库为公开仓库）。
>
> 最后更新：2026-09-24

## 一、当前状态

| 项 | 值 |
|---|---|
| 线上版本 | `custom-v36` |
| 镜像 | `ghcr.io/bighead2425/wrong-notebook`（双标签 `custom-vN` + `custom-latest`） |
| 技术栈 | Next.js 16 · React 19 · Prisma + SQLite · Tailwind v4 · Radix UI |
| 部署 | GitHub Actions 构建镜像 → GHCR → NAS 上的 watchtower 自动拉取重建 |

## 二、发版流程

1. **本地验证**（缺一不可）：
   ```bash
   npx tsc --noEmit
   npm run lint:gate
   npm run test:unit
   npm run test:integration
   ```
2. 提交并推送 `main`
3. GitHub Actions 手动 dispatch **`Manual Docker Build & Publish`**，tag 填 `custom-vN`
4. NAS 的 watchtower 在 5 分钟内自动拉 `custom-latest` 重建

> 自 **2026-09-24** 起，第 3 步带测试门禁（`build-docker.yml` 的 `verify` job）：
> 测试不过就不构建镜像。此前这个路径**一个测试 job 都没有**，生产镜像未经任何验证就上线。

## 三、质量门禁现状

| 门禁 | 状态 | 说明 |
|---|---|---|
| Unit Tests | ✅ 绿 | |
| Integration Tests | ✅ 绿 | |
| Build Check | ✅ 绿 | |
| Lint Gate | ✅ 新增 | **基线式**：存量 189 error 不阻塞，新增 error 一律拦下。见 `scripts/lint-baseline.mjs` |
| E2E Tests | ⚠️ **长期红** | 近 16 次运行 **0 次成功**；`e2e/` 用例最后修改于 2026-09-15，此后 UI 历经 v29–v36 大改未同步。**刻意未挂进发版路径** |

## 四、路线图

### 波 0 · 把安全网支起来 ✅ 已完成（2026-09-24）

- [x] 发版路径加测试门禁（`build-docker.yml`）
- [x] `npm run lint:gate` 基线门禁，接入 `ci.yml` 与发版路径
- [x] 修规则文件名 `.cursorrulers` → `.cursorrules`（原先拼错，工具从未读到过）
- [x] 建本文件
- [ ] E2E 处置（修 或 明确摘除）—— **待定**

### 波 1 · M0 + M3：让新卡片印出来（主战场）

分三批交付，**每批可独立验收、独立发版、可回退**。

#### 第 1 批 · M0 数据底座 ✅ 已完成（2026-09-24）

- [x] 数据模型：新增 `PrintBatch` / `PrintJob` / `ScanReturn` / `StateChangeLog` 四张表；
      `ErrorItem` 加 `mistakeCategory`（错因受控枚举，**刻意与外部导入透传的 `errorType` 分开存**）；
      `ReviewSchedule` 加 `round` / `printJobId` / `scanReturnId`
- [x] 迁移 `20260924084421_add_print_pipeline_models`：**只加列、不重建表**
      （生产库里是真实数据，刻意避开 Prisma 默认生成的 `DROP TABLE` + `RENAME` 写法）；
      已用 `migrate diff --from-migrations` 复核，迁移历史与 schema **完全一致**
- [x] 纯函数 + 24 条单测：`lib/print-instance.ts`（二维码三层编解码）、
      `lib/print-job-state.ts`（**当前有效实例 = 最近一次「已回收」的实例**）、`lib/mistake-category.ts`
- [x] 接口 `POST /api/print-jobs`：点打印时创建实例，返回正反两面二维码内容
- [x] 端到端验证：空库跑通全部 12 个迁移；默认值与两条唯一约束**实测生效**
      （同一题同一实例号不可重复 ⇒ 重印不会静默覆盖；同一实例同一面不可重复 ⇒ 重复扫描报错而非覆盖）

> ⚠️ **顺序上的实质改动**：二维码内容是 `<题号>-R<第几次>-<面>`，而"第几次"**只在点打印那一刻才知道**
> ⇒ 必须**先建实例、再生成二维码、最后打印**。旧的"先画码（只含题号）→ 打印 → 记计数"不再成立。

#### 第 2 批 · M3 卡片版面 ⏳ 下一步

- 删掉解析 / 答案 / 错因与两栏分隔线，按 P5 重排：身份条、原题、十字象限、遮挡锚点、四角定位角标；**一题独占正反两面**。
- 反面暂用**带笔迹的原图**（去手写属 M2；待其技术验证就绪后一处切换）。
- 纸型**先不分 4 种**，T1 通吃。

#### 第 3 批 · 打样验收

- 真实题库抽 20 题 → 打成 B5 双面 PDF → 用尺子量：正反各一页、装得下、字高 ≥2.5mm、象限与锚点位置正确。
- **工具**：`npm run print:sample`（`scripts/print-sample/`，Playwright + headless Chromium 出 PDF）。
  ⚠️ 夹具要按**真实原图的尺寸分布**造——新版面的版面波动源是图片宽高比与清晰度，不再是旧的解析长度。

### 波 2 · M4：让纸能回来

二维码三层编码 / 双面配对 / 扫码入库 / 兜底（只扫一面、重复、污损）。
**验收**：打印 20 张 → 故意打乱顺序 → 正反两次扫描 → 全部正确配对。必须写"乱序样本生成器"进测试。

### 并行 spike · M2 净版（技术验证，不占波次）

去手写 → 生成第二张干净题图。依次试：视觉模型重绘 → OCR + 掩码擦除 → inpainting。
**判据**：20 题人眼过，合格率 ≥80% 才集成；否则全面走兜底（反面印"翻回正面看题"）。
**它必须失败得起**，不阻塞任何一波。

### 波 3 · M5：让 AI 看见做过什么

扫回 → AI 输出结构化结果（手写原话、圈画位置、是否重做正确、错因标签）。
**验收**：用真实手写样本，不许用打印体糊弄。另加一条：一批 20 张的耗时与 API 限额占用。

### 波 4 · M6 + 回信版面

提示词跑真实批次。**验收标准不是文采**：① 愿意读 ② 读完不觉得被检查 ③ 下一批还愿意写。

### 波 5 · M7 + M8：让它自己转起来

复习排程（0/7/21）、状态变更日志、家长视图。

> **排序是被依赖关系逼出来的**：没有卡（M3）就没有"第 7 天要印哪张纸"（M7）；
> 没有纸和回流（M3/M4），就读不到手写内容，也就没有"回信"（M6）。

## 五、已知工程债

| # | 债 | 位置 |
|---|---|---|
| 1 | E2E 用例停在 2026-09-15，与当前 UI 已脱节 | `e2e/` |
| 2 | `eslint src` 存量 189 error（167 条 `no-explicit-any`），散在 66 个文件 | `src/` |
| 3 | 超大文件违反自定红线（>200 行需拆） | `error-items/[id]/page.tsx`、`print-preview/page.tsx` 等 |
| 4 | `docker-compose.yml` 与 `docker-compose.https.yml` 指向不同镜像 | 仓库根 |
| 5 | 开发残留页面与根目录临时文件 | `src/app/latex-test/`、`openclaw-integration.patch` |
| 6 | 废弃字段仍在 schema 里 | `schema.prisma`：`knowledgePoints`、`wrongAnswerText`、`gradeSemester` |
| 7 | 文档与代码版本失同步 | `doc/PROJECT_OVERVIEW.md` 自称 v1.5.5，实际 1.9.0 |

## 六、开发纪律

1. **不在本机构建**——开发机内存常年吃紧，`next build` 交 CI。本机只跑 `tsc` / 单测 / lint。
2. **同一文件的多个改动串行提交**，不要并行 Edit（会互相覆盖且各自都返回成功）。
3. **改了数据结构，必须回头改比较/排序函数**——这类 bug 不报错、只静默降级。
4. **两处实现同一件事，必须有交叉验证**（例如图片旋转的矩阵 与 搬框的坐标函数，用单测钉住二者一致）。
5. **收益为零的功能，删掉比修它更对**。
6. 提交前跑 `npm run lint:gate`；随手还了 lint 债就 `npm run lint:gate -- --update` 收紧基线。
