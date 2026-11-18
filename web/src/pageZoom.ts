/** 取消浏览器的页面缩放，保留画布自己的手势处理和面板里的正常滚动。 */
export function preventPageZoom() {
  const options = { passive: false, capture: true };
  document.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    },
    options,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if ((event.ctrlKey || event.metaKey) && ['+', '=', '-', '0'].includes(event.key))
        event.preventDefault();
    },
    options,
  );
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(name, (event) => event.preventDefault(), options);
  }
}
