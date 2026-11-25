import { createContext } from 'react';
import { AssistantHost, z } from '@chronoai/nyx-assistant-sdk';

export type SelectedEntity = { spaceId: string; entityId: string };
export type ViewerTools = {
  selection(): SelectedEntity | null;
  focus(target: SelectedEntity): boolean;
};
export class ViewerToolBinding {
  current: ViewerTools | null = null;
  bind(viewer: ViewerTools) {
    this.current = viewer;
    return () => {
      if (this.current === viewer) this.current = null;
    };
  }
}
export const ViewerToolsContext = createContext<ViewerToolBinding | null>(null);

/** 绑定发起消息时的查看器。换内容或销毁后不能把旧请求交给新查看器。 */
export function registerViewerTools(
  host: AssistantHost,
  ref: ViewerToolBinding,
  viewer: ViewerTools,
) {
  host.registerTool({
    name: 'read_selection',
    description: '读取此查看器当前实际选中的空间和物件编号。',
    parameters: z.object({}),
    execute() {
      const selected = ref.current === viewer ? viewer.selection() : null;
      return selected
        ? { ok: true, value: selected }
        : { ok: false, code: 'selection_unavailable', message: '当前没有可读取的选中物件。' };
    },
  });
  host.registerTool({
    name: 'focus_selection',
    description: '将镜头聚焦到刚读取的选中物件。选区变化时返回失败。',
    parameters: z.object({ spaceId: z.string(), entityId: z.string() }),
    execute(target) {
      const selected = ref.current === viewer ? viewer.selection() : null;
      if (selected?.spaceId !== target.spaceId || selected.entityId !== target.entityId) {
        return { ok: false, code: 'selection_changed', message: '当前选区已改变。' };
      }
      return viewer.focus(target)
        ? { ok: true, value: { ...target, focused: true } }
        : { ok: false, code: 'focus_unavailable', message: '当前物件不可聚焦。' };
    },
  });
}
