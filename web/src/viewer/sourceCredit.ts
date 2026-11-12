import { publicHttps, type SourceCredit } from '../core/externalSource';

/** 始终以纯文本、HTTPS 链接和图片展示提供方声明，不执行来源中的 HTML。 */
export function sourceCredit(source: SourceCredit): HTMLElement {
  const item = document.createElement('span');
  item.className = 'viewer__source-credit';
  const link = document.createElement('a');
  link.href = source.page;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  if (source.logo && publicHttps(source.logo)) {
    const logo = document.createElement('img');
    logo.src = source.logo;
    logo.alt = '';
    logo.referrerPolicy = 'no-referrer';
    logo.crossOrigin = 'anonymous';
    logo.addEventListener('error', () => logo.remove(), { once: true });
    link.append(logo);
  }
  link.append(document.createTextNode(source.attribution));
  item.append(link);
  if (source.license && publicHttps(source.license.url)) {
    const license = document.createElement('a');
    license.href = source.license.url;
    license.target = '_blank';
    license.rel = 'noopener noreferrer';
    license.textContent = source.license.label;
    item.append(license);
  }
  return item;
}
