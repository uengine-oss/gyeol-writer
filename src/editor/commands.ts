// 서식·입력 명령
import { toggleMark } from 'prosemirror-commands';
import type { Attrs, MarkType, Node as PMNode } from 'prosemirror-model';
import { TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { schema } from './schema';

const M = schema.marks;
const N = schema.nodes;

export const toggle = (name: keyof typeof M): Command => toggleMark(M[name]);

/** 속성 있는 마크(색·글꼴·크기)를 선택 영역에 적용. null 이면 제거 */
export function setMark(type: MarkType, attrs: Attrs | null): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (!dispatch) return true;
    const tr = state.tr;
    if (empty) {
      const marks = type.removeFromSet(state.storedMarks ?? state.selection.$from.marks());
      tr.setStoredMarks(attrs ? type.create(attrs).addToSet(marks) : marks);
    } else {
      state.selection.ranges.forEach((r) => {
        tr.removeMark(r.$from.pos, r.$to.pos, type);
        if (attrs) tr.addMark(r.$from.pos, r.$to.pos, type.create(attrs));
      });
      void from;
      void to;
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** 선택 영역의 문단들 */
export function selectedParagraphs(state: EditorState): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === N.paragraph) {
      out.push({ node, pos });
      return false;
    }
    return true;
  });
  return out;
}

export function setParaAttrs(attrs: Record<string, unknown>): Command {
  return (state, dispatch) => {
    const paras = selectedParagraphs(state);
    if (!paras.length) return false;
    if (dispatch) {
      const tr = state.tr;
      for (const { node, pos } of paras) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
      dispatch(tr);
    }
    return true;
  };
}

// 스타일 — 이름과 그에 딸린 문단/글자 속성
export const STYLES: Record<string, { para: Record<string, unknown>; size?: number; bold?: boolean }> = {
  바탕글: { para: { marginLeft: 0, indent: 0 } },
  본문: { para: { marginLeft: 1500, indent: 0 } },
  '개요 1': { para: { marginLeft: 0, spaceBefore: 600, spaceAfter: 300 }, size: 1600, bold: true },
  '개요 2': { para: { marginLeft: 1000, spaceBefore: 400, spaceAfter: 200 }, size: 1300, bold: true },
  '개요 3': { para: { marginLeft: 2000, spaceBefore: 200, spaceAfter: 100 }, size: 1100, bold: true },
};

export function applyStyle(name: string): Command {
  return (state, dispatch) => {
    const st = STYLES[name];
    if (!st) return false;
    const paras = selectedParagraphs(state);
    if (!dispatch) return true;
    const tr = state.tr;
    for (const { node, pos } of paras) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...st.para, style: name === '바탕글' ? null : name });
      const from = pos + 1;
      const to = pos + node.nodeSize - 1;
      tr.removeMark(from, to, M.size).removeMark(from, to, M.bold);
      if (st.size) tr.addMark(from, to, M.size.create({ size: st.size }));
      if (st.bold) tr.addMark(from, to, M.bold.create());
    }
    dispatch(tr);
    return true;
  };
}

/** 현재 커서/선택의 글자 크기(1/100pt) */
export function currentSize(state: EditorState): number {
  const marks = state.storedMarks ?? state.selection.$from.marks();
  return (marks.find((m) => m.type === M.size)?.attrs.size as number) ?? 1000;
}

export function stepSize(delta: number): Command {
  return (state, dispatch) => setMark(M.size, { size: Math.max(100, Math.min(409600, currentSize(state) + delta)) })(state, dispatch);
}

export function insertNode(node: PMNode): Command {
  return (state, dispatch) => {
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

export const insertTab: Command = (state, dispatch) => insertNode(N.tab.create())(state, dispatch);

export const insertLineBreak: Command = (state, dispatch) => insertNode(N.hard_break.create())(state, dispatch);

export function insertText(text: string): Command {
  return (state, dispatch) => {
    if (dispatch) dispatch(state.tr.insertText(text).scrollIntoView());
    return true;
  };
}

/** 쪽 나누기: 문단을 나누고 뒤 문단에 쪽 나눔 표시 */
export const pageBreak: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type !== N.paragraph) return false;
  if (!dispatch) return true;
  const tr = state.tr.deleteSelection();
  const $pos = tr.selection.$from;
  const attrs = { ...$pos.parent.attrs, pageBreak: true, style: $pos.parent.attrs.style };
  tr.split($pos.pos, 1, [{ type: N.paragraph, attrs }]);
  dispatch(tr.scrollIntoView());
  return true;
};

export function createTable(rows: number, cols: number, widthPx: number): PMNode {
  const w = Math.floor(widthPx / cols);
  const cell = () => N.table_cell.create({ colwidth: [w] }, N.paragraph.create());
  return N.table.create(
    { borders: true },
    Array.from({ length: rows }, () => N.table_row.create(null, Array.from({ length: cols }, cell))),
  );
}

export function insertTable(rows: number, cols: number, widthPx: number): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const table = createTable(rows, cols, widthPx);
    const tr = state.tr.replaceSelectionWith(table);
    // 첫 칸으로 커서 이동
    const start = tr.selection.from;
    let target = start;
    tr.doc.nodesBetween(Math.max(0, start - table.nodeSize - 2), Math.min(tr.doc.content.size, start + 2), (n, pos) => {
      if (n.type === N.table && target === start) target = pos + 4;
    });
    try {
      tr.setSelection(TextSelection.create(tr.doc, target));
    } catch {
      /* 위치 계산 실패 시 기본 선택 유지 */
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** 그림 삽입: 본문 폭을 넘지 않도록 줄인다 */
export function insertImage(src: string, ext: string, naturalW: number, naturalH: number, maxWidthPx: number): Command {
  const scale = Math.min(1, maxWidthPx / Math.max(naturalW, 1));
  return insertNode(N.image.create({ src, ext, width: Math.round(naturalW * scale * 75), height: Math.round(naturalH * scale * 75) }));
}

/** 표 안 선택 셀(또는 커서 칸)의 속성 변경 */
export function setCellAttr(name: string, value: unknown): Command {
  return (state, dispatch) => {
    const cells: { pos: number; node: PMNode }[] = [];
    const sel = state.selection as unknown as { forEachCell?: (f: (n: PMNode, p: number) => void) => void };
    if (sel.forEachCell) sel.forEachCell((node, pos) => cells.push({ node, pos }));
    else {
      const $f = state.selection.$from;
      for (let d = $f.depth; d > 0; d--) {
        const n = $f.node(d);
        if (n.type === N.table_cell || n.type === N.table_header) {
          cells.push({ node: n, pos: $f.before(d) });
          break;
        }
      }
    }
    if (!cells.length) return false;
    if (dispatch) {
      const tr = state.tr;
      for (const { node, pos } of cells) tr.setNodeMarkup(pos, undefined, { ...node.attrs, [name]: value });
      dispatch(tr);
    }
    return true;
  };
}

export function findParent(state: EditorState, typeName: string): { node: PMNode; pos: number } | null {
  const $f = state.selection.$from;
  for (let d = $f.depth; d > 0; d--) {
    if ($f.node(d).type.name === typeName) return { node: $f.node(d), pos: $f.before(d) };
  }
  return null;
}

export const toggleTableBorders: Command = (state, dispatch) => {
  const t = findParent(state, 'table');
  if (!t) return false;
  if (dispatch) dispatch(state.tr.setNodeMarkup(t.pos, undefined, { ...t.node.attrs, borders: !t.node.attrs.borders }));
  return true;
};

export function wordCount(doc: PMNode): { chars: number; charsNoSpace: number; words: number; paragraphs: number } {
  let text = '';
  let paragraphs = 0;
  doc.descendants((n) => {
    if (n.type === N.paragraph) {
      paragraphs++;
      text += n.textContent + '\n';
      return false;
    }
    return true;
  });
  const body = text.replace(/\n/g, '');
  return {
    chars: body.length,
    charsNoSpace: body.replace(/\s/g, '').length,
    words: text.split(/\s+/).filter(Boolean).length,
    paragraphs,
  };
}

export type { Transaction };
