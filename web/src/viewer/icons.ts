/**
 * 事件图标：网站自带的几种（显示规则里的 `icon` 只能从这里选，别的按 info 画）。
 * 路径是 16×16 的 SVG，用 DOM 接口创建，不拼 HTML。
 */
const PATHS: Readonly<Record<string, string>> = {
  dish: 'M2 10.5h12a6 6 0 0 0-12 0Zm5.2-6.3a.8.8 0 1 1 1.6 0v.6H7.2ZM1 12h14v1.4H1Z',
  flower:
    'M8 1.6a2.2 2.2 0 0 1 2.1 2.9A2.2 2.2 0 1 1 9.6 8.6 2.2 2.2 0 1 1 6.4 8.6 2.2 2.2 0 1 1 5.9 4.5 2.2 2.2 0 0 1 8 1.6Zm0 4.1a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2ZM7.4 9.6h1.2v5H7.4Z',
  bell: 'M8 1.5a4.5 4.5 0 0 1 4.5 4.5v3.2l1.3 2.1H2.2l1.3-2.1V6A4.5 4.5 0 0 1 8 1.5Zm-1.7 11h3.4a1.7 1.7 0 0 1-3.4 0Z',
  star: 'm8 1.2 2 4.3 4.7.5-3.5 3.2 1 4.6L8 11.5l-4.2 2.3 1-4.6L1.3 6l4.7-.5Z',
  person: 'M8 1.8a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6ZM2.5 14.2a5.5 5.5 0 0 1 11 0Z',
  box: 'm8 1.3 6 3v7.4l-6 3-6-3V4.3Zm0 1.6L4 4.8l4 2 4-2Zm-4.6 3.2v4.8L7.3 13V8.1Zm9.2 0L8.7 8.1V13l3.9-2Z',
  door: 'M3 1.5h10v13H3Zm1.4 1.4v10.2h7.2V2.9Zm5.2 4.6a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Z',
  cart: 'M1 2h2.3l.6 2H15l-1.6 5.6H5.2L5.6 11H13v1.3H4.6L2.3 3.3H1Zm4 11.2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm7 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z',
  info: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm-.8 5.6v4.8h1.6V7.1Zm.8-3a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
};

const SVG = 'http://www.w3.org/2000/svg';

/** 生成一个图标元素（不认识的名字画成 info）。 */
export function iconElement(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.icon = name in PATHS ? name : 'info';
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.info!);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}
