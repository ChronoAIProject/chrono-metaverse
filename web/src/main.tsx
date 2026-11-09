import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startAppearance } from './theme/appearance';

// 在第一次渲染之前应用主题，页面不会先用错的主题画一帧再纠正（同 CMA main.tsx）。
startAppearance();

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 元素');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
