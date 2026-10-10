/**
 * 【2026-10-10】题间**从属关系**（主题 / 附题）—— **规则只写这一处**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 他那天要的东西（原话提炼）
 *
 * 两道题考点一致、甚至只是题干变了变 ⇒ 一道当**主题**，其余当**附题**挂上去。
 * 以后"模仿纸"就是：照着主题的答案与解析，让孩子去做附题（"我如何能对"）。
 *
 * 他给的规则很多，但**核心只有一句**：
 *   **一道题最多有一个主题；主题绝不会是任何题的附题**（深度只许一层）。
 * 于是所有操作都退化成"改一个指针"——
 *   取关 = 把指针置空；关联 = 把指针指过去；升变 = 把两道题的指针互换并接走附题。
 * ⇒ 他原本担心的"标过已掌握之后建不回关系、要翻日志、占空间"**不存在**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是个**纯函数模块**（不碰数据库）
 *
 * 这套规则的状态空间不大但分支极碎（谁当主题 / 已有主题怎么办 / 已掌握怎么传 / 删主题谁接班），
 * 而且**出错的方式都是"多步操作之后关系树悄悄坏了"**——那种错只有纯函数 + 单测能拦住，
 * 靠点界面试是很难试出来的。所以：本模块只做算术与判定，写库交给调用方（接口）。
 *
 * ⚠️ 三件事**不在**这里做（由调用方负责）：
 *   ① 鉴权与 userId 过滤；② 真正写库；③ 写留痕（`StateChangeLog`，字段名用 `parentId`）。
 *      —— 留痕是"已掌握断开之后还能一键恢复"的依据：从最近的
 *      `field='parentId' && toValue=null` 那条记录里把 `fromValue` 读回来即可。
 */

/** 一道题在从属关系里的角色 */
export type LinkRole =
    /** 孤题：没有主题、也没有附题 */
    | 'lone'
    /** 主题（母题）：没有主题，但挂着附题 */
    | 'root'
    /** 附题（子题）：挂在某个主题下面 */
    | 'child';

/**
 * 参与判定的题目。**只带规则用得到的字段** —— 这样单测里造数据不用把一整道题拼齐，
 * 也让"规则只吃这些输入"这件事在类型上就看得见。
 */
export interface LinkNode {
    id: string;
    /** 题号（界面与提示里说的"题号"）。⚠️ 老题可能没有 ⇒ 调用方传 `source || id` */
    no: string;
    /** 主题的 id；null = 没有主题 */
    parentId: string | null;
    /**
     * 录入时间（ISO）。
     * ⚠️ 它的唯一用途是"删主题时谁来接班"——他的原话是"排序第一的附题自动成为主题"，
     *    "第一"必须有个确定口径，取**录入时间最早**（稳定、看得懂，且不会因为改了别的字段变序）。
     */
    createdAt: string;
    /** 是否已掌握（`masteryLevel === 2`）。只影响"人工标记才断"那条规则与显示 */
    mastered: boolean;
}

/** 一条要写回库的改动（只写变化的字段） */
export interface LinkOp {
    id: string;
    parentId: string | null;
}

export interface LinkChoice {
    /** 可选的"谁当主题"候选（各自当前挂着几道附题，供他判断） */
    candidates: { id: string; no: string; childCount: number }[];
    /**
     * 推荐谁当主题。**默认推荐"原本就是主题的那一个"** —— 理由：他的规则是
     * "关系已定就别轻易翻"，少动一棵已经整理好的树。
     */
    recommended: string;
}

export interface LinkPlan {
    ok: boolean;
    /** 要写回库的关系改动（不含掌握状态） */
    ops: LinkOp[];
    /** 非空 = **不能直接做**，得先让他拍板"谁当主题"（两边都已经是主题时） */
    choice?: LinkChoice;
    /** 给人看的一句话（成功 / 拒绝 / 要拍板，都说清） */
    message: string;
}

/* ------------------------------------------------------------------ */
/* 基础判定                                                            */
/* ------------------------------------------------------------------ */

export function byId(nodes: readonly LinkNode[], id: string): LinkNode | undefined {
    return nodes.find((n) => n.id === id);
}

/** 直接挂在这一道题下面的附题（按录入时间升序 = "排序第一"就是 `[0]`） */
export function childrenOf(nodes: readonly LinkNode[], id: string): LinkNode[] {
    return nodes
        .filter((n) => n.parentId === id)
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/**
 * 往上追到主题。
 *
 * ⚠️ 正常情况下**最多走一步**（不变量：深度只许一层）。这里写成循环 + 上限，
 *    是为了"万一库里已经有脏数据（历史遗留/手工改的）"也不至于死循环 ——
 *    脏数据要能被发现，而不是把页面卡住。
 */
export function rootOf(nodes: readonly LinkNode[], id: string): LinkNode | undefined {
    let cur = byId(nodes, id);
    for (let hop = 0; cur && cur.parentId && hop < 8; hop++) {
        const up = byId(nodes, cur.parentId);
        if (!up) break; // 父题不存在（被硬删/不在这一批数据里）⇒ 就认它自己是当前已知的最高一层
        cur = up;
    }
    return cur;
}

export function roleOf(nodes: readonly LinkNode[], id: string): LinkRole {
    const self = byId(nodes, id);
    if (!self) return 'lone';
    if (self.parentId) return 'child';
    return childrenOf(nodes, id).length > 0 ? 'root' : 'lone';
}

/**
 * 题号的显示兜底：没有题号就用 id（与打印那边 `source || id` 同一口径）。
 *
 * @param fallbackId 只有"这道题压根不在这一批数据里"时才用得上（比如主题已被删）。
 *                   不给就统一显示一句人话，别把 undefined 漏到提示文案里。
 */
function label(node: LinkNode | undefined, fallbackId = ''): string {
    if (!node) return fallbackId || '（已删除的题）';
    return node.no || node.id;
}

/* ------------------------------------------------------------------ */
/* 建立关联                                                            */
/* ------------------------------------------------------------------ */

/**
 * 建立关联：把 `childId` 挂到 `targetId` 这棵树下面。
 *
 * ── 他给的四条真规则，全都落在这里 ─────────────────────────────────
 * ① **扫到的是附题，就把新题挂到它所属的主题上**（不是挂在附题身上）。
 *    他的原话："先扫描到题B，然后在题B中扫描题C ⇒ 从属关系实际记录是将题C关联到题A"。
 * ② **已经在同一棵树里** ⇒ 明确告诉他"不必再关联"（而不是默默重复建一遍）。
 * ③ 两边**都已经是主题**（各自有附题）⇒ 不能替他决定 ⇒ 返回 `choice` 让他拍板
 *    （推荐保住原来那棵）。
 * ④ 他自己指定了谁当主题（`chooseRootId`，来自那个选择框）⇒ 按他选的做：
 *    被选中的当主题，另一棵（连同它自己）整体接过来。
 *
 * ⚠️ "接过来"要连**对方原有的附题**一起接（他要求："题A所有附题都将记录改为主题为题C"），
 *    否则会出现"附题的附题"——那违反深度只有一层的不变量。
 */
export function planLink(
    nodes: readonly LinkNode[],
    childId: string,
    targetId: string,
    chooseRootId?: string,
): LinkPlan {
    const child = byId(nodes, childId);
    const target = byId(nodes, targetId);
    if (!child) return { ok: false, ops: [], message: `要关联的那道题不在（${label(child, childId)}）` };
    if (!target) return { ok: false, ops: [], message: `被关联的那道题不在（${label(target, targetId)}）` };
    if (child.id === target.id) {
        return { ok: false, ops: [], message: '同一道题，不需要和自己建立关联。' };
    }

    /** 真实的挂靠点：目标是附题 ⇒ 用它所属的主题（规则①） */
    const targetRoot = rootOf(nodes, target.id) ?? target;
    const childRoot = rootOf(nodes, child.id) ?? child;

    // 已经在同一棵树里 ⇒ 不必再建（规则②）
    if (targetRoot.id === childRoot.id) {
        return {
            ok: false,
            ops: [],
            message: `「${label(child)}」已经在这道主题下面了，不必再关联。`,
        };
    }

    const childKids = childrenOf(nodes, childRoot.id);
    const targetKids = childrenOf(nodes, targetRoot.id);

    /**
     * 定方向：谁当主题。
     * ⚠️ 这段是**唯一**决定方向的地方 —— 改动列表和那句提示都由它推出来，
     *    绝不另写一遍（两处判方向，迟早有一处先被改、两边不一致）。
     */
    let rootId: string;
    if (chooseRootId) {
        // 他拍板了（来自选择框）⇒ 按他选的；认不出就退回推荐
        rootId = chooseRootId === childRoot.id ? childRoot.id : targetRoot.id;
    } else if (childKids.length > 0 && targetKids.length > 0) {
        // 两边**各自都有附题** = 两边都是主题 ⇒ 不能替他决定（规则③）
        return {
            ok: false,
            ops: [],
            choice: {
                candidates: [
                    { id: childRoot.id, no: label(childRoot), childCount: childKids.length },
                    { id: targetRoot.id, no: label(targetRoot), childCount: targetKids.length },
                ],
                // 推荐保住"原本就是主题的那一个"（少动一棵已经整理好的树）
                recommended: childRoot.id,
            },
            message: '这两道题各自都已经是一组题的主题了，需要先定谁当主题。',
        };
    } else if (childKids.length > 0) {
        // 它自己挂着附题 ⇒ 它必须是主题（附题不能有附题）
        rootId = childRoot.id;
    } else {
        // 常规：被关联的那个当主题
        rootId = targetRoot.id;
    }

    /**
     * "接过来"：把另一个根**整棵**（含它自己）挂到 `rootId` 下面。
     * ⚠️ 必须连它原有的附题一起接（他要求："题A所有附题都将记录改为主题为题C"），
     *    否则就会出现"附题的附题"，违反深度只有一层的不变量。
     */
    const otherRoot = rootId === targetRoot.id ? childRoot : targetRoot;
    const toMove = [otherRoot, ...childrenOf(nodes, otherRoot.id)];
    const ops: LinkOp[] = toMove.map((n) => ({ id: n.id, parentId: rootId }));

    const message =
        toMove.length === 1
            ? `「${label(otherRoot)}」已关联到主题「${label(byId(nodes, rootId), rootId)}」。`
            : `「${label(otherRoot)}」那一组（含它自己共 ${toMove.length} 道）已并入主题「${label(byId(nodes, rootId), rootId)}」名下。`;

    return { ok: true, ops, message };
}

/* ------------------------------------------------------------------ */
/* 取关 / 升变                                                         */
/* ------------------------------------------------------------------ */

/** 取关：把这道附题从主题下面摘下来，它就成了孤题（主题那边的清单自然少一条） */
export function planUnlink(nodes: readonly LinkNode[], childId: string): LinkPlan {
    const self = byId(nodes, childId);
    if (!self) return { ok: false, ops: [], message: '这道题不在。' };
    if (!self.parentId) return { ok: false, ops: [], message: '这道题本来就没有关联主题。' };

    const kids = childrenOf(nodes, self.id);
    if (kids.length > 0) {
        /**
         * 它自己还挂着附题 ⇒ 不能一摘了事（摘完就成"附题的附题"了，违反不变量）。
         * 这种状态**理论上不该出现**（能挂附题的只有主题），真出现说明数据脏了 ⇒
         * 明确拒绝并说清，别顺手改出一棵歪树。
         */
        return {
            ok: false,
            ops: [],
            message: `「${label(self)}」自己还挂着 ${kids.length} 道题，不能直接取关（数据可能有问题，请先处理它下面的题）。`,
        };
    }
    const parent = byId(nodes, self.parentId);
    return {
        ok: true,
        ops: [{ id: self.id, parentId: null }],
        message: `已取消「${label(self)}」与主题「${label(parent, self.parentId)}」的关联。`,
    };
}

/**
 * 升变：这道**附题**顶掉原来的主题。
 *
 * 他的原话（照抄要点）："点击后这道附题变成主题，原主题所有附题全都加载过来（除了这道题），
 * 原主题变为这道题的附题，原主题下的所有附题（除了这道题）都将主题的记录改为这道题。"
 * ⇒ 两道题的指针互相对调，其余附题改挂到新主题上。
 */
export function planPromote(nodes: readonly LinkNode[], childId: string): LinkPlan {
    const self = byId(nodes, childId);
    if (!self) return { ok: false, ops: [], message: '这道题不在。' };
    if (!self.parentId) return { ok: false, ops: [], message: '这道题本来就是主题/孤题，不需要升变。' };
    const oldRoot = byId(nodes, self.parentId);
    if (!oldRoot) {
        // 主题不在这一批数据里（可能被删了）⇒ 至少把它自己立起来，别让它悬着
        return {
            ok: true,
            ops: [{ id: self.id, parentId: null }],
            message: `原来的主题已不在，已把「${label(self)}」独立出来。`,
        };
    }

    const others = childrenOf(nodes, oldRoot.id).filter((n) => n.id !== self.id);
    const ops: LinkOp[] = [
        { id: self.id, parentId: null },
        { id: oldRoot.id, parentId: self.id },
        ...others.map((n) => ({ id: n.id, parentId: self.id })),
    ];
    return {
        ok: true,
        ops,
        message: `「${label(self)}」已升为主题，接过了原主题「${label(oldRoot)}」及其 ${others.length} 道附题。`,
    };
}

/* ------------------------------------------------------------------ */
/* 已掌握：只有**人工标记**才断开关联（他 2026-10-10 拍板）              */
/* ------------------------------------------------------------------ */

export interface MasteryPlan {
    /** 要改 parentId 的（人工标记附题为已掌握时才可能非空） */
    ops: LinkOp[];
    /** 掌握状态要跟着变的题（含自身与传播到的附题） */
    masteryIds: string[];
    /** 被他人工断开的那道题原来挂在谁下面 —— 存进留痕，供"恢复关联"用 */
    detachedFrom: string | null;
    message: string;
}

/**
 * 标记"已掌握 / 未掌握"。
 *
 * ── 规则（他拍板的那三条）──────────────────────────────────────────
 * ① **人工**把**附题**标为已掌握 ⇒ 它**断开**关联变孤题；再改回未掌握**不自动建回**，
 *    但界面上给一个"恢复关联"（依据留痕里的 `detachedFrom`，一键写回，不翻旧账）。
 * ② **主题**标为已掌握 ⇒ 它下面**所有附题也标已掌握**，但**关系保持不动**。
 * ③ **系统/AI** 判定（`manual: false`）**绝不断开关联** ——
 *    否则"主题已掌握"传播一次就会把整棵树拆了（这是他那份稿子里自相矛盾的地方，
 *    我们讨论后按这条定案）。
 */
export function planMastery(
    nodes: readonly LinkNode[],
    id: string,
    mastered: boolean,
    opts: { manual: boolean },
): MasteryPlan {
    const self = byId(nodes, id);
    if (!self) return { ops: [], masteryIds: [], detachedFrom: null, message: '这道题不在。' };

    /** 主题 id（null = 它不是附题）。用局部变量是为了让 TS 收窄 —— 直接写 `self.parentId` 收不了 */
    const pid = self.parentId;
    const kids = childrenOf(nodes, self.id);

    // ① 人工 + 附题 + 标为已掌握 ⇒ 断开
    if (opts.manual && mastered && pid) {
        return {
            ops: [{ id: self.id, parentId: null }],
            masteryIds: [self.id],
            detachedFrom: pid,
            message: `「${label(self)}」标为已掌握，已与主题「${label(byId(nodes, pid), pid)}」脱开关联（以后可以一键恢复）。`,
        };
    }

    // ② 主题（或孤题）⇒ 自己变，附题跟着变；**关系一律不动**
    const ids = kids.length > 0 ? [self.id, ...kids.map((k) => k.id)] : [self.id];
    if (kids.length > 0) {
        return {
            ops: [],
            masteryIds: ids,
            detachedFrom: null,
            message: mastered
                ? `主题「${label(self)}」标为已掌握，名下 ${kids.length} 道附题一并标为已掌握（关联保持不变）。`
                : `主题「${label(self)}」改回未掌握，名下 ${kids.length} 道附题一并改回。`,
        };
    }

    // ③ 孤题：只有自己
    return {
        ops: [],
        masteryIds: ids,
        detachedFrom: null,
        message: `「${label(self)}」标为${mastered ? '已掌握' : '未掌握'}。`,
    };
}

/**
 * 恢复关联（"一键恢复"）：把留痕里记的原主题写回去。
 *
 * ⚠️ 两个前提都要满足才恢复：① 原主题**还在**（没被删）；② 这道题现在是孤题
 *    （否则会覆盖掉它新的关联 —— 那等于用旧账改新账）。
 */
export function planRestore(
    nodes: readonly LinkNode[],
    childId: string,
    detachedFrom: string | null,
): LinkPlan {
    const self = byId(nodes, childId);
    if (!self) return { ok: false, ops: [], message: '这道题不在。' };
    if (self.parentId) return { ok: false, ops: [], message: '这道题现在已经有主题了，不需要恢复。' };
    if (!detachedFrom) return { ok: false, ops: [], message: '没有找到当初的关联记录，恢复不了。' };
    const parent = byId(nodes, detachedFrom);
    if (!parent) return { ok: false, ops: [], message: '原来的主题已经不在了（可能被删了），没法恢复。' };
    // 原主题若自己也变成了附题（升变过），就挂到它现在所属的主题上
    const target = rootOf(nodes, parent.id) ?? parent;
    if (target.id === self.id) return { ok: false, ops: [], message: '原来的主题现在是这道题自己，没法恢复。' };
    return {
        ok: true,
        ops: [{ id: self.id, parentId: target.id }],
        message: `已恢复「${label(self)}」与主题「${label(target)}」的关联。`,
    };
}

/* ------------------------------------------------------------------ */
/* 删除                                                                */
/* ------------------------------------------------------------------ */

export interface DeletePlan {
    /** 进回收箱的题（**含被删的那一道**） */
    trashIds: string[];
    /** 关系改动（未掌握时"接班"要用） */
    ops: LinkOp[];
    /** 给确认框用的一句话 —— 他会看到"会连带删几道" */
    message: string;
}

/**
 * 删除一道题时，它名下的附题怎么办。
 *
 * 他的规则：
 *   · 这道题**未掌握** ⇒ 排序第一（录入最早）的附题**接班当主题**，其余附题的指针改挂到它；
 *   · 这道题**已掌握** ⇒ 连同名下所有附题一起删（"这一组已经掌握过了，不用留"）。
 * ⚠️ 删除在本项目里是**软删**（进回收箱），所以这两种都不是不可逆的；
 *    但已掌握那条仍然要在确认框里**说清会连带几道**（他点了才知道要删多少）。
 */
export function planDelete(nodes: readonly LinkNode[], id: string): DeletePlan {
    const self = byId(nodes, id);
    if (!self) return { trashIds: [], ops: [], message: '这道题不在。' };

    const kids = childrenOf(nodes, self.id);
    if (kids.length === 0) {
        return { trashIds: [self.id], ops: [], message: '这道题没有关联的附题。' };
    }

    if (self.mastered) {
        return {
            trashIds: [self.id, ...kids.map((k) => k.id)],
            ops: [],
            message: `这道主题已标为已掌握，删除会**同时删掉名下 ${kids.length} 道附题**，一起进回收箱。`,
        };
    }

    const heir = kids[0];
    const rest = kids.slice(1);
    return {
        trashIds: [self.id],
        ops: [
            { id: heir.id, parentId: null },
            ...rest.map((k) => ({ id: k.id, parentId: heir.id })),
        ],
        message: `这道主题未掌握，名下 ${kids.length} 道附题里「${label(heir)}」（录入最早）将接任主题，其余 ${rest.length} 道改挂到它下面。`,
    };
}

/* ------------------------------------------------------------------ */
/* 不变量自检（单测与排查用）                                            */
/* ------------------------------------------------------------------ */

/**
 * 检查这棵树还符不符合不变量，返回**违反项的说明**（空数组 = 健康）。
 *
 * 为什么要这个：这套规则的分支极碎，最可怕的不是"操作报错"，
 * 而是"操作成功了、关系树却悄悄歪了"（比如出现附题的附题）。
 * 单测里每次操作之后跑一遍它，歪了当场就红。
 */
export function linkInvariantViolations(nodes: readonly LinkNode[]): string[] {
    const out: string[] = [];
    for (const n of nodes) {
        if (!n.parentId) continue;
        const parent = byId(nodes, n.parentId);
        if (!parent) {
            out.push(`${label(n)} 的主题不存在（悬空指针）`);
            continue;
        }
        if (parent.parentId) {
            out.push(`${label(n)} → ${label(parent)} → ${label(byId(nodes, parent.parentId), parent.parentId)}：出现了"附题的附题"（深度必须只有一层）`);
        }
        if (parent.id === n.id) out.push(`${label(n)} 的主题是它自己`);
    }
    return out;
}
