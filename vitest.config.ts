import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        globals: true,
        /**
         * 默认 5000ms 在本机（4GB、常驻负载高）会误杀两类无辜测试：
         *   ① 带真实退避等待的重试类测试（Gemini 退避 1s+2s=3s，贴边）；
         *   ② 大模块图 `await import()` 的初始化测试（transform 动辄数秒）。
         * 这两类失败是环境噪声而非代码缺陷，放宽到 20s 让红/绿只反映真实问题。
         */
        testTimeout: 20000,
        setupFiles: ['./src/__tests__/setup.ts'],
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
        include: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'],
        exclude: ['node_modules', '.next', 'dist'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['src/lib/**/*.ts', 'src/app/api/**/*.ts'],
            exclude: ['src/__tests__/**', 'node_modules/**'],
        },
    },
})
