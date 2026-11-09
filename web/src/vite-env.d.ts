/// <reference types="vite/client" />

// 构建身份（vite.config.ts 的 define，与 CMA 相同）。
declare const __CHRONO_BUILD__: string;
declare const __CHRONO_BUILD_SHA__: string;
declare const __CHRONO_BUILD_LOCAL__: boolean;
