/**
 * 纸面上的日期写法 —— **统一 `yyyy-mm-dd`**。
 *
 * 为什么单独一个模块：纸面上出现的日期有好几处（复习日期格、身份条上的打印日），
 * 它们必须**写法一致**；而日期格式化又最容易出「本地时区 vs UTC 差一天」
 * 这种**不报错、只印错**的问题，所以要能被单测钉住。
 *
 * ⚠️ 一律用**本地时间**字段（getFullYear / getMonth / getDate），
 *    不要用 `toISOString()`（它是 UTC，晚上打印会印成前一天）——
 *    这个坑在别的项目上踩过，纸面上的日期错一天没人会立刻发现。
 *
 * ⚠️ 2026-09-24 改定：原先写 `9/25`（月/日、不补零），空空看纸样后说
 *    "看上去不舒服"，且跨年时 `10/1` 分不清哪一年 ⇒ 全项目纸面统一 yyyy-mm-dd。
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-09-25` —— 纸面唯一格式（复习日期格、身份条打印日都用这个） */
export function formatIsoDate(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
