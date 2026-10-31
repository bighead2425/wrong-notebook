export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { setupGlobalProxy } = await import('./lib/global-proxy');
        setupGlobalProxy();

        /**
         * 两段式的第二段跑在服务端内存队列里（lib/ai/relocate-queue.ts）。
         * 容器重建（watchtower 5 分钟一次）会把队列清空，
         * 那些 `tagStatus='pending'` 的题就会永远卡在"正在归位…"。
         *
         * 所以启动后扫一次库，把 pending 的重新排进去。
         *
         * 不 await：数据库首次连接可能要几百毫秒，不该拖住服务启动。
         * 失败了也只是这些题继续显示 pending，不影响任何其他功能。
         */
        void (async () => {
            try {
                const { recoverPendingRelocations } = await import('./lib/ai/relocate-service');
                await recoverPendingRelocations();
            } catch (e) {
                console.warn('[relocate] 启动恢复未完成，跳过：', e instanceof Error ? e.message : String(e));
            }
        })();
    }
}
