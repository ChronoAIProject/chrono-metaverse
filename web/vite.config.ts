import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { buildIdentity, buildIdentityEvidence } from './build/identity';
import { devFixtures } from './build/devFixtures';

// 沿用 CMA web/vite.config.ts：构建身份、夹具模式插件、vitest 配置。
export default defineConfig(({ command, mode }) => {
  const identity = buildIdentity(process.env);
  return {
    // `npm run dev:fixtures` 时由 build/devFixtures.ts 在本地回答 /api/public。
    plugins: [
      react(),
      buildIdentityEvidence(identity),
      ...(command === 'serve' && mode === 'fixtures' ? [devFixtures()] : []),
    ],
    // 普通 `npm run dev` 把 /api 转给本地接口服务（默认 127.0.0.1:8080，可用 METAVERSE_API_URL 改）。
    server:
      mode === 'fixtures'
        ? {}
        : { proxy: { '/api': process.env.METAVERSE_API_URL ?? 'http://127.0.0.1:8080' } },
    define: {
      __CHRONO_BUILD__: JSON.stringify(identity.version),
      __CHRONO_BUILD_SHA__: JSON.stringify(identity.revision),
      __CHRONO_BUILD_LOCAL__: JSON.stringify(identity.local),
    },
    build: {
      // three.js 本身就有 600KB 左右，按库拆开，避免单个包过大的警告。
      rollupOptions: {
        output: {
          manualChunks: { three: ['three'] },
        },
      },
      chunkSizeWarningLimit: 900,
    },
    test: {
      globals: true,
      // 组件测试渲染真实 DOM；几何和编码测试在同一个环境里跑也没有问题。
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}', 'build/**/*.test.ts'],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx'],
      },
    },
  };
});
