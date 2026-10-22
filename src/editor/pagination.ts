// 쪽 배치.
// 1) 기존 쪽 간격을 걷어 낸 '깨끗한' 배치를 한 번 잰다.
// 2) 문서 순서대로 단위(줄·표 줄·칸 안의 줄)를 보며, 쪽 경계를 넘는 단위 앞에 간격을 넣어 다음 쪽 본문 맨 위로 민다.
//    넣은 간격만큼 뒤 단위들이 내려가므로 누적 이동량(off)을 더해 가며 계산한다(배치를 다시 재지 않는다).
// 한글처럼 표는 줄 단위로, 줄이 쪽보다 크면 칸 안의 문단 줄 단위로 나눈다.
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { PageSetup } from '../model/doc';
import { px } from './schema';

export const PAGE_GAP = 24;

export interface PageGeom {
  width: number;
  height: number;
  /** 본문 시작(위 여백 + 머리말) */
  top: number;
  /** 본문 아래 끝에서 쪽 끝까지(아래 여백 + 꼬리말) */
  bottom: number;
  left: number;
  right: number;
  bodyHeight: number;
}

export function geom(page: PageSetup): PageGeom {
  const m = page.margin;
  const width = px(page.width);
  const height = px(page.height);
  const top = px(m.top + m.header);
  const bottom = px(m.bottom + m.footer);
  return { width, height, top, bottom, left: px(m.left + m.gutter), right: px(m.right), bodyHeight: height - top - bottom };
}

interface PState {
  deco: DecorationSet;
  breaks: number[]; // 쪽이 바뀌는 문서 위치(정렬)
  pages: number;
}

export const paginationKey = new PluginKey<PState>('pagination');
const CLEAR = { clear: true };

export function paginationPlugin(getGeom: () => PageGeom, getGap: () => number, onPages: (pages: number) => void) {
  let scheduled = false;
  return new Plugin<PState>({
    key: paginationKey,
    state: {
      init: () => ({ deco: DecorationSet.empty, breaks: [], pages: 1 }),
      apply(tr, prev) {
        const meta = tr.getMeta(paginationKey) as PState | typeof CLEAR | undefined;
        if (meta && 'clear' in meta) return { ...prev, deco: DecorationSet.empty };
        if (meta) return meta;
        return { ...prev, deco: prev.deco.map(tr.mapping, tr.doc) };
      },
    },
    props: {
      decorations: (state) => paginationKey.getState(state)?.deco,
    },
    view(view) {
      const run = () => {
        scheduled = false;
        if (!view.dom.isConnected) return;
        onPages(repaginate(view, getGeom(), getGap()));
      };
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(run);
      };
      schedule();
      // 그림 로딩 등으로 크기가 바뀌면 다시 잰다(간격 자체로 인한 변화는 무시)
      let lastW = 0;
      const ro = new ResizeObserver(() => {
        const w = view.dom.clientWidth;
        if (w !== lastW) {
          lastW = w;
          schedule();
        }
      });
      ro.observe(view.dom);
      view.dom.addEventListener('load', schedule, true);
      return {
        update: (_v, prevState) => {
          if (prevState.doc !== view.state.doc) schedule();
        },
        destroy: () => ro.disconnect(),
      };
    },
  });
}

/** 다시 계산해 적용하고 쪽 수를 돌려준다(편집 후·용지 변경·인쇄 전) */
export function repaginate(view: EditorView, g: PageGeom, gap: number): number {
  const dom = view.dom as HTMLElement;
  const ws = dom.closest('.workspace') as HTMLElement | null;
  const scroll = ws?.scrollTop ?? 0;
  const keepH = dom.style.minHeight;
  // 간격을 걷어 내는 동안 높이가 줄어 스크롤이 튀지 않게 잡아 둔다
  dom.style.minHeight = `${dom.getBoundingClientRect().height / zoomOf(dom)}px`;
  const next = paginate(view, g, gap);
  view.dispatch(view.state.tr.setMeta(paginationKey, next).setMeta('addToHistory', false));
  dom.style.minHeight = keepH;
  if (ws) ws.scrollTop = scroll;
  return next.pages;
}

interface Ctx {
  view: EditorView;
  g: PageGeom;
  gap: number;
  P: number; // 쪽 주기 = 용지 높이 + 쪽 간격
  base: number; // 본문 원점(첫 쪽 본문 맨 위)의 화면 y
  z: number;
  off: number; // 지금까지 넣은 간격 합
  decos: Decoration[];
  breaks: number[];
  first: boolean; // 문서 첫 단위인가
}

interface CellInfo {
  td: HTMLElement;
  bordered: boolean;
}

function zoomOf(el: HTMLElement): number {
  const stack = el.closest('.page-stack') as HTMLElement | null;
  return Number(stack?.dataset.zoom || '1') || 1;
}

/** 단위(위치 t, 높이 h; 깨끗한 배치 좌표)를 놓을 때 필요한 간격 */
function need(c: Ctx, t: number, h: number, force: boolean): number {
  const y = t + c.off;
  const B = c.g.bodyHeight;
  const k = Math.floor((y + 0.5) / c.P);
  const bodyTop = k * c.P;
  const bodyEnd = bodyTop + B;
  if (force) return y - bodyTop > 0.5 ? (k + 1) * c.P - y : 0;
  if (y >= bodyEnd - 0.5) return (k + 1) * c.P - y; // 여백·간격 자리에 걸침
  if (y + h > bodyEnd + 0.5 && h <= B && y > bodyTop + 0.5) return (k + 1) * c.P - y;
  return 0;
}

const top = (c: Ctx, r: DOMRect) => (r.top - c.base) / c.z;

/** 문단 줄 간격 여분의 절반(px). 한글은 줄이 쪽에 들어가는지를 글자 높이로만 본다(줄 간격 제외) */
function leadOf(dom: HTMLElement): number {
  const v = getComputedStyle(dom).getPropertyValue('--lx').trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return (v.endsWith('pt') ? (n * 96) / 72 : n) / 2;
}

/** 칸 안 간격: 쪽 아래 여백·쪽 간격·다음 쪽 위 여백 자리에서 칸 테두리를 가리고 끊어진 상자처럼 그린다 */
function coverStyle(c: Ctx, y: number, d: number, bordered: boolean): string {
  const k = Math.floor((y + 0.5) / c.P);
  const a = Math.max(0, k * c.P + c.g.bodyHeight - y);
  const b = a + c.g.bottom;
  const g2 = b + c.gap;
  const line = bordered ? '#000' : 'transparent';
  return (
    `background:linear-gradient(to bottom, transparent 0 ${a}px, ${line} ${a}px ${a + 1}px, #fff ${a + 1}px ${b}px,` +
    ` var(--desk) ${b}px ${g2}px, #fff ${g2}px ${d - 1}px, ${line} ${d - 1}px ${d}px)`
  );
}

function gapWidget(c: Ctx, pos: number, y: number, d: number, kind: 'block' | 'row' | 'inline', cell: CellInfo | null, inset: { l: number; r: number }): Decoration {
  const style = cell ? coverStyle(c, y, d, cell.bordered) : '';
  const k = `${kind}${Math.round(d)}`;
  return Decoration.widget(
    pos,
    () => {
      let el: HTMLElement;
      if (kind === 'row') {
        el = document.createElement('tr');
        el.className = 'page-gap-row';
        const td = document.createElement('td');
        td.colSpan = 999;
        td.style.height = `${d}px`;
        el.appendChild(td);
      } else {
        el = document.createElement(kind === 'inline' ? 'span' : 'div');
        el.className = kind === 'inline' ? 'page-gap page-gap-inline' : 'page-gap';
        el.style.cssText = `display:block;height:${d}px;${cell ? `margin:0 -${inset.r}px 0 -${inset.l}px;${style}` : ''}`;
      }
      el.contentEditable = 'false';
      return el;
    },
    { side: -1, k, ignoreSelection: true },
  );
}

function push(c: Ctx, pos: number, t: number, d: number, kind: 'block' | 'row' | 'inline', cell: CellInfo | null, inset = { l: 0, r: 0 }) {
  const dbg = (globalThis as { __gyeolPagDebug?: unknown[] }).__gyeolPagDebug;
  if (dbg) dbg.push({ kind, cell: !!cell, pos, t: Math.round(t * 10) / 10, off: Math.round(c.off * 10) / 10, d: Math.round(d * 10) / 10, target: Math.round((t + c.off + d) * 10) / 10 });
  c.decos.push(gapWidget(c, pos, t + c.off, d, kind, cell, inset));
  c.breaks.push(pos);
  c.off += d;
}

/** 칸 테두리까지 덮도록 간격을 좌우로 넓힐 양 */
function insetFor(c: Ctx, cell: CellInfo | null, inner: HTMLElement): { l: number; r: number } {
  if (!cell) return { l: 0, r: 0 };
  const a = cell.td.getBoundingClientRect();
  const b = inner.getBoundingClientRect();
  return { l: (b.left - a.left) / c.z + 1, r: (a.right - b.right) / c.z + 1 };
}

function walkBlocks(c: Ctx, parent: PMNode, start: number, cell: CellInfo | null) {
  let pendingForce = false;
  parent.forEach((child, offset) => {
    const pos = start + offset;
    if (child.type.name === 'section_break') {
      pendingForce = !c.first;
      return;
    }
    const dom = c.view.nodeDOM(pos) as HTMLElement | null;
    if (!dom || dom.nodeType !== 1) return;
    const force = (pendingForce || !!child.attrs.pageBreak) && !c.first && !cell;
    pendingForce = false;
    if (child.type.name === 'table') walkTable(c, child, pos, dom, force, cell);
    else if (child.type.name === 'paragraph') walkParagraph(c, child, pos, dom, force, cell);
    else {
      const r = dom.getBoundingClientRect();
      const t = top(c, r);
      const d = need(c, t, r.height / c.z, force);
      if (d) push(c, pos, t, d, 'block', cell, insetFor(c, cell, dom));
    }
    c.first = false;
  });
}

interface Line {
  t: number;
  h: number;
  pos: number;
}

/**
 * 문단의 줄 상자들(깨끗한 좌표)과 각 줄 첫 글자의 문서 위치.
 * 화면 밖 줄도 다뤄야 하므로 좌표로 위치를 찾지 않고(posAtCoords 는 보이는 영역만 됨),
 * 글자·개체마다 상자를 재서 줄로 묶고 첫 글자의 DOM 위치를 문서 위치로 바꾼다.
 */
function lines(c: Ctx, node: PMNode, pos: number, dom: HTMLElement): Line[] {
  type Unit = { top: number; bottom: number; at: () => number };
  const units: Unit[] = [];
  const range = document.createRange();
  const walk = (el: Node) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        const text = n.nodeValue ?? '';
        for (let i = 0; i < text.length; i++) {
          range.setStart(n, i);
          range.setEnd(n, i + 1);
          const r = range.getBoundingClientRect();
          if (!r.height) continue;
          const node = n;
          const off = i;
          units.push({ top: r.top, bottom: r.bottom, at: () => c.view.posAtDOM(node, off) });
        }
      } else if (n.nodeType === 1) {
        const e = n as HTMLElement;
        if (e.classList.contains('page-gap')) continue;
        // 이미지·특수 문자 등 원자 개체는 상자 하나로
        if (e.tagName === 'IMG' || e.classList.contains('g-pua') || e.classList.contains('g-tab')) {
          const r = e.getBoundingClientRect();
          if (r.height) units.push({ top: r.top, bottom: r.bottom, at: () => c.view.posAtDOM(e.parentNode!, [...e.parentNode!.childNodes].indexOf(e)) });
        } else walk(e);
      }
    }
  };
  walk(dom);
  // 글자 상자를 세로 겹침으로 줄 묶기(문서 순서대로 진행하므로 새 줄은 아래에서 시작)
  const groups: { top: number; bottom: number; first: Unit }[] = [];
  for (const u of units) {
    const g = groups[groups.length - 1];
    if (g && u.top < g.bottom - 2) {
      g.top = Math.min(g.top, u.top);
      g.bottom = Math.max(g.bottom, u.bottom);
    } else groups.push({ top: u.top, bottom: u.bottom, first: u });
  }
  const pr = dom.getBoundingClientRect();
  const out: Line[] = [];
  groups.forEach((gr, i) => {
    const start = i === 0 ? pr.top : (groups[i - 1].bottom + gr.top) / 2;
    const end = i === groups.length - 1 ? pr.bottom : (gr.bottom + groups[i + 1].top) / 2;
    let p = pos + 1;
    if (i > 0) {
      try {
        p = Math.min(Math.max(gr.first.at(), pos + 1), pos + node.nodeSize - 1);
      } catch {
        p = pos + 1;
      }
    }
    out.push({ t: (start - c.base) / c.z, h: (end - start) / c.z, pos: p });
  });
  return out;
}

function walkParagraph(c: Ctx, node: PMNode, pos: number, dom: HTMLElement, force: boolean, cell: CellInfo | null) {
  const r = dom.getBoundingClientRect();
  const lead = leadOf(dom);
  // 글자 영역 기준(위아래 줄 간격 여분 제외)
  const t = top(c, r) + lead;
  const h = Math.max(1, r.height / c.z - 2 * lead);
  if (force) {
    const d = need(c, t, h, true);
    if (d) push(c, pos, t, d, 'block', cell, insetFor(c, cell, dom));
  }
  // 문단 전체가 지금 쪽에 들어가면 끝
  const y = t + c.off;
  const k = Math.floor((y + 0.5) / c.P);
  if (y + h <= k * c.P + c.g.bodyHeight + 0.5 && y < k * c.P + c.g.bodyHeight - 0.5) return;
  // 줄 단위로 나눈다
  const ls = lines(c, node, pos, dom);
  if (!ls.length) {
    const d = need(c, t, h, false);
    if (d) push(c, pos, t, d, 'block', cell, insetFor(c, cell, dom));
    return;
  }
  ls.forEach((ln, i) => {
    const d = need(c, ln.t + lead, Math.max(1, ln.h - 2 * lead), false);
    if (!d) return;
    if (i === 0) push(c, pos, ln.t + lead, d, 'block', cell, insetFor(c, cell, dom));
    else push(c, ln.pos, ln.t + lead, d, 'inline', cell, insetFor(c, cell, dom));
  });
}

function walkTable(c: Ctx, node: PMNode, pos: number, dom: HTMLElement, force: boolean, cell: CellInfo | null) {
  const r = dom.getBoundingClientRect();
  const t = top(c, r);
  const h = r.height / c.z;
  if (force) {
    const d = need(c, t, h, true);
    if (d) push(c, pos, t, d, 'block', cell, insetFor(c, cell, dom));
  }
  const y = t + c.off;
  const k = Math.floor((y + 0.5) / c.P);
  if (y + h <= k * c.P + c.g.bodyHeight + 0.5 && y < k * c.P + c.g.bodyHeight - 0.5) return;

  const table = dom.querySelector('table') as HTMLTableElement | null;
  if (!table) return;
  const trs = [...table.rows];
  const bordered = table.classList.contains('bordered');
  let rowPos = pos + 1;
  let carry = 0; // 위에서 내려오는 세로 병합이 남은 줄 수
  node.forEach((row, _o, i) => {
    const tr = trs[i];
    if (!tr) return;
    const rr = tr.getBoundingClientRect();
    const rt = top(c, rr);
    const rh = rr.height / c.z;
    const d = need(c, rt, rh, false);
    if (d && rh <= c.g.bodyHeight) {
      if (i === 0) push(c, pos, rt, d, 'block', cell, insetFor(c, cell, dom));
      else if (carry === 0) push(c, rowPos, rt, d, 'row', cell);
      else splitRow(c, row, rowPos, bordered);
    } else if (d || crosses(c, rt, rh)) {
      splitRow(c, row, rowPos, bordered);
    }
    let span = 0;
    row.forEach((cl) => (span = Math.max(span, cl.attrs.rowspan - 1)));
    carry = Math.max(carry - 1, span);
    rowPos += row.nodeSize;
  });
}

function crosses(c: Ctx, t: number, h: number): boolean {
  const y = t + c.off;
  const k = Math.floor((y + 0.5) / c.P);
  return y + h > k * c.P + c.g.bodyHeight + 0.5;
}

/** 쪽보다 큰 표 줄: 칸마다 안쪽 문단을 줄 단위로 나눈다. 줄 높이는 가장 많이 밀린 칸만큼 늘어난다. */
function splitRow(c: Ctx, row: PMNode, rowPos: number, bordered: boolean) {
  const startOff = c.off;
  let maxOff = startOff;
  row.forEach((cellNode, cOff) => {
    const cellPos = rowPos + 1 + cOff;
    const td = c.view.nodeDOM(cellPos) as HTMLElement | null;
    if (!td) return;
    const sub: Ctx = { ...c, off: startOff, first: false };
    walkBlocks(sub, cellNode, cellPos + 1, { td, bordered });
    maxOff = Math.max(maxOff, sub.off);
  });
  c.off = maxOff;
}

function paginate(view: EditorView, g: PageGeom, gap: number): PState {
  const dom = view.dom as HTMLElement;
  // 1) 간격을 걷어 낸다
  view.dispatch(view.state.tr.setMeta(paginationKey, CLEAR).setMeta('addToHistory', false));

  // 2) 깨끗한 배치를 재며 간격을 계산
  const z = zoomOf(dom);
  const dr = dom.getBoundingClientRect();
  const c: Ctx = {
    view,
    g,
    gap,
    P: g.height + gap,
    base: dr.top, // .ProseMirror 맨 위 = 첫 쪽 본문 맨 위
    z,
    off: 0,
    decos: [],
    breaks: [],
    first: true,
  };
  walkBlocks(c, view.state.doc, 0, null);
  // 마지막 내용의 끝으로 쪽 수 계산
  const last = dom.lastElementChild as HTMLElement | null;
  const endY = last ? (last.getBoundingClientRect().bottom - c.base) / z + c.off : 0;
  const pages = Math.max(1, Math.floor(Math.max(0, endY - 1) / c.P) + 1);

  c.breaks.sort((a, b) => a - b);
  return { deco: DecorationSet.create(view.state.doc, c.decos), breaks: c.breaks, pages };
}

/** 커서가 있는 쪽 번호(1부터) — 간격 위치 기준 근사 */
export function caretPage(state: EditorState): number {
  const ps = paginationKey.getState(state);
  if (!ps) return 1;
  const pos = state.selection.from;
  let page = 1;
  for (const b of ps.breaks) if (pos >= b) page++;
  return Math.min(page, ps.pages);
}
