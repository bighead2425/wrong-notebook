import { PROMOTE_BOX, promoteDirectionFor } from '@/lib/manage-type';

/**
 * 纸面上的**升降级小框**（她也参与判断）。
 *
 * ── 一句话 ──────────────────────────────────────────────────────
 * 纸角上放一个小框，她勾一下就代表"我有意见"；不勾 = 没意见，系统按原流程走。
 *
 * ── 三条必须守住（出处：`二次设计/流程图连接笔记/18_升降级小框.md`）──────────
 *  ① **按「题的类型」印，不按「纸」印** —— 深挖题进了复练纸也只印"降级"；
 *     复练题进了深挖纸也只印"升级"。方向由 `promoteDirectionFor(manageType)` 定，
 *     本组件**不许**接收"纸型"来决定形态。
 *  ② **必须带文字**（"升级"/"降级"），不能只靠颜色 ——
 *     打印/复印会把颜色吃掉一层，黑白出来红和灰蓝都是灰的。
 *  ③ ⚠️ **版面上不写"只有打勾算数"**（画叉、画圈、涂黑一律不认）。
 *     那条规则写在**回收逻辑**里并配测试，不印到纸上：
 *     印上去等于指导她"怎么勾才算数"，反而把她的表达限制了。
 *
 * 未定等级 ⇒ **按复练处理**（印"升级"），所以纸上每道题都有这个框（2026-09-28 改）。
 *
 * 两处用到：深挖纸背面（遮挡线左下 / 她动笔区顶部）、复练纸每题留白区内虚线之上。
 */

export interface PromoteBoxProps {
    /** 这道题的错题等级（deep / review / 未定）——**不是纸型** */
    manageType?: string | null;
    /** 语言取词（两个卡片都接了同一套 L 工具） */
    L: (zh: string, en: string) => string;
}

export function PromoteBox({ manageType, L }: PromoteBoxProps) {
    /**
     * ⚠️ 这里**不再有"未定就不印"**的分支（2026-09-28 去掉）：
     * 方向函数现在对空值也返回一个方向（复练 ⇒ 升级），
     * 所以纸上**每道题都有框**。理由见 `lib/manage-type.ts` 的 `promoteDirectionFor`。
     */
    const box = PROMOTE_BOX[promoteDirectionFor(manageType)];

    return (
        <div
            className="print-promote-box"
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '1.5mm',
                flexShrink: 0,
            }}
        >
            {/* 空方框：给她勾的地方（她自己打勾；不打勾 = 没意见） */}
            <span
                style={{
                    display: 'inline-block',
                    width: '6mm',
                    height: '6mm',
                    border: '0.3mm solid #444',
                    background: '#ffffff',
                }}
            />
            {/* 文字必须印（见上面 ②）；颜色只作辅助 */}
            <span
                style={{
                    fontSize: '9pt',
                    fontWeight: 600,
                    color: box.color,
                    whiteSpace: 'nowrap',
                }}
            >
                {box.arrow} {L(box.label, box.labelEn)}
            </span>
        </div>
    );
}
