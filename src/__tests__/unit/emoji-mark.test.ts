// @vitest-environment node
// 纯逻辑测试：不碰 DOM。
import { describe, expect, it } from 'vitest';
import emojiData from '@/lib/emoji-data.json';
import { EMOJI_PRINT_LIBRARY, pickRandomEmoji } from '@/lib/emoji-mark';

/**
 * 【2026-10-03 需求第 10 条】纸张随机 emoji 标识的**库纯净性**与**等概率随机**。
 *
 * 他定的两条硬规矩，各自都靠单测守着：
 *   ① 印刷库里**只允许**"画得出 + 不吓人"的符号（否则纸上会印出方框或让孩子不适的东西）；
 *   ② 随机等概率，且**只会返回库里的字符**。
 *
 * ⚠️ 库是由 `scripts/build-emoji-print-library.mjs` **离线筛**出来的静态文件；
 *    这里以"消费者的立场"**独立复核**它（不复制脚本的实现），
 *    万一将来有人重新生成时把某类漏了，这里能拦住。
 */

interface EmojiEntry {
    c: string;
    n?: string;
    k?: string;
    u?: string;
}

const entries = emojiData as EmojiEntry[];
const byChar = new Map(entries.map((e) => [e.c, e]));

const ZWJ = 0x200d;
const VS16 = 0xfe0f;
const KEYCAP = 0x20e3;
const NEW_EMOJI_FLOOR = 0x1fa70;

function codePoints(u: string | undefined): number[] {
    return String(u || '')
        .split(/[^0-9a-f]+/i)
        .filter(Boolean)
        .map((t) => parseInt(t, 16));
}

describe('emoji 印刷库 · 纯净性', () => {
    it('非空、无重复、每个都是非空字符串', () => {
        expect(EMOJI_PRINT_LIBRARY.length).toBeGreaterThan(0);
        expect(new Set(EMOJI_PRINT_LIBRARY).size).toBe(EMOJI_PRINT_LIBRARY.length);
        for (const c of EMOJI_PRINT_LIBRARY) {
            expect(typeof c).toBe('string');
            expect(c.length).toBeGreaterThan(0);
        }
    });

    it('每个字符都能在数据源里找到出处（不是手塞进去的）', () => {
        for (const c of EMOJI_PRINT_LIBRARY) {
            expect(byChar.has(c), `库里出现了数据源没有的字符：${c}`).toBe(true);
        }
    });

    it('画不出来的一律不在库里（ZWJ / 肤色 / 国旗 / keycap / 码点>2 / 新符号）', () => {
        for (const c of EMOJI_PRINT_LIBRARY) {
            const cps = codePoints(byChar.get(c)?.u);
            const where = `「${c}」(${byChar.get(c)?.n})`;
            expect(cps.includes(ZWJ), `${where} 含 ZWJ`).toBe(false);
            expect(cps.includes(KEYCAP), `${where} 含 keycap`).toBe(false);
            expect(cps.some((cp) => cp >= 0x1f3fb && cp <= 0x1f3ff), `${where} 含肤色`).toBe(false);
            expect(cps.some((cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff), `${where} 含区域指示符`).toBe(false);
            expect(cps.length, `${where} 码点数超过 2`).toBeLessThanOrEqual(2);
            expect(
                cps.some((cp) => cp !== VS16 && cp >= NEW_EMOJI_FLOOR),
                `${where} 是较新的符号`,
            ).toBe(false);
        }
    });

    it('吓人/负面的内容一律不在库里（骷髅、鬼、刀枪、烟酒、赌、辐射、恐惧…）', () => {
        // 这是"消费者视角"的复核清单 —— 覆盖他点名的几类，不必与生成脚本逐字相同
        const deny =
            /骷髅|头骨|骨|骸|鬼|幽灵|妖怪|妖精|恶魔|魔鬼|撒旦|食人|僵尸|丧尸|木乃伊|棺|墓碑|墓|坟|丧|死|亡|炸弹|爆炸|爆破|地雷|雷管|手雷|火药|刀|匕首|剑|枪|子弹(?!头)|武器|血|伤|蜘蛛|蛇|蝎子|蟑螂|蟑|蝙蝠|(?<!袋)鼠(?!标)|虫|蠕虫|蚊子|呕吐|粪便|便便|屎|大便|中指|愤怒|生气|发怒|狂怒|怒|咒骂|骂|脏话|烟(?!花)|酒(?!店)|啤酒|葡萄酒|香槟|鸡尾酒|干杯|碰杯|药丸|药片|注射器|注射|针头|针筒|赌博|骰子|赌|辐射|放射|生化|恐惧|害怕|惊吓|尖叫|(?<!笑)哭|泪|悲伤|悲|沮丧|失望|难过|烦躁|烦恼|担忧|焦虑|紧张|生病|感冒|发烧|恶心|痛苦|疼痛|晕|危险|警告|禁止|有毒|毒|心碎|情人/;

        for (const c of EMOJI_PRINT_LIBRARY) {
            const e = byChar.get(c);
            const name = e?.n || '';
            expect(deny.test(name), `库里出现了不该有的「${c} ${name}」`).toBe(false);
        }
    });
});

describe('emoji 印刷库 · 等概率随机', () => {
    it('取的是 Math.floor(random() * 库长) —— 固定随机数下取值可预期', () => {
        const size = EMOJI_PRINT_LIBRARY.length;
        expect(pickRandomEmoji(() => 0)).toBe(EMOJI_PRINT_LIBRARY[0]);
        expect(pickRandomEmoji(() => 0.5)).toBe(EMOJI_PRINT_LIBRARY[Math.floor(0.5 * size)]);
        // 逼近 1 也不会越界（取到最后一个）
        expect(pickRandomEmoji(() => 0.999999999)).toBe(EMOJI_PRINT_LIBRARY[size - 1]);
    });

    it('无论随机数取什么，返回的一定在库内', () => {
        const size = EMOJI_PRINT_LIBRARY.length;
        for (let i = 0; i < size; i += 1) {
            const r = i / size; // 均匀扫过 [0,1)
            expect(EMOJI_PRINT_LIBRARY).toContain(pickRandomEmoji(() => r));
        }
    });

    it('默认随机源（Math.random）也只会吐库里的字符', () => {
        for (let i = 0; i < 200; i += 1) {
            expect(EMOJI_PRINT_LIBRARY).toContain(pickRandomEmoji());
        }
    });
});
