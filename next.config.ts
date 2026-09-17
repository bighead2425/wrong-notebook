import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
  webpack: (config: any) => {
    // Emscripten (OpenCV.js) 在浏览器端会引用这些 Node 模块，需屏蔽否则构建报错。
    // 注意：本项只在 `next build --webpack` 下生效（turbopack 不读 webpack 配置）。
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      fs: false,
      path: false,
      crypto: false,
    };
    return config;
  },
};

export default nextConfig;
