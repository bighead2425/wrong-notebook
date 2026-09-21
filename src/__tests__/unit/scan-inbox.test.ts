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

    it('旧版（v1）台账自动迁移到 v3：先按目录分组，再补上方向与已录入标记', async () => {
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
        expect(res.files[0].rotation).toBe(0);

        const migrated = readState();
        expect(migrated.version).toBe(3);
        expect(migrated.imported).toBeUndefined();
        expect(migrated.inbox['scan2wrong']['old.jpg']).toEqual({
            at: '2020-01-01T00:00:00.000Z',
            imported: true,
            rotation: 0,
        });
    });

    /**
     * 【custom-v33】v2 的"值"就是导入时间字符串。升级到 v3 时必须保持语义不变：
     * 原来"有记录 = 已导入"，所以 imported 一律补 true、方向补 0。
     * 这条一旦写错，老用户升级后会发现**所有导过的照片都变回"新照片"**，一按就重复导入。
     */
    it('v2 台账（值为导入时间字符串）升级到 v3：已录入不变、方向默认 0', async () => {
        fakeImage(inboxDir, 'mid.jpg', 2048);
        fs.mkdirSync(path.join(cwdDir, 'config'), { recursive: true });
        fs.writeFileSync(stateFile(), JSON.stringify({
            version: 2,
            inbox: { scan2wrong: { 'mid.jpg': '2021-02-03T00:00:00.000Z' } },
        }));

        const lib = await freshLib();
        const res = await lib.listInboxFiles();
        expect(res.files[0].imported).toBe(true);
        expect(res.files[0].rotation).toBe(0);

        const state = readState();
        expect(state.version).toBe(3);
        expect(state.inbox['scan2wrong']['mid.jpg'].at).toBe('2021-02-03T00:00:00.000Z');
    });
});

describe('scan-inbox：属性更新（旋转方向 / 人工改已录入）', () => {
    it('记下旋转方向，列表原样读回来；只转方向不会把它变成"已录入"', async () => {
        fakeImage(inboxDir, 'rot.jpg', 2048);
        const lib = await freshLib();

        await lib.setInboxMeta(['rot.jpg'], { rotation: 90 });
        let res = await lib.listInboxFiles();
        expect(res.files[0].rotation).toBe(90);
        expect(res.files[0].imported).toBe(false);

        // 再转会累计（预览页每点一次就存一次，角度得能叠上去）
        await lib.setInboxMeta(['rot.jpg'], { rotation: 180 });
        res = await lib.listInboxFiles();
        expect(res.files[0].rotation).toBe(180);
    });

    it('人工把「已录入」标回「新」：重新出现在新照片里，方向也不丢', async () => {
        fakeImage(inboxDir, 'back.jpg', 2048);
        const lib = await freshLib();
        await lib.markImported(['back.jpg']);
        await lib.setInboxMeta(['back.jpg'], { rotation: 270 });

        await lib.setInboxMeta(['back.jpg'], { imported: false });

        const res = await lib.listInboxFiles();
        expect(res.files[0].imported).toBe(false);
        expect(res.files[0].rotation).toBe(270);
    });

    /**
     * "既没导过、也没转过方向"的记录对用户是**不可见**的（显示效果与"没这条记录"一样），
     * 留着只会让台账白白膨胀、挤掉真正有用的记录。所以这种条目不该落盘。
     */
    it('没有信息的条目不会留在台账里', async () => {
        fakeImage(inboxDir, 'plain.jpg', 2048);
        const lib = await freshLib();

        await lib.setInboxMeta(['plain.jpg'], { imported: false });
        await lib.listInboxFiles(); // 触发一次自洁

        expect(readState().inbox['scan2wrong']).toBeUndefined();
    });

    it('非法文件名一律跳过，不写进台账', async () => {
        const lib = await freshLib();
        const n = await lib.setInboxMeta(
            ['../evil.jpg', '/etc/passwd', '.hidden.jpg', ''],
            { rotation: 90 },
        );
        expect(n).toBe(0);
        expect(readState().inbox['scan2wrong']).toBeUndefined();
    });

    /**
     * 【custom-v33 修正】这里原先抄了"不传 imported 就置 true"的体贴默认值，
     * 结果预览页只想转个方向时（只传 rotation），顺手把照片标成了「已录入」——
     * 用户转一下歪照片，那张就从"新照片"里消失了。
     * 现在的规矩是：**没提到的字段一律不动**。这条用例把两个方向都钉住。
     */
    it('没提到的字段一律不动（转方向不会顺手标成已录入，标已录入也不会清掉方向）', async () => {
        fakeImage(inboxDir, 'keep.jpg', 2048);
        const lib = await freshLib();

        // 一张新照片，只转方向
        await lib.setInboxMeta(['keep.jpg'], { rotation: 90 });
        let res = await lib.listInboxFiles();
        expect(res.files[0].rotation).toBe(90);
        expect(res.files[0].imported).toBe(false);

        // 再只标已录入
        await lib.setInboxMeta(['keep.jpg'], { imported: true });
        res = await lib.listInboxFiles();
        expect(res.files[0].imported).toBe(true);
        expect(res.files[0].rotation).toBe(90);
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

/* ------------------------------------------------------------------ */
/* 【custom-v31】写入侧：连拍转存                                        */
/* ------------------------------------------------------------------ */

/** 造一张"像真的"JPEG —— 文件头不对会被 sniffImageExt 拦下，所以头几字节必须真 */
function jpegBytes(size = 4096): Buffer {
    const b = Buffer.alloc(size, 7);
    b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
    return b;
}

function pngBytes(size = 4096): Buffer {
    const b = Buffer.alloc(size, 7);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    return b;
}

function webpBytes(size = 4096): Buffer {
    const b = Buffer.alloc(size, 7);
    b.write("RIFF", 0, "latin1");
    b.write("WEBP", 8, "latin1");
    return b;
}

describe('scan-inbox：写入（连拍转存）', () => {
    it('sniffImageExt 只认真图片的文件头，不认扩展名也不认声明', async () => {
        const { sniffImageExt } = await freshLib();
        expect(sniffImageExt(jpegBytes())).toBe('.jpg');
        expect(sniffImageExt(pngBytes())).toBe('.png');
        expect(sniffImageExt(webpBytes())).toBe('.webp');
        // 伪装删得再像也没用：内容不是图片就拒
        expect(sniffImageExt(Buffer.from('<html><body>hi</body></html>'))).toBeNull();
        expect(sniffImageExt(Buffer.from('GIF89a................'))).toBeNull();
        expect(sniffImageExt(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull(); // 太短
        expect(sniffImageExt(Buffer.alloc(0))).toBeNull();
    });

    it('正常转存：文件名服务端生成、内容一字不差、在列表里显示为"新照片"', async () => {
        writeConfig({ subPath: 'scan2wrong' });
        const lib = await freshLib();
        const data = jpegBytes(5000);
        const res = await lib.saveInboxImage(data, new Date(2026, 8, 21, 11, 30, 45));

        expect(res.ok).toBe(true);
        expect(res.name).toMatch(/^shot-20260921-113045-[0-9a-f]{6}\.jpg$/);
        expect(fs.readFileSync(path.join(inboxDir, res.name!)).equals(data)).toBe(true);

        // 写入**不**记台账：新拍的照片理应还是"新"的，用户导入了才记
        const listing = await lib.listInboxFiles();
        const found = listing.files.find((f) => f.name === res.name);
        expect(found).toBeTruthy();
        expect(found!.imported).toBe(false);
    });

    it('原子写：目录里不留 tmp 残片', async () => {
        writeConfig({ subPath: 'scan2wrong' });
        const lib = await freshLib();
        await lib.saveInboxImage(jpegBytes());
        const leftovers = fs.readdirSync(inboxDir).filter((n) => n.startsWith('tmp-'));
        expect(leftovers).toEqual([]);
    });

    it('同一秒连拍两张也不会互相覆盖（文件名带随机段）', async () => {
        writeConfig({ subPath: 'scan2wrong' });
        const lib = await freshLib();
        const at = new Date(2026, 8, 21, 11, 30, 45);
        const a = await lib.saveInboxImage(jpegBytes(2048), at);
        const b = await lib.saveInboxImage(jpegBytes(2048), at);

        expect(a.name).not.toBe(b.name);
        expect(fs.existsSync(path.join(inboxDir, a.name!))).toBe(true);
        expect(fs.existsSync(path.join(inboxDir, b.name!))).toBe(true);
    });

    it('子文件夹不存在时自动建 —— 设置里填个新名字就能直接用，不用先去飞牛建目录', async () => {
        writeConfig({ subPath: '数学/九月' });
        const lib = await freshLib();
        const res = await lib.saveInboxImage(jpegBytes());

        expect(res.ok).toBe(true);
        expect(fs.existsSync(path.join(rootDir, '数学', '九月', res.name!))).toBe(true);
    });

    it('空文件与伪装成图片的文本一律拒绝', async () => {
        writeConfig({ subPath: 'scan2wrong' });
        const lib = await freshLib();

        const empty = await lib.saveInboxImage(Buffer.alloc(0));
        expect(empty.ok).toBe(false);

        const fake = await lib.saveInboxImage(Buffer.from('<script>alert(1)</script>'));
        expect(fake.ok).toBe(false);
        expect(fake.error).toContain('图片');
        expect(fs.readdirSync(inboxDir)).toEqual([]); // 目录里干干净净
    });

    it('超过单张上限直接拒绝', async () => {
        writeConfig({ subPath: 'scan2wrong' });
        const lib = await freshLib();
        const { MAX_UPLOAD_BYTES } = lib;

        const res = await lib.saveInboxImage(jpegBytes(MAX_UPLOAD_BYTES + 1));
        expect(res.ok).toBe(false);
        expect(res.error).toContain('上限');
        expect(fs.readdirSync(inboxDir)).toEqual([]);
    });

    it('根目录不存在 → 给出可读原因，而不是抛异常', async () => {
        process.env.SCAN_INBOX_ROOT = path.join(tmpRoot, 'not-mounted');
        const lib = await freshLib();
        const res = await lib.saveInboxImage(jpegBytes());
        expect(res.ok).toBe(false);
        expect(res.error).toContain('根目录');
    });

    /**
     * 写入侧最关键的一道闸。
     *
     * 读侧的软链接闸挡的是"读出去"，这里挡的是"写进去"：
     * 子目录若是个链接指向挂载根之外（比如 /app/config），照片就会被写到那儿去。
     * Windows 建文件软链接要管理员权限，但**目录联接（junction）不需要** ——
     * 所以这条路径在本机也能端到端验证，不是"跳过就算过了"。
     */
    const canDirLink = (() => {
        const p = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-inbox-dl-'));
        try {
            fs.mkdirSync(path.join(p, 't'));
            fs.symlinkSync(path.join(p, 't'), path.join(p, 'l'), 'junction');
            return true;
        } catch {
            return false;
        } finally {
            fs.rmSync(p, { recursive: true, force: true });
        }
    })();

    it.skipIf(!canDirLink)('子目录是链接且指向挂载根之外 → 拒绝写入，一个字节都不落过去', async () => {
        const outside = path.join(tmpRoot, 'outside');
        fs.mkdirSync(outside, { recursive: true });
        fs.symlinkSync(outside, path.join(rootDir, 'linked'), 'junction');
        writeConfig({ subPath: 'linked' });

        const lib = await freshLib();
        const res = await lib.saveInboxImage(jpegBytes());

        expect(res.ok).toBe(false);
        expect(res.error).toContain('收件箱根目录内');
        expect(fs.readdirSync(outside)).toEqual([]);
    });

    it.skipIf(!canDirLink)('链接指向根**之内**的另一个子目录：放行（没越界就不该拦）', async () => {
        fs.symlinkSync(inboxDir, path.join(rootDir, 'inside-link'), 'junction');
        writeConfig({ subPath: 'inside-link' });

        const lib = await freshLib();
        const res = await lib.saveInboxImage(jpegBytes());

        expect(res.ok).toBe(true);
        // 真实落点是被指向的那个目录（跟直接写 scan2wrong 等价）
        expect(fs.existsSync(path.join(inboxDir, res.name!))).toBe(true);
    });
});
