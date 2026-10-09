// @vitest-environment node
// 纯逻辑测试：收件箱图片地址的拼装（不碰 DOM、不碰网络）
import { describe, expect, it } from 'vitest';
import { inboxFileUrl } from '@/lib/scan-inbox-url';

/** 反向解析：模拟服务端 `new URL(req.url).searchParams` 的读法，验证"传出去能原样取回来" */
function parse(url: string): URLSearchParams {
    return new URL(url, 'http://localhost').searchParams;
}

describe('inboxFileUrl · 收件箱取图地址只在这里拼', () => {
    it('只给文件名 ⇒ 只有 name 一个参数', () => {
        expect(inboxFileUrl('IMG_0001.jpg')).toBe('/api/scan-inbox/file?name=IMG_0001.jpg');
    });

    it('带 dir：区分"录错题"与"回录分析"两个收件箱', () => {
        expect(inboxFileUrl('a.jpg', { dir: 'scan2recover' })).toBe(
            '/api/scan-inbox/file?name=a.jpg&dir=scan2recover',
        );
    });

    it('dir 传空串 ⇒ 当没传（与"默认那个收件箱"的约定一致）', () => {
        expect(parse(inboxFileUrl('a.jpg', { dir: '' })).has('dir')).toBe(false);
        expect(parse(inboxFileUrl('a.jpg', { dir: null })).has('dir')).toBe(false);
    });

    it('版本号（文件修改时间）进 v 参数 —— 服务端靠它在不在决定给不给长缓存', () => {
        const qs = parse(inboxFileUrl('a.jpg', { version: 1728451234567 }));
        expect(qs.get('v')).toBe('1728451234567');
    });

    it('版本号 0 也要带上（不能用 truthy 判断，否则会被当成"没传"）', () => {
        expect(parse(inboxFileUrl('a.jpg', { version: 0 })).get('v')).toBe('0');
    });

    it('不给版本号 ⇒ 没有 v 参数（服务端会退回 no-store，宁可慢也不能给错图）', () => {
        for (const v of [undefined, null, '']) {
            expect(parse(inboxFileUrl('a.jpg', { version: v })).has('v')).toBe(false);
        }
    });

    it('文件名里的空格、加号、中文、括号都能原样取回来', () => {
        const names = [
            '拼接_20261009_113045.jpg',
            'my photo.jpg',
            'a+b.jpg',
            'shöt (1).jpg',
        ];
        for (const name of names) {
            const qs = parse(inboxFileUrl(name, { dir: 'scan2wrong', version: 123 }));
            expect(qs.get('name')).toBe(name);
            expect(qs.get('dir')).toBe('scan2wrong');
            expect(qs.get('v')).toBe('123');
        }
    });

    it('thumb=1 ⇒ 取缩略图（小格子用）；不带 ⇒ 原图（导入/看大图必须用原图）', () => {
        expect(parse(inboxFileUrl('a.jpg', { thumb: true })).get('thumb')).toBe('1');
        expect(parse(inboxFileUrl('a.jpg')).has('thumb')).toBe(false);
        expect(parse(inboxFileUrl('a.jpg', { thumb: false })).has('thumb')).toBe(false);
    });

    it('文件名里的路径分隔符不会被"洗掉" —— 原样交给服务端去拒（防目录穿越要有一处硬闸）', () => {
        // 这里只保证**编码正确**（不要把 ../ 变成别的东西让服务端看不出来）
        const qs = parse(inboxFileUrl('../config/app-config.json'));
        expect(qs.get('name')).toBe('../config/app-config.json');
    });
});
