import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ViewerPanel } from './DisplaySettings';

it('面板互斥，支持外部关闭和 Escape 归还焦点，收起后控件退出键盘导航', () => {
  render(
    <>
      <ViewerPanel label="显示设置">
        <button>切换样式</button>
      </ViewerPanel>
      <ViewerPanel label="空间导览">
        <button>前厅</button>
      </ViewerPanel>
    </>,
  );
  const settings = screen.getByRole('button', { name: '显示设置' });
  const navigation = screen.getByRole('button', { name: '空间导览' });
  expect(screen.queryByRole('button', { name: '切换样式' })).toBeNull();
  fireEvent.click(settings);
  expect(screen.getByRole('button', { name: '切换样式' })).toBeVisible();
  fireEvent.click(navigation);
  expect(settings).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: '切换样式' })).toBeNull();
  screen.getByRole('button', { name: '前厅' }).focus();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(navigation).toHaveFocus();
  expect(navigation).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(settings);
  fireEvent.pointerDown(document.body);
  expect(settings).toHaveAttribute('aria-expanded', 'false');
});
