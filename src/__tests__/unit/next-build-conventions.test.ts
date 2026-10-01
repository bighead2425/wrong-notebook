import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **Next.js 构建期约定**的自检（2026-10-01 加）
 *
 * 起因很具体：`custom-v61` 的镜像在 `RUN npm run build` 退出码 1 ——
 * 新写的 `app/insights/print/page.tsx` 用了 `useSearchParams()` 却忘了包 `<Suspense>`，
 * Next 给页面做静态预渲染时直接报 `missing-suspense-with-csr-bailout` 中断构建。
 *
 * ⚠️ 这类错误**前面两道关都拦不住**：
 *   · `tsc --noEmit` 只看类型，`useSearchParams` 的返回值类型完全正常；
 *   · eslint 只看风格，没有一条规则知道"Suspense 边界"这回事。
 *   而本机内存小、跑不了 `next build`（4GB，构建必 OOM）⇒ **只有真机上 CI 才能暴露**。
 *   所以这里补一道静态自检：把"新页面该走哪条路"钉成可执行的规矩，
 *   免得下次又靠"记得照老页面写"。
 *
 * 项目里对"要读 URL 上的查询参数"有**两条正确路线**（新页面二选一，没有第三条）：
 *   ① 用 `useSearchParams()` ⇒ **必须**在同一个文件里有 `<Suspense` 包着
 *   ② 只在挂载时读一次 ⇒ 用 `window.location.search`，不需要 Suspense
 */

/** 判断一个文件是不是"用了 useSearchParams 却没包 Suspense" */
export function needsSuspenseWrapping(path: string, source: string): boolean {
    // 只看真实调用，不看注释里提到的字眼（本项目注释写得多，容易误判）
    const callsHook = /useSearchParams\s*\(\s*\)/.test(stripComments(source));
    if (!callsHook) return false;
    return !/<Suspense[\s>]/.test(stripComments(source));
}

/**
 * 粗略去掉注释。
 * 不追求完备（不处理字符串里的 `//`），因为这里只用于"避免把注释里的字眼当成调用"，
 * 这个精度够了 —— 误删几行只会让检查**更宽松**，不会误报卡住开发。
 */
export function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 递归找出目录下所有 `page.tsx` */
export function collectPages(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...collectPages(full));
        else if (name === 'page.tsx') out.push(full);
    }
    return out;
}

describe('Next 构建期约定 · useSearchParams 必须包 Suspense', () => {
    it('用了 useSearchParams 而没有 Suspense ⇒ 判为违规', () => {
        const src = `'use client';
import { useSearchParams } from 'next/navigation';
export default function P() {
    const q = useSearchParams();
    return <div>{q.get('a')}</div>;
}`;
        expect(needsSuspenseWrapping('src/app/x/page.tsx', src)).toBe(true);
    });

    it('包了 Suspense ⇒ 不算违规', () => {
        const src = `'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
function Inner() { const q = useSearchParams(); return <div>{q.get('a')}</div>; }
export default function P() { return <Suspense fallback={null}><Inner /></Suspense>; }`;
        expect(needsSuspenseWrapping('src/app/x/page.tsx', src)).toBe(false);
    });

    it('只在注释里提到 useSearchParams ⇒ 不算违规（本项目注释多，别误报）', () => {
        const src = `// 这里刻意不用 useSearchParams()，改用 window.location.search
/* 另一个文件用了 useSearchParams() 所以要包 Suspense */
export default function P() { return <div />; }`;
        expect(needsSuspenseWrapping('src/app/x/page.tsx', src)).toBe(false);
    });

    it('用 window.location.search 的路线 ⇒ 不需要 Suspense', () => {
        const src = `'use client';
export default function P() {
    const qs = new URLSearchParams(window.location.search);
    return <div>{qs.get('a')}</div>;
}`;
        expect(needsSuspenseWrapping('src/app/x/page.tsx', src)).toBe(false);
    });

    it('★ 真实的 src/app 下没有漏网的页面（这条就是当初构建失败的那一处）', () => {
        const offenders = collectPages(join(process.cwd(), 'src', 'app'))
            .filter((p) => needsSuspenseWrapping(p, readFileSync(p, 'utf8')))
            .map((p) => p.replace(process.cwd(), '').replace(/\\/g, '/'));
        expect(offenders).toEqual([]);
    });
});
