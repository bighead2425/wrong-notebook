/**
 * 【custom-v29】扫描收件箱模块单元测试
 *
 * 这块逻辑全部落在 NAS 的一个目录上：列文件、判新旧、读内容、删文件。
 * 外部还有 App 往里丢东西（文件名不可控），所以目录穿越防护必须钉死在测试里。
 *
 * 用真实 tmp 目录跑真 fs —— mock fs 会把"排序/ stat / 目录判定"这些真正容易出错的地方盖过去。
 * 两个关键常量（SCAN_INBOX_PATH、STATE_FILE）都是**模块加载时**算出来的，
 * 所以必须 resetModules 后再动态 import，改晚了没用。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalEnv = { ...process.env };
let tmpRoot: string;
let inboxDir: string;
let cwdDir: string;

async function freshLib() {
    vi.resetModules();
    return import('@/lib/scan-inbox');
}

/** 造一个足够大的假图片（>1KB，绕过"残缺图"过滤） */
function fakeImage(dir: string, name: string, size = 2048, mtimeSec = 1700000000) {
    const full = path.join(dir, name);
    fs.writeFileSync(full, Buffer.alloc(size, 7));
    const t = mtimeSec;
    fs.utimesSync(full, t, t);
    return full;
}

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-inbox-test-'));
    inboxDir = path.join(tmpRoot, 'inbox');
    cwdDir = path.join(tmpRoot, 'cwd');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(cwdDir, { recursive: true });

    process.env.SCAN_INBOX_PATH = inboxDir;
    vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
});

afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('scan-inbox：列目录', () => {
    it('只列出浏览器能画的图片，非图片/残缺/子目录都算 ignored', async () => {
        fakeImage(inboxDir, 'a.jpg', 2048, 1700000000);
        fakeImage(inboxDir, 'b.png', 2048, 1700000001);
        fakeImage(inboxDir, 'c.heic', 2048, 1700000002); // HEIC：浏览器解不了
        fakeImage(inboxDir, 'd.pdf', 2048, 1700000003);
        fakeImage(inboxDir, 'e.jpg', 10, 1700000004);    // 太小：残缺图
        fs.mkdirSync(path.join(inboxDir, 'subdir'));

        const { listInboxFiles } = await freshLib();
        const res = await listInboxFiles();

        expect(res.available).toBe(true);
        expect(res.files.map((f) => f.name)).toEqual(['a.jpg', 'b.png']); // 按修改时间升序
        expect(res.ignored).toBe(3); // heic + pdf + 残缺
    });

    it('目录不存在时优雅降级（available=false），不抛异常', async () => {
        process.env.SCAN_INBOX_PATH = path.join(tmpRoot, 'nope');
        const { listInboxFiles } = await freshLib();
        const res = await listInboxFiles();
        expect(res.available).toBe(false);
        expect(res.files).toEqual([]);
    });
});

describe('scan-inbox：路径安全', () => {
    it('resolveInboxPath 拒绝目录穿越 / 隐藏文件 / 非图片扩展名', async () => {
        const { resolveInboxPath } = await freshLib();
        expect(resolveInboxPath('../../etc/passwd')).toBeNull();
        expect(resolveInboxPath('sub/a.jpg')).toBeNull();
        expect(resolveInboxPath('.hidden.jpg')).toBeNull();
        expect(resolveInboxPath('a.pdf')).toBeNull();
        expect(resolveInboxPath('')).toBeNull();
        expect(resolveInboxPath('ok.jpg')).toBe(path.join(inboxDir, 'ok.jpg'));
    });
});

describe('scan-inbox：读取内容', () => {
    it('读得到真文件并返回正确的 mime', async () => {
        fakeImage(inboxDir, 'ok.jpg', 2048);
        const { readInboxFile } = await freshLib();
        const found = await readInboxFile('ok.jpg');
        expect(found).not.toBeNull();
        expect(found!.mime).toBe('image/jpeg');
        expect(found!.data.byteLength).toBe(2048);
    });

    it('文件不存在 / 名字非法时返回 null', async () => {
        const { readInboxFile } = await freshLib();
        expect(await readInboxFile('missing.jpg')).toBeNull();
        expect(await readInboxFile('../secret.jpg')).toBeNull();
    });
});

describe('scan-inbox：新旧台账', () => {
    it('markImported 之后该文件不再算「新」，但仍在列表里（保留随时重导的活口）', async () => {
        fakeImage(inboxDir, 'a.jpg', 2048, 1700000000);
        const lib = await freshLib();

        const before = await lib.listInboxFiles();
        expect(before.files[0].imported).toBe(false);

        await lib.markImported(['a.jpg']);

        const after = await lib.listInboxFiles();
        expect(after.files).toHaveLength(1);
        expect(after.files[0].name).toBe('a.jpg');
        expect(after.files[0].imported).toBe(true);
    });

    it('台账会剔除 NAS 上已被手工删掉的文件，不会无限膨胀', async () => {
        const full = fakeImage(inboxDir, 'gone.jpg', 2048);
        const lib = await freshLib();
        await lib.markImported(['gone.jpg']);
        fs.rmSync(full);

        const res = await lib.listInboxFiles();
        expect(res.files).toHaveLength(0);
        expect(fs.existsSync(path.join(cwdDir, 'config', 'scan-inbox-state.json'))).toBe(true);
        const state = JSON.parse(
            fs.readFileSync(path.join(cwdDir, 'config', 'scan-inbox-state.json'), 'utf-8'),
        );
        expect(state.imported['gone.jpg']).toBeUndefined();
    });
});

describe('scan-inbox：清理（删除）', () => {
    it('删掉物理文件并同步清掉台账记录', async () => {
        fakeImage(inboxDir, 'del.jpg', 2048);
        const lib = await freshLib();
        await lib.markImported(['del.jpg']);

        const res = await lib.deleteInboxFiles(['del.jpg']);
        expect(res.deleted).toEqual(['del.jpg']);
        expect(res.failed).toEqual([]);
        expect(fs.existsSync(path.join(inboxDir, 'del.jpg'))).toBe(false);

        const after = await lib.listInboxFiles();
        expect(after.files).toHaveLength(0);
    });

    it('删不掉的文件单独列出失败原因，不影响其它文件', async () => {
        fakeImage(inboxDir, 'del.jpg', 2048);
        const lib = await freshLib();
        const res = await lib.deleteInboxFiles(['del.jpg', '../../etc/passwd']);

        expect(res.deleted).toEqual(['del.jpg']);
        expect(res.failed).toHaveLength(1);
        expect(res.failed[0].name).toBe('../../etc/passwd');
    });
});
