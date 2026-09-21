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

/**
 * 【审计补测】软链接绕过。
 *
 * 收件箱是外部 App（夸克/飞牛/其它服务）可写的目录，谁都能在里面放一个软链接：
 *   evil.jpg -> /app/config/app-config.json   （里面存着 AI 密钥）
 * 名字像图片、扩展名过关，而 fs.readFile 默认跟随软链接 —— 不设防就等于
 * 对外开了一个"读容器内任意文件"的接口。更阴的是软链接在列表里看不见
 * （readdir 的 isFile() 用 lstat 语义，对软链接返回 false），界面上毫无痕迹。
 */
describe('scan-inbox：链接（软链接/联接）防护', () => {
    /**
     * 尽量造出"名字像图片、实际不是普通文件"的条目：
     *   · Linux / 开了开发者模式的 Windows → 文件软链接（最贴近真实攻击：evil.jpg -> 敏感文件）
     *   · 只有 junction 权限的 Windows      → 目录联接（同样 isFile()=false，走的是同一道闸）
     *   · 两者都造不出来 → 跳过，绝不用"假设它会被拒"来充数。
     */
    const linkMode: 'file' | 'junction' | null = (() => {
        const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-inbox-probe-'));
        try {
            const target = path.join(probe, 'target.jpg');
            const dirTarget = path.join(probe, 'dir');
            fs.writeFileSync(target, 'x');
            fs.mkdirSync(dirTarget);
            try {
                fs.symlinkSync(target, path.join(probe, 'a.jpg'));
                return 'file';
            } catch {
                // Windows 没有开发者模式时会 EPERM，退一步试 junction
            }
            try {
                fs.symlinkSync(dirTarget, path.join(probe, 'b.jpg'), 'junction');
                return 'junction';
            } catch {
                return null;
            }
        } finally {
            fs.rmSync(probe, { recursive: true, force: true });
        }
    })();

    it.skipIf(!linkMode)('伪装成图片的链接：读不到、删不掉、列表里也不显示', async () => {
        // 把"敏感文件"放在收件箱**外面**，模拟真实的攻击目标
        const outsideSecret = path.join(tmpRoot, 'app-config.json');
        fs.writeFileSync(outsideSecret, '{"apiKey":"SECRET-SHOULD-NOT-LEAK"}');
        const outsideDir = path.join(tmpRoot, 'outside-dir');
        fs.mkdirSync(outsideDir);

        const link = path.join(inboxDir, 'evil.jpg');
        if (linkMode === 'file') fs.symlinkSync(outsideSecret, link);
        else fs.symlinkSync(outsideDir, link, 'junction');

        const lib = await freshLib();

        // ① 读：必须拒绝（修复前这里会把敏感文件的原文吐给任何人）
        expect(await lib.readInboxFile('evil.jpg')).toBeNull();
        expect(await lib.resolveSafeFilePath('evil.jpg')).toBeNull();

        // ② 列表：链接条目不出现 —— 界面上看不见，就不会被当成照片导入
        const listed = await lib.listInboxFiles();
        expect(listed.files.map((f) => f.name)).not.toContain('evil.jpg');

        // ③ 删：走同一道闸直接判失败，且**不会动到链接指向的目标**
        const del = await lib.deleteInboxFiles(['evil.jpg']);
        expect(del.deleted).toEqual([]);
        expect(del.failed).toHaveLength(1);
        expect(fs.existsSync(outsideSecret)).toBe(true);
    });

    it('isSafeInboxEntry：非普通文件 / 真实路径跑到目录外，一律不放行', async () => {
        const { isSafeInboxEntry } = await freshLib();
        const base = path.join(tmpRoot, 'inbox');

        // 正常的收件箱内普通文件 → 放行
        expect(isSafeInboxEntry(true, path.join(base, 'a.jpg'), base)).toBe(true);
        // 软链接 / 目录 / 设备：lstat 结果不是普通文件
        expect(isSafeInboxEntry(false, path.join(base, 'a.jpg'), base)).toBe(false);
        // realpath 解到目录外（realpath 闸门）
        expect(isSafeInboxEntry(true, path.join(tmpRoot, 'app-config.json'), base)).toBe(false);
        // 子目录里的文件也不算"直接放在收件箱里"
        expect(isSafeInboxEntry(true, path.join(base, 'sub', 'a.jpg'), base)).toBe(false);
    });

    /**
     * 【把"拦不住什么"也钉住，免得以后误以为这道闸是万能的】
     * 硬链接指向目录外的文件时，lstat 看着就是普通文件、realpath 也在收件箱内，
     * 两道闸都不会响 —— 所以它是**已知残留风险**。
     * 实际能不能利用，取决于内核 `fs.protected_hardlinks`（默认开启：非文件属主
     * 不能给别人的文件建硬链接）+ 目标与收件箱同卷。也就是说，这是"得先有 root
     * 级别的权限才造得出"的路径，不是本接口自己开的口子。
     */
    const canHardlink = (() => {
        const p = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-inbox-hl-'));
        try {
            fs.writeFileSync(path.join(p, 'a'), 'x');
            fs.linkSync(path.join(p, 'a'), path.join(p, 'b'));
            return true;
        } catch {
            return false;
        } finally {
            fs.rmSync(p, { recursive: true, force: true });
        }
    })();

    it.skipIf(!canHardlink)('已知局限：同卷硬链接会被放行（需目标文件权限才造得出）', async () => {
        const secret = path.join(tmpRoot, 'app-config.json');
        fs.writeFileSync(secret, '{"apiKey":"SECRET"}');
        try {
            fs.linkSync(secret, path.join(inboxDir, 'hard.jpg'));
        } catch {
            return; // 跨卷（EXDEV）等环境限制：跳过这条环境相关断言
        }

        const lib = await freshLib();
        // 如实断言：硬链接读得到 —— 这是我们**明确接受**的残留风险，不是漏测
        expect(await lib.readInboxFile('hard.jpg')).not.toBeNull();
    });
});
