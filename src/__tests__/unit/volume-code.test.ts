// @vitest-environment node
// 纯逻辑测试：不碰 DOM。
import { describe, expect, it } from 'vitest';
import {
    VOLUME_KIND_PREFIX,
    buildPageCode,
    buildVolumeNo,
    nextVolumeSeq,
    pad,
    parsePageCode,
    parseVolumeNo,
    semesterOf,
    stampReadable,
    stampYmd,
    volumeKindFromPrefix,
} from '@/lib/volume-code';

/**
 * 卷号与页号（`RE20260926001` / `RE20260926001-01`）。
 *
 * 为什么值得单测：**拼法与解析只允许一处实现**。
 * 一旦生成与解析对不上，症状是"扫了没反应"或者"打开的是别的卷" ——
 * 这类错在纸上没有任何提示，只能靠测试拦住。
 */

// 用本地时间构造，避免时区把日期挪一天（这正是 `stampYmd` 不用 toISOString 的原因）
const D = new Date(2026, 8, 26, 10, 0, 0); // 2026-09-26

describe('卷号', () => {
    it('两种卷的代号：RE（review）/ BU（build up）', () => {
        expect(VOLUME_KIND_PREFIX.review).toBe('RE');
        expect(VOLUME_KIND_PREFIX.build).toBe('BU');
        expect(buildVolumeNo('review', D, 1)).toBe('RE20260926001');
        expect(buildVolumeNo('build', D, 1)).toBe('BU20260926001');
        expect(buildVolumeNo('review', D, 12)).toBe('RE20260926012');
    });

    it('序号超过 3 位也不截断（宁可长出 4 位，也不要把两张卷挤成一个号）', () => {
        expect(buildVolumeNo('review', D, 1234)).toBe('RE202609261234');
    });

    it('拼出来的一定能解析回去（往返一致）', () => {
        for (const kind of ['review', 'build'] as const) {
            for (const seq of [1, 7, 99, 100, 1234]) {
                const no = buildVolumeNo(kind, D, seq);
                const p = parseVolumeNo(no);
                expect(p).not.toBeNull();
                expect(p!.kind).toBe(kind);
                expect(p!.seq).toBe(seq);
                expect(p!.ymd).toBe('20260926');
                expect(p!.volumeNo).toBe(no);
            }
        }
    });

    it('认不出的卷号一律 null —— 不猜（乱猜会打开错误的卷）', () => {
        for (const bad of [null, undefined, '', 'SX20260916001', 'RE2026', 'XX20260926001', 'RE20260926000']) {
            expect(parseVolumeNo(bad as string)).toBeNull();
        }
    });

    it('大小写与前后空格都容错', () => {
        expect(parseVolumeNo(' re20260926001 ')?.seq).toBe(1);
    });

    it('代号 → 类型；认不出返回 null', () => {
        expect(volumeKindFromPrefix('RE')).toBe('review');
        expect(volumeKindFromPrefix('bu')).toBe('build');
        expect(volumeKindFromPrefix('T2')).toBeNull();
    });
});

describe('页号', () => {
    it('页码补两位：第 1 页 → -01', () => {
        expect(buildPageCode('RE20260926001', 1)).toBe('RE20260926001-01');
        expect(buildPageCode('RE20260926001', 12)).toBe('RE20260926001-12');
    });

    it('页号能解析回「哪个卷 + 第几页」（扫码入口要用的那一支）', () => {
        const p = parsePageCode('BU20260926003-07');
        expect(p).not.toBeNull();
        expect(p!.kind).toBe('build');
        expect(p!.volumeNo).toBe('BU20260926003');
        expect(p!.pageNo).toBe(7);
    });

    it('⚠️ 裸题号不能被当成页号（深挖纸的码也走同一个入口）', () => {
        expect(parsePageCode('SX20260916001')).toBeNull();
        expect(parsePageCode('RE20260926001')).toBeNull();
        expect(parsePageCode(null)).toBeNull();
        expect(parsePageCode('RE20260926001-0')).toBeNull();
    });
});

describe('当日序号', () => {
    it('同一天同类型已有 0/1/2 份 ⇒ 1/2/3', () => {
        expect(nextVolumeSeq([], 'review', D)).toBe(1);
        expect(nextVolumeSeq(['RE20260926001'], 'review', D)).toBe(2);
        expect(nextVolumeSeq(['RE20260926001', 'RE20260926002'], 'review', D)).toBe(3);
    });

    it('隔天的卷不参与编号（每天各自从 1 起）', () => {
        expect(nextVolumeSeq(['RE20260925009'], 'review', D)).toBe(1);
    });

    it('另一种卷不参与编号（复练与积累各自编号）', () => {
        expect(nextVolumeSeq(['BU20260926005'], 'review', D)).toBe(1);
    });

    it('脏数据不会把序号顶飞（格式不对的直接忽略）', () => {
        expect(nextVolumeSeq(['SX20260916001', '', null, undefined, 'RE20260926002'], 'review', D)).toBe(3);
    });
});

describe('日期与学期', () => {
    it('日期用**本地时间**，不用 UTC（否则晚上 8 点后卷号会变成"明天"）', () => {
        expect(stampYmd(new Date(2026, 0, 5))).toBe('20260105');
        expect(stampReadable(new Date(2026, 0, 5))).toBe('2026-01-05');
        // 夜里 23:30 仍是当天
        expect(stampYmd(new Date(2026, 8, 26, 23, 30))).toBe('20260926');
    });

    it('学期：9 月起秋、1–2 月算上一年的秋、3–8 月春', () => {
        expect(semesterOf(new Date(2026, 8, 26))).toBe('2026-秋');
        expect(semesterOf(new Date(2026, 11, 31))).toBe('2026-秋');
        expect(semesterOf(new Date(2027, 0, 15))).toBe('2026-秋');
        expect(semesterOf(new Date(2027, 1, 28))).toBe('2026-秋');
        expect(semesterOf(new Date(2027, 2, 1))).toBe('2027-春');
        expect(semesterOf(new Date(2027, 7, 31))).toBe('2027-春');
    });

    it('左补零：pad(7,3) = 007', () => {
        expect(pad(7, 3)).toBe('007');
        expect(pad(123, 3)).toBe('123');
        expect(pad(-5, 3)).toBe('000');
    });
});
