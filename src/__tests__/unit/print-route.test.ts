import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PRINT_OPTIONS,
    DEFAULT_PRINT_ROUTE,
    DEFAULT_PRINT_SERVER,
    detectDevice,
    isPrintRoute,
    normalizePrintOptions,
    normalizePrintServer,
    resolveRoute,
    routeFor,
} from '@/lib/print-route';
import { PAGE_GEOMETRY } from '@/lib/print-pdf';
import { PAPERS } from '@/lib/paper';

/**
 * 打印出口的纯逻辑。
 *
 * 这些断言钉的是**行为本身**，不是实现细节：
 *   · 缺配置时"电脑弹浏览器、手机送共享"—— 手机端不预设共享就等于点了没反应；
 *   · 脏数据一律回默认 —— 这个值决定"点打印会发生什么"，不能让它抛错；
 *   · 配置优先于"上次记住的选择" —— 否则在设置里改回去会被旧选择顶掉。
 */
describe('打印出口 routeFor', () => {
    it('没有配置时：电脑走本地、手机走共享', () => {
        expect(routeFor('desktop', undefined)).toBe('local');
        expect(routeFor('mobile', undefined)).toBe('shared');
        expect(DEFAULT_PRINT_ROUTE).toEqual({ desktop: 'local', mobile: 'shared' });
    });

    it('配置里的合法值生效', () => {
        expect(routeFor('desktop', { desktop: 'ask' })).toBe('ask');
        expect(routeFor('mobile', { mobile: 'local' })).toBe('local');
    });

    it('脏值 / 缺失字段退回该设备的默认值，不抛错', () => {
        const dirty = { desktop: 'printer' } as unknown as { desktop: 'local' };
        expect(routeFor('desktop', dirty)).toBe('local');
        expect(routeFor('mobile', dirty)).toBe('shared');
    });

    it('isPrintRoute 只认三个值', () => {
        expect(['local', 'shared', 'ask'].every(isPrintRoute)).toBe(true);
        for (const bad of ['', 'LOCAL', 'none', null, undefined, 1, {}]) {
            expect(isPrintRoute(bad)).toBe(false);
        }
    });
});

describe('「每次询问」与「以后都这样」', () => {
    it('配置 ask + 记住 shared ⇒ 直接走共享，不再问', () => {
        expect(resolveRoute('mobile', { mobile: 'ask' }, 'shared')).toBe('shared');
    });

    it('配置明确指定时，配置优先（记住的旧选择不能顶掉设置）', () => {
        expect(resolveRoute('desktop', { desktop: 'local' }, 'shared')).toBe('local');
        expect(resolveRoute('mobile', { mobile: 'shared' }, 'local')).toBe('shared');
    });

    it('配置 ask 但没有记住过 ⇒ 仍然 ask', () => {
        expect(resolveRoute('desktop', { desktop: 'ask' }, null)).toBe('ask');
    });
});

describe('设备判断 detectDevice', () => {
    it.each([
        ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36', false],
        ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', false],
        ['Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X)', false],
        // iPadOS 13+ 伪装成 Mac：靠"支持触摸"认出来
        ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', true],
        // 真 Mac：同样 UA，但没有多点触摸
        ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', false],
        ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', false],
        ['', false],
    ])('%s（触摸=%s）', (ua, touch) => {
        const expected = /Android|iPhone|iPad|iPadOS|Macintosh/.test(ua) && (touch || !/Macintosh/.test(ua))
            ? 'mobile'
            : 'desktop';
        expect(detectDevice(ua, touch)).toBe(expected);
    });
});

describe('共享打印四格设置 normalizePrintOptions', () => {
    it('空值全走默认，纸型跟随当前幅面', () => {
        expect(normalizePrintOptions(null, 'A4')).toEqual({ ...DEFAULT_PRINT_OPTIONS, paper: 'A4' });
    });

    it('份数收敛到 1–99 的整数', () => {
        expect(normalizePrintOptions({ copies: 0 }).copies).toBe(1);
        expect(normalizePrintOptions({ copies: 1000 }).copies).toBe(99);
        expect(normalizePrintOptions({ copies: '3' }).copies).toBe(3);
        expect(normalizePrintOptions({ copies: NaN }).copies).toBe(1);
    });

    it('逐项收敛：错的那一项回默认，对的那几项保留', () => {
        const got = normalizePrintOptions({ copies: 2, duplex: 'short', paper: 'A3', range: 'current' });
        expect(got).toEqual({ copies: 2, duplex: 'long', paper: 'B5', range: 'current' });
    });
});

describe('共享打印地址 normalizePrintServer', () => {
    it('去尾部斜杠、保留合法地址', () => {
        expect(normalizePrintServer('http://192.168.1.10:6310/')).toBe('http://192.168.1.10:6310');
        expect(normalizePrintServer('  http://nas.local:6310  ')).toBe('http://nas.local:6310');
    });

    it('空值 / 没有协议 / 非法协议 ⇒ 回默认地址', () => {
        expect(normalizePrintServer('')).toBe(DEFAULT_PRINT_SERVER);
        expect(normalizePrintServer(null)).toBe(DEFAULT_PRINT_SERVER);
        expect(normalizePrintServer('192.168.1.10:6310')).toBe(DEFAULT_PRINT_SERVER);
        expect(normalizePrintServer('file:///etc/passwd')).toBe(DEFAULT_PRINT_SERVER);
    });
});

describe('截图用的页几何与纸张定义必须一致', () => {
    it.each(['B5', 'A4'] as const)('%s 的宽高与每一面高度', (id) => {
        const spec = PAPERS[id];
        expect(PAGE_GEOMETRY[id].wMm).toBe(spec.w);
        expect(PAGE_GEOMETRY[id].hMm).toBe(spec.h);
        expect(PAGE_GEOMETRY[id].contentHMm).toBe(spec.sideHeight);
        expect(PAGE_GEOMETRY[id].padTop).toBe(spec.margin.top);
        expect(PAGE_GEOMETRY[id].padRight).toBe(spec.margin.right);
        expect(PAGE_GEOMETRY[id].padBottom).toBe(spec.margin.bottom);
        expect(PAGE_GEOMETRY[id].padLeft).toBe(spec.margin.left);
    });
});
