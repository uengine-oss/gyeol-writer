// 찾기/바꾸기
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

interface Hit {
  from: number;
  to: number;
}

interface FState {
  query: string;
  caseSensitive: boolean;
  hits: Hit[];
  current: number;
}

export const findKey = new PluginKey<FState>('find');

function search(doc: PMNode, query: string, caseSensitive: boolean): Hit[] {
  if (!query) return [];
  const hits: Hit[] = [];
  const q = caseSensitive ? query : query.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // 문단 안의 텍스트를 이어 붙여 찾되, 위치는 텍스트 노드 기준으로 되돌린다
    let text = '';
    const map: number[] = [];
    node.forEach((child, off) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) map.push(pos + 1 + off + i);
        text += child.text;
      } else {
        map.push(-1);
        text += '￼';
      }
    });
    const hay = caseSensitive ? text : text.toLowerCase();
    let i = hay.indexOf(q);
    while (i >= 0) {
      const from = map[i];
      const last = map[i + q.length - 1];
      if (from >= 0 && last >= 0) hits.push({ from, to: last + 1 });
      i = hay.indexOf(q, i + Math.max(q.length, 1));
    }
    return false;
  });
  return hits;
}

export const findPlugin = new Plugin<FState>({
  key: findKey,
  state: {
    init: () => ({ query: '', caseSensitive: false, hits: [], current: -1 }),
    apply(tr, prev) {
      const meta = tr.getMeta(findKey) as Partial<FState> | undefined;
      if (meta) {
        const next = { ...prev, ...meta };
        next.hits = search(tr.doc, next.query, next.caseSensitive);
        if (meta.current === undefined) next.current = next.hits.length ? 0 : -1;
        next.current = Math.min(next.current, next.hits.length - 1);
        return next;
      }
      if (tr.docChanged && prev.query) {
        const hits = search(tr.doc, prev.query, prev.caseSensitive);
        return { ...prev, hits, current: Math.min(prev.current, hits.length - 1) };
      }
      return prev;
    },
  },
  props: {
    decorations(state) {
      const s = findKey.getState(state);
      if (!s?.hits.length) return null;
      return DecorationSet.create(
        state.doc,
        s.hits.map((h, i) => Decoration.inline(h.from, h.to, { class: i === s.current ? 'find-hit current' : 'find-hit' })),
      );
    },
  },
});

export function setQuery(state: EditorState, query: string, caseSensitive = false): Transaction {
  return state.tr.setMeta(findKey, { query, caseSensitive });
}

/** 다음/이전 찾기: 커서 기준 */
export function findStep(state: EditorState, dir: 1 | -1): Transaction | null {
  const s = findKey.getState(state);
  if (!s?.hits.length) return null;
  const pos = state.selection.from;
  let idx: number;
  if (dir === 1) {
    idx = s.hits.findIndex((h) => h.from > pos || (h.from === pos && state.selection.empty));
    if (idx < 0) idx = 0;
  } else {
    idx = -1;
    for (let i = s.hits.length - 1; i >= 0; i--) if (s.hits[i].from < pos) {
      idx = i;
      break;
    }
    if (idx < 0) idx = s.hits.length - 1;
  }
  const h = s.hits[idx];
  return state.tr.setSelection(TextSelection.create(state.doc, h.from, h.to)).setMeta(findKey, { current: idx }).scrollIntoView();
}

export function replaceCurrent(state: EditorState, replacement: string): Transaction | null {
  const s = findKey.getState(state);
  if (!s?.hits.length) return null;
  const { from, to } = state.selection;
  const hit = s.hits.find((h) => h.from === from && h.to === to) ?? s.hits[Math.max(s.current, 0)];
  const tr = state.tr.insertText(replacement, hit.from, hit.to);
  return tr.setSelection(TextSelection.create(tr.doc, hit.from + replacement.length));
}

export function replaceAll(state: EditorState, replacement: string): { tr: Transaction; count: number } | null {
  const s = findKey.getState(state);
  if (!s?.hits.length) return null;
  const tr = state.tr;
  for (let i = s.hits.length - 1; i >= 0; i--) tr.insertText(replacement, s.hits[i].from, s.hits[i].to);
  return { tr, count: s.hits.length };
}
