/**
 * 【2026-10-16 真真】**错题列表接口返回哪些标量字段** —— 唯一出处。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要有这个文件（这是"打开错题本要 10 秒"那件事的修复）
 *
 * 空空 2026-10-16 实测：局域网打开"小五上数学大库"（**才 66 道题**），
 * 错题卡出来要 **10 秒**。
 *
 * **根因**：`/api/error-items/list` 原来只写 `include`、**没有 `select`**
 * ⇒ Prisma 返回 `ErrorItem` 的**全部 38 个标量字段**，其中 `originalImageUrl`
 * 是**题图 base64**：
 *   · 上传时按 `compressImage(maxSizeMB = 1)` 压（`lib/image-utils.ts`）⇒ **单张最大约 1.37MB**；
 *   · 默认每页 **18 条** ⇒ 一次请求最多约 **24MB**；打印预览/回收箱是 `pageSize=200` ⇒ 最多约 **274MB**。
 * 而 NAS 实测吞吐约 3.6MB/s ⇒ 光传输就要好几秒，再叠加"弱 CPU 从 SQLite 读 24MB + 序列化"⇒ **10 秒对得上**。
 *
 * **实测（真 Prisma + 真 SQLite，18 题 × 每张 400KB 图）**：
 *
 * | 写法 | 响应体 | 查库 | 序列化 |
 * |---|---|---|---|
 * | 原样（带图） | **9.40 MB** | 148 ms | 98 ms |
 * | **不读图（本文件这套）** | **23.9 KB** | **23 ms** | 1 ms |
 * | 查完再在 JS 里摘掉图 | 23.9 KB | 143 ms | 1 ms |
 *
 * ⇒ 响应体缩小 **400 倍**，而且**连库都不用读那 9MB**（所以选"不读"而不是"读完再摘"）。
 *
 * ⚠️ **哪些调用方真的需要题图**（2026-10-18 如如更正，**别再照下面那句旧结论做**）：
 *
 *    真真 2026-10-16 当时逐个查过 **6 个调用方** ——
 *    `error-list` / `scan-volume-view` / `review-volumes` / `trash` / `print-preview` / 详情页 `mode=ids`，
 *    结论写的是"**只有打印预览需要题图**"。**这个结论错了**，代价是两个屏静默无图：
 *
 *    | 调用方 | 要不要图 | 为什么当时漏了 |
 *    |---|---|---|
 *    | `print-preview` | ✅ 要（已传） | 一眼看得出（要印题图） |
 *    | **`review-volumes`（打开某一卷）** | ✅ **要** | 它要画"这张纸"的预览，题图是纸的一部分 |
 *    | **`scan-volume-view`（扫到某一卷）** | ✅ **要** | 同上，而且这屏就是"按纸的样子看" |
 *    | `error-list` / `trash` / 详情页 `mode=ids` | ❌ 不要 | 只显示题干文字，不画图 |
 *
 *    📌 判据不是"有没有出现 `originalImageUrl` 这个名字"（那三个要图的文件**从来没写这个名字**，
 *       它们是让 `useFigureImages(item)` 自己从 `item.originalImageUrl` 里取的）——
 *       **真正的判据是"这一屏要不要把纸画出来"**。
 *    📌 这条由 `__tests__/unit/image-needers-guard.test.ts` 钉住（三个文件必须都带 `withImages`）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ 维护约定
 *
 * **schema 里给 `ErrorItem` 加了新字段 ⇒ 这里要同步加**，否则新字段读不到。
 * 这件事**不靠人记**：`__tests__/unit/list-fields-sync.test.ts` 会拿 `prisma/schema.prisma`
 * 逐字段比对，漏一个就红。（同 `review-event-wiring.test.ts` / `schema-write-paths.test.ts` 的路子。）
 */

/**
 * 列表接口**默认**返回的标量字段。
 * ⚠️ 顺序无所谓（只是可读性），但**内容必须与 schema 对齐**（有测试钉住）。
 */
export const LIST_ITEM_SCALARS = [
    'id',
    'userId',
    'notebookId',
    'ocrText',
    'questionText',
    'answerText',
    'analysis',
    'wrongAnswerText',
    'mistakeAnalysis',
    'mistakeStatus',
    'knowledgePoints',
    'source',
    'errorType',
    'userNotes',
    'mistakeCategory',
    'masteryLevel',
    'levelCountdown',
    'gradeSemester',
    'paperLevel',
    'manageType',
    'manageTypeSource',
    'emojiMark',
    'printCount',
    'reviewPrintCount',
    'attention',
    'reviewOutcomes',
    'levelLedger',
    'deepNudgeDismissed',
    'redoCount',
    'mergeSource',
    'deletedAt',
    'lastPrintedAt',
    'inputMethod',
    'cropRegions',
    'createdAt',
    'updatedAt',
    'parentId',
] as const;

/**
 * **唯一被排除的字段**：题图（base64）。
 *
 * ⚠️ 排除它**不是为了省几个字节** —— 它单张最大约 1.37MB，是其它 37 个字段加起来的几百倍。
 * 需要它的调用方传 `?withImages=1`。
 */
export const LIST_ITEM_OMITTED = ['originalImageUrl'] as const;
