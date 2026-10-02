/**
 * 【2026-10-03 需求第 10 条】生成"可印刷 emoji 库"。
 *
 * 背景（他的原话）：
 *   每份纸的页眉"印于 yyyy-mm-dd"左边要给一个随机 emoji 标识，像编号二维码一样是纸的属性。
 *   emoji 里有因字体原因画不出来的（中文输入里显示方框的那部分），必须**先筛一遍**，
 *   形成一个单独可供选择的库，以后只从这个库里选；且库里每个符号被选中的概率**均等**。
 *
 * 本脚本**只在开发时跑一次**（不是运行时）：
 *   node scripts/build-emoji-print-library.mjs
 * 读 src/lib/emoji-data.json（1916 条），产出 src/lib/emoji-print-library.json（纯字符数组）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两类筛除：
 *
 * ① 可打印性 —— 保证任何设备/字体都画得出来：
 *    · 含 ZWJ（U+200D）的复合 emoji（家庭、职业组合…）
 *    · 含肤色修饰符（U+1F3FB–U+1F3FF）
 *    · 区域指示符（U+1F1E6–U+1F1FF，国旗/字母块）
 *    · keycap（含 U+20E3）
 *    · 码点数 > 2（两码点 = 基字符 + 变体选择符 U+FE0F，是**核心集**，保留）
 *    · 【我加的】码点 ≥ U+1FA70（Emoji 12 起的新符号，老系统/老字体常画成方框）
 *
 * ② 内容 —— 关键词黑名单（用中文名 n + 关键词 k 匹配）：
 *    骷髅/骨/鬼/恶魔/妖怪/僵尸/棺材/墓碑/墓/死/炸弹/爆炸/刀/匕首/剑/枪/子弹/血/伤/
 *    蜘蛛/蛇/蝎子/蟑螂/虫/老鼠/蝙蝠/呕吐/粪便/中指/愤怒/咒骂/烟/酒/药丸/注射器/针/
 *    赌博/骰子/核/辐射，以及明确的恐怖/负面情绪（恐惧、尖叫、哭泣、悲伤…）。
 *    ⚠️ 黑名单是**拍脑袋定的**，宁可多排（他说的"这库小一点没关系"）。
 * ══════════════════════════════════════════════════════════════════
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRC = join(root, 'src/lib/emoji-data.json');
const OUT = join(root, 'src/lib/emoji-print-library.json');

/** 把 `u` 字段（连字符分隔的十六进制码点）拆成数组 */
function codePoints(u) {
    return String(u || '')
        .split(/[^0-9a-f]+/i)
        .filter(Boolean)
        .map((t) => parseInt(t, 16));
}

const ZWJ = 0x200d;
const VS16 = 0xfe0f;
const SKIN = (cp) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const REGION = (cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const KEYCAP = 0x20e3;
/** 【我加的】Emoji 12（2019）起的新符号块起点；老字体常画不出 */
const NEW_EMOJI_FLOOR = 0x1fa70;

/** 只保留"任何字体都画得出"的字符 */
function isPrintable(entry) {
    const cps = codePoints(entry.u);
    if (cps.length === 0) return false;
    if (cps.length > 2) return false; // 超过两码点（ZWJ 之外也不稳）
    if (cps.includes(ZWJ)) return false;
    if (cps.includes(KEYCAP)) return false;
    if (cps.some(SKIN)) return false;
    if (cps.some(REGION)) return false;
    // 变体选择符 U+FE0F 不算"新符号"，只看基字符
    if (cps.some((cp) => cp !== VS16 && cp >= NEW_EMOJI_FLOOR)) return false;
    return true;
}

/**
 * 内容黑名单 —— **以中文名（n）为主**，只在几个"名字看不出恶意"的场合
 * 再用关键词（k）精确补一刀。
 *
 * ⚠️ 为什么不在 k 上直接铺开匹配：k 是逗号分隔的同义词表，子串太脏 ——
 *    拿 `针` 去匹配 k，`指南针`/`线` 会被误杀；拿 `刀` 匹配 k，`餐具`/`滑冰` 也会中招。
 *    所以 k 只用一小撮**无歧义**的词（咒骂、赌博、脏话）。
 * ⚠️ 刻意"宁可多排"：库小一点无所谓，纸上不能出现让孩子不适的符号。
 */
const DENY_NAME =
    /骷髅|头骨|骨头|骸骨|骨|鬼|幽灵|妖怪|妖精|恶魔|魔鬼|撒旦|食人|僵尸|丧尸|木乃伊|棺|墓碑|墓|坟|丧|死|亡|炸弹|爆炸|爆破|地雷|雷管|手雷|火药|刀|匕首|剑|枪|子弹(?!头)|武器|血|伤|蜘蛛|蛇|蝎子|蟑螂|蟑|蝙蝠|(?<!袋)鼠(?!标)|虫|蠕虫|蚊子|细菌|呕吐|呕|粪便|便便|屎|大便|放屁|屁|中指|愤怒|生气|发怒|狂怒|怒|咒骂|骂|脏话|白眼|傲慢|烟(?!花)|吸烟|香烟|抽烟|酒(?!店)|啤酒|葡萄酒|香槟|鸡尾酒|干杯|碰杯|药丸|药片|注射器|注射|针头|针筒|缝衣针|赌博|骰子|老虎机|赌|核|辐射|放射|生化|恐惧|害怕|惊吓|尖叫|(?<!笑)哭|泪|悲伤|悲|沮丧|失望|难过|烦躁|烦恼|担忧|焦虑|紧张|生病|感冒|发烧|疾病|病毒|恶心|痛苦|疼痛|爆头|敌对|暴躁|抓狂|晕|危险|警告|禁止|有毒|毒|撅嘴|皱眉|坏蛋|心碎|情人/i;
/** 关键词补充：只在 k 上匹配这几个无歧义词 */
const DENY_KEYWORD = /咒骂|脏话|骂|赌博|赌场|赌/i;

function isPositive(entry) {
    if (DENY_NAME.test(entry.n || '')) return false;
    if (DENY_KEYWORD.test(entry.k || '')) return false;
    return true;
}

const all = JSON.parse(readFileSync(SRC, 'utf8'));
const kept = [];
const dropped = { printable: 0, content: 0 };
const samples = { printable: [], content: [] };

for (const e of all) {
    if (!isPrintable(e)) {
        dropped.printable += 1;
        if (samples.printable.length < 12) samples.printable.push(`${e.c} ${e.n}`);
        continue;
    }
    if (!isPositive(e)) {
        dropped.content += 1;
        if (samples.content.length < 12) samples.content.push(`${e.c} ${e.n}`);
        continue;
    }
    if (!kept.includes(e.c)) kept.push(e.c);
}

writeFileSync(OUT, `${JSON.stringify(kept)}\n`, 'utf8');

console.log(`源 ${all.length} 条 ⇒ 库 ${kept.length} 条`);
console.log(`筛除：画不出 ${dropped.printable}，内容 ${dropped.content}`);
console.log('画不出样例：', samples.printable.join('、'));
console.log('内容样例：', samples.content.join('、'));
