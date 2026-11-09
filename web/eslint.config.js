import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// 沿用 CMA web/eslint.config.js：推荐规则 + TypeScript + React Hooks。
export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', 'e2e/screenshots', 'e2e/test-results'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 构建插件、Playwright 配置和 vite 配置在 node 里运行；
    // Playwright 的 `page.evaluate` 回调在浏览器里运行，两套全局变量都在作用域内。
    files: ['build/**/*.ts', 'e2e/**/*.ts', 'vite.config.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
);
