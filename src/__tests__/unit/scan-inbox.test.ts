/**
 * 【custom-v29/v30】扫描收件箱模块单元测试
 *
 * 这块逻辑全部落在 NAS 的一个目录上：列文件、判新旧、读内容、删文件。
 * 外部还有 App 往里丢东西（文件名不可控），所以目录穿越防护必须钉死在测试里。
 *
 * 用真实 tmp 目录跑真 fs —— mock fs 会把"排序/ stat / 目录判定"这些真正容易出错的地方盖过去。
 *
 * 注意：SCAN_INBOX_ROOT 是**模块加载时**读的环境变量，所以改完必须
 * resetModules 之后再动态 import。而子路径是**每次调用现读配置**的
 * （这正是"改完保存即刻生效"的实现方式），所以改配置文件不用重新加载模块。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalEnv = { ...process.env };
let tmpRoot: string;
let rootDir: string;   // 容器内的"挂载根目录"
let inboxDir: string;  // 实际读取目录 = rootDir/scan2wrong
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

/** 往测试用的配置目录里写一份 app-config.json（只关心 scanInbox 这一项） */
function writeConfig(scanInbox?: { subPath?: string }) {
    const dir = path.join(cwdDir, 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'app-config.json'),
        JSON.stringify({ aiProvider: 'gemini', scanInbox }, null, 2),
    );
}

const stateFile = () => path.join(cwdDir, 'config', 'scan-inbox-state.json');
const readState = () => JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-inbox-test-'));
    rootDir = path.join(tmpRoot, 'inbox-root');
    inboxDir = path.join(rootDir, 'scan2wrong');
    cwdDir = path.join(tmpRoot, 'cwd');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(cwdDir, { recursive: true });

    // 关键：老变量必须清掉，否则 legacy 分支会抢在新式挂载前面
    delete process.env.SCAN_INBOX_PATH;
    process.env.SCAN_INBOX_ROOT = rootDir;
    vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
});

afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe('scan-inbox：子路径校验（normalizeSubPath）', () => {
    it('合法的相对路径：归一化分隔符、去掉多余空白', async () => {
        const { normalizeSubPath } = await freshLib();
        expect(normalizeSubPath('scan2wrong')).toBe('scan2wrong');
        expect(normalizeSubPath('  scan2wrong  ')).toBe('scan2wrong');
        expect(normalizeSubPath('a/b')).toBe('a/b');
        expect(normalizeSubPath('a//b')).toBe('a/b');
        expect(normalizeSubPath('a\\b')).toBe('a/b');   // Windows 手滑用反斜杠
        expect(normalizeSubPath('数学/错题')).toBe('数学/错题');
    });

    it('越权与非法写法一律拒绝', async () => {
        const { normalizeSubPath } = await freshLib();
        expect(normalizeSubPath('')).toBeNull();
        expect(normalizeSubPath('   ')).toBeNull();
        expect(normalizeSubPath('/etc')).toBeNull();        // 绝对路径
        expect(normalizeSubPath('/')).toBeNull();
        expect(normalizeSubPath('~')).toBeNull();           // home
        expect(normalizeSubPath('..')).toBeNull();
        expect(normalizeSubPath('a/../b')).toBeNull();      // 藏在中段也不行
        expect(normalizeSubPath('a/..')).toBeNull();
        expect(normalizeSubPath('.hidden')).toBeNull();     // 隐藏目录
        expect(normalizeSubPath('a/.hidden')).toBeNull();
        expect(normalizeSubPath('x'.repeat(300))).toBeNull();
        expect(normalizeSubPath(null)).toBeNull();
        expect(normalizeSubPath(123)).toBeNull();
    });
});

describe('scan-inbox：路径解析（getInboxLocation）', () => {
    it('新式挂载：根目录来自环境变量，子路径来自配置（可配置）', async () => {
        writeConfig({ subPath: '数学' });
        const { getInboxLocation } = await freshLib();
        const loc = getInboxLocation();

        expect(loc.root).toBe(rootDir);
        expect(loc.subPath).toBe('数学');
        expect(loc.dir).toBe(path.join(rootDir, '数学'));
        expect(loc.configurable).toBe(true);
    });

    it('配置里没填 / 填了非法值时退回默认子文件夹（不会把路径搞丢）', async () => {
        writeConfig({ subPath: '../escape' });
        const { getInboxLocation, DEFAULT_INBOX_SUBPATH } = await freshLib();
        expect(getInboxLocation().subPath).toBe(DEFAULT_INBOX_SUBPATH);
    });

    it('老式单目录挂载（只有 SCAN_INBOX_PATH）：路径在界面上不可改', async () => {
        delete process.env.SCAN_INBOX_ROOT;
        process.env.SCAN_INBOX_PATH = inboxDir;
        const { getInboxLocation } = await freshLib();

        const loc = getInboxLocation();
        expect(loc.dir).toBe(inboxDir);
        expect(loc.subPath).toBe('scan2wrong');
        expect(loc.configurable).toBe(false);   // 设置页会据此改成只读提示
    });

    it('试连接参数能临时盖过配置，且不改变已保存的配置', async () => {
        writeConfig({ subPath: 'scan2wrong' });
        const { getInboxLocation } = await freshLib();
        expect(getInboxLocation('数学').dir).toBe(path.join(rootDir, '数学'));
        expect(getInboxLocation(null).dir).toBe(path.join(rootDir, 'scan2wrong'));
    });
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
        expect(res.status).toBe('ok');
        expect(res.files.map((f) => f.name)).toEqual(['a.jpg', 'b.png']); // 按修改时间升序
        expect(res.ignored).toBe(3); // heic + pdf + 残缺
        expect(res.folders).toContain('scan2wrong'); // 设置页拿它做"点一下就填"
    });

    it('根目录没挂进来 → status=no-root（界面据此提示去改 compose），不抛异常', async () => {
        process.env.SCAN_INBOX_ROOT = path.join(tmpRoot, 'not-mounted');
        const { listInboxFiles } = await freshLib();
        const res = await listInboxFiles();

        expect(res.available).toBe(false);
        expect(res.status).toBe('no-root');
        expect(res.files).toEqual([]);
    });

    it('根挂好了但子文件夹还没建 → status=no-subdir（换目录后最常见的一种）', async () => {
        writeConfig({ subPath: '还没建的目录' });
        const { listInboxFiles } = await freshLib();
        const res = await listInboxFiles();

        expect(res.available).toBe(false);
        expect(res.status).toBe('no-subdir');
        expect(res.subPath).toBe('还没建的目录');
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

        const state = readState();
        // 分组空了连键一起删掉，不留空对象
        expect(state.inbox['scan2wrong']).toBeUndefined();
    });

    /**
     * 【custom-v30 新增】台账必须**按子路径分组**。
     *
     * 换目录之后，两个目录里完全可能有同名照片（相机/夸克都爱用 IMG_0001.jpg 这种名字）。
     * 台账如果只有一层，B 目录里的新照片会被 A 目录的旧记录误判成"已导入"，
     * 直接从「收到 N 张新照片」里消失 —— 用户会以为照片丢了。
     */
    it('换了子文件夹之后，同名文件不会被误判成「已导入」', async () => {
        fakeImage(inboxDir, 'IMG_0001.jpg', 2048);
        const lib = await freshLib();
        await lib.markImported(['IMG_0001.jpg']);

        // 同一个文件在本目录里：已导入
        const same = await lib.listInboxFiles();
        expect(same.files[0].imported).toBe(true);

        // 另一个目录里的同名新照片：必须算「新」
        const otherDir = path.join(rootDir, '数学');
        fs.mkdirSync(otherDir, { recursive: true });
        fakeImage(otherDir, 'IMG_0001.jpg', 2048);

        writeConfig({ subPath: '数学' });
        const other = await lib.listInboxFiles();
        expect(other.files).toHaveLength(1);
        expect(other.files[0].imported).toBe(false);

        // 切回原目录，记录还在（不是被覆盖掉了）
        writeConfig({ subPath: 'scan2wrong' });
        const back = await lib.listInboxFiles();
        expect(back.files[0].imported).toBe(true);
    });

    it('旧版（v1）台账自动迁移到按目录分组的新格式', async () => {
        fakeImage(inboxDir, 'old.jpg', 2048);
        const dir = path.join(cwdDir, 'config');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            stateFile(),
            JSON.stringify({ imported: { 'old.jpg': '2020-01-01T00:00:00.000Z' } }),
        );

        const lib = await freshLib();
        const res = await lib.listInboxFiles();

        // 迁移后"之前导过"这件事不能丢
        expect(res.files[0].imported).toBe(true);

        const migrated = readState();
        expect(migrated.version).toBe(2);
        expect(migrated.imported).toBeUndefined();
        expect(migrated.inbox['scan2wrong']['old.jpg']).toBe('2020-01-01T00:00:00.000Z');
    });
});

describe('scan-inbox：试连接（probe）', () => {
    it('用给定子路径列出文件，但一个字节都不落盘', async () => {
        writeConfig({ subPath: 'scan2wrong' });
        fakeImage(inboxDir, 'a.jpg', 2048);
        const lib = await freshLib();
        const res = await lib.listInboxFiles({ probeSubPath: 'scan2wrong' });

        expect(res.available).toBe(true);
        expect(res.files[0].imported).toBe(false); // 探测时不带台账状态

        // 关键：试连接只是"看一眼"，不该生成/改写台账文件
        expect(fs.existsSync(stateFile())).toBe(false);
    });

    it('名字非法时明确返回 invalid，而不是悄悄退回默认值', async () => {
        const lib = await freshLib();
        const res = await lib.listInboxFiles({ probeSubPath: '../etc' });
        expect(res.status).toBe('invalid');
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
