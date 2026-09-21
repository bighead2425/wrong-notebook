/**
 * 【custom-v35】收件箱「选中态对账」——重读列表时该怎么对待用户已经点过的勾。
 *
 * 为什么需要这么一个函数（这是用户现场报的 bug）：
 *   收件箱的列表会因为很多事被重读 —— 打开面板、导入完、删完、**退出照片预览页**……
 *   而重读时如果图省事写成"所有还没导入的一律勾上"，用户手动点的勾就全被冲掉了：
 *
 *     · 点「清除」清掉所有勾 → 进预览看一眼 → 退出来全又被勾上；
 *     · 预览里把 Old 改成 New → 退出后它自动被勾上（哪怕你根本没点选中）；
 *     · 预览里把 New 改成 Old → 退出后它自动被取消（哪怕你刚点上）。
 *
 *   三件事其实是同一件事：**"自动勾选"不该覆盖"用户自己点过的"**。
 *
 * 规则（就两条，能一句话说清，才好验证）：
 *   1. 上次就存在的文件 → **保留用户原来的选择**，不管它现在是新是旧；
 *   2. 这次**新出现**的文件 → 没导入过的默认勾上（这是"新照片默认选中"的本意）。
 *
 *   另外顺手做一件必须做的事：文件已经被删掉的，从勾里剔除，免得勾着一个不存在的名字。
 *
 * @param prevSelected 当前的勾（名字集合）
 * @param prevKnown    上一次列表里的文件名；**传 null 表示"第一次加载"**，
 *                      此时所有文件都算新出现（即老行为：新照片默认全勾）
 * @param files        这次读到的文件
 */
export interface SelectableFile {
    name: string;
    imported: boolean;
}

export function reconcileSelection(
    prevSelected: Iterable<string>,
    prevKnown: ReadonlySet<string> | null,
    files: readonly SelectableFile[],
): Set<string> {
    const present = new Set(files.map((f) => f.name));
    const next = new Set<string>();

    // ① 先接住用户已经点了勾的（文件还在的话）
    for (const n of prevSelected) {
        if (present.has(n)) next.add(n);
    }
    // ② 再补上新出现的未导入照片
    for (const f of files) {
        if (!f.imported && (prevKnown === null || !prevKnown.has(f.name))) {
            next.add(f.name);
        }
    }
    return next;
}
