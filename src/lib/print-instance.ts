/**
 * 二维码里的「打印实例」编码 —— P25.1：**必须三层，不是两层**
 *
 * 格式： <题号> · <打印实例> · <面>
 * 示例： SX20260916001-R2-B
 *                          └─ F = 正面（反思面）／ B = 背面（重做面）
 *                   └─ 该题第 2 次打印的那张纸
 *                       （R1 = 第 0 天的 T1；R2 / R3 = 第 7 / 21 天的 T0）
 *            └─ 题号（全链路统一大写，见 P10）
 *
 * 为什么「打印实例」这一层必须有（P25.1 的原始理由）：
 *   只有「题号 + 面」两层时会撞车 —— 同一道题会被重印多次（第 0 天 T1、第 7 天 T0、
 *   第 21 天 T0）。两次打印的纸都被扫回来时，两条记录抢同一道题的同一个面，
 *   **后扫的静默覆盖先扫的**：软件不报错，数据悄悄被改坏。
 *
 * 本模块只做纯编解码，不碰数据库、不碰 DOM。
 */

export type PrintSide = 'F' | 'B';

/** 正面 = 反思面（看原图回忆、写"我卡在哪"） */
export const SIDE_FRONT: PrintSide = 'F';
/** 背面 = 重做面（净版题 + 空白，重做） */
export const SIDE_BACK: PrintSide = 'B';

export const PRINT_SIDES: readonly PrintSide[] = [SIDE_FRONT, SIDE_BACK];

/** 题号形状：<学科 2 字母大写简拼><8 位日期><3 位当日流水>，与 lib/question-no.ts 一致 */
const QUESTION_NO_RE = /^[A-Z]{2}\d{11}$/;

/** 完整的打印实例码 */
const INSTANCE_CODE_RE = /^([A-Z]{2}\d{11})-R(\d+)-([FB])$/;

export interface PrintInstanceCode {
    questionNo: string;
    instanceNo: number;
    side: PrintSide;
}

export function isPrintSide(value: unknown): value is PrintSide {
    return value === SIDE_FRONT || value === SIDE_BACK;
}

export function isValidQuestionNo(value: unknown): value is string {
    return typeof value === 'string' && QUESTION_NO_RE.test(value);
}

/**
 * 组装打印实例码。题号先 trim + 大写化（P10：全链路统一大写）。
 *
 * ⚠️ 非法入参**抛错而不产出坏码**：坏码一旦印到纸上、扫回来才发现，返工成本远高于现在报错。
 */
export function buildPrintInstanceCode(
    questionNo: string,
    instanceNo: number,
    side: PrintSide,
): string {
    const no = String(questionNo ?? '').trim().toUpperCase();
    if (!isValidQuestionNo(no)) {
        throw new Error(`invalid question no: ${questionNo}`);
    }
    if (!Number.isInteger(instanceNo) || instanceNo < 1) {
        throw new Error(`invalid instance no: ${instanceNo}`);
    }
    if (!isPrintSide(side)) {
        throw new Error(`invalid side: ${side}`);
    }
    return `${no}-R${instanceNo}-${side}`;
}

/**
 * 解析打印实例码。形状不对一律返回 null ——
 * 调用方据此走 P25.5 的兜底（靠四角角标 + 页面比例特征定位，交人确认），
 * 而不是猜一个编号出来。
 */
export function parsePrintInstanceCode(raw: unknown): PrintInstanceCode | null {
    if (typeof raw !== 'string') return null;
    const m = INSTANCE_CODE_RE.exec(raw.trim().toUpperCase());
    if (!m) return null;

    const instanceNo = Number(m[2]);
    if (!Number.isInteger(instanceNo) || instanceNo < 1) return null;

    const side = m[3];
    if (!isPrintSide(side)) return null;

    return { questionNo: m[1], instanceNo, side };
}

/**
 * 另一面。读到一个码就知道同一张纸的另一面该是什么 ——
 * 配对时的判据，也是「只扫到一面」兜底的依据（P25.5）。
 */
export function oppositeSide(side: PrintSide): PrintSide {
    return side === SIDE_FRONT ? SIDE_BACK : SIDE_FRONT;
}
