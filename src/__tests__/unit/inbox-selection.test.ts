import { describe, it, expect } from 'vitest';
import { reconcileSelection } from '@/lib/inbox-selection';

/**
 * 这几条用例全部来自用户在 custom-v34 上报的现场：
 * 「退出预览页后，选中态像是被重启了一样 —— New 的被勾上、Old 的被清掉」。
 * 病根是重读列表时无差别重算勾选，所以这里一条条把"用户点过的勾必须留下来"钉住。
 */
describe('收件箱选中态对账', () => {
    it('第一次加载：未导入的默认勾上，已导入的不勾', () => {
        const files = [
            { name: 'a.jpg', imported: false },
            { name: 'b.jpg', imported: true },
        ];
        const out = reconcileSelection([], null, files);
        expect([...out].sort()).toEqual(['a.jpg']);
    });

    it('已存在的文件：保留用户原来的选择（新照片被取消过也不勾回）', () => {
        const known = new Set(['a.jpg', 'b.jpg']);
        const files = [
            { name: 'a.jpg', imported: false }, // 用户刚取消过的
            { name: 'b.jpg', imported: false }, // 用户仍勾着
        ];
        const out = reconcileSelection(['b.jpg'], known, files);
        // a 不在 prevSelected 里 → 不勾回；b 保留
        expect([...out].sort()).toEqual(['b.jpg']);
    });

    it('用户点了「清除」后重读，不会自己又勾回来', () => {
        const known = new Set(['a.jpg']);
        const files = [{ name: 'a.jpg', imported: false }];
        const out = reconcileSelection([], known, files);
        expect(out.size).toBe(0);
    });

    it('已经被删掉的文件，从勾里剔除', () => {
        const known = new Set(['a.jpg', 'gone.jpg']);
        const files = [{ name: 'a.jpg', imported: false }];
        const out = reconcileSelection(['a.jpg', 'gone.jpg'], known, files);
        expect([...out]).toEqual(['a.jpg']);
    });

    it('这次新出现且没导入过的照片，默认勾上', () => {
        const known = new Set(['a.jpg']);
        const files = [
            { name: 'a.jpg', imported: false },
            { name: 'fresh.jpg', imported: false },
        ];
        const out = reconcileSelection([], known, files);
        expect([...out].sort()).toEqual(['fresh.jpg']);
    });

    it('新出现但已导入的不勾（NAS 上贴进来的旧照片不该被顺手选中）', () => {
        const known = new Set(['a.jpg']);
        const files = [{ name: 'fresh.jpg', imported: true }];
        const out = reconcileSelection([], known, files);
        expect(out.size).toBe(0);
    });

    // ↓ 下面两条是用户报的两条现场，逐字复现

    it('现场①：预览里把 Old 改成 New，退出后不该被自动勾上', () => {
        const known = new Set(['x.jpg']);
        const files = [{ name: 'x.jpg', imported: false }]; // 刚在预览里点成 New
        const out = reconcileSelection([], known, files); // 用户在预览里没点选中
        expect(out.size).toBe(0);
    });

    it('现场②：预览里把 New 改成 Old 并点了选中，退出后仍要保持选中', () => {
        const known = new Set(['x.jpg']);
        const files = [{ name: 'x.jpg', imported: true }]; // 刚在预览里点成 Old
        const out = reconcileSelection(['x.jpg'], known, files);
        expect([...out]).toEqual(['x.jpg']);
    });
});
