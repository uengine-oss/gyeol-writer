// AI 도우미가 작업 중인 자리: 편집이 이어져도 위치를 따라가고, 화면에 표시한다
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export interface AiTarget {
  from: number;
  to: number;
  /** text: 글자 범위, node: 그림 하나, point: 커서 자리 */
  kind: 'text' | 'node' | 'point';
  label: string;
}

export const aiTargetKey = new PluginKey<AiTarget | null>('aiTarget');

export const aiTargetPlugin = new Plugin<AiTarget | null>({
  key: aiTargetKey,
  state: {
    init: () => null,
    apply(tr, cur) {
      const meta = tr.getMeta(aiTargetKey) as AiTarget | null | undefined;
      if (meta !== undefined) return meta;
      if (!cur || !tr.docChanged) return cur;
      const from = tr.mapping.map(cur.from, cur.kind === 'point' ? 1 : 1);
      const to = tr.mapping.map(cur.to, -1);
      return { ...cur, from, to: Math.max(from, to) };
    },
  },
  props: {
    decorations(state) {
      const t = aiTargetKey.getState(state);
      if (!t) return null;
      const chip = () => {
        const el = document.createElement('span');
        el.className = 'ai-chip';
        el.textContent = t.label;
        return el;
      };
      const decos: Decoration[] = [];
      if (t.kind === 'text' && t.to > t.from) decos.push(Decoration.inline(t.from, t.to, { class: 'ai-target' }));
      if (t.kind === 'node') {
        const n = state.doc.nodeAt(t.from);
        if (n) decos.push(Decoration.node(t.from, t.from + n.nodeSize, { class: 'ai-target-node' }));
      }
      decos.push(Decoration.widget(t.kind === 'text' ? t.to : t.from, chip, { side: 1, key: `ai-${t.label}` }));
      return DecorationSet.create(state.doc, decos);
    },
  },
});

export function setAiTarget(state: EditorState, t: AiTarget | null): Transaction {
  return state.tr.setMeta(aiTargetKey, t).setMeta('addToHistory', false);
}
