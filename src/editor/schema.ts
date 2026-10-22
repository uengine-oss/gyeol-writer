// 편집기 스키마 — 문서 모델(model/doc.ts)과 1:1 로 대응한다.
import { Schema, type DOMOutputSpec, type NodeSpec, type MarkSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';
import { puaView } from '../model/pua';
import { fitVars } from './fontfit';

export const HU_PER_PX = 75; // 7200 HU/inch ÷ 96 px/inch
export const px = (hu: number | undefined | null) => (hu ?? 0) / HU_PER_PX;

const paraAttrs = {
  align: { default: 'justify' },
  indent: { default: 0 },
  marginLeft: { default: 0 },
  marginRight: { default: 0 },
  spaceBefore: { default: 0 },
  spaceAfter: { default: 0 },
  lineSpacing: { default: 160 },
  style: { default: null as string | null },
  pageBreak: { default: false },
  /** 문단 끝 글자 모양(모델 markChar) */
  markChar: { default: null as Record<string, unknown> | null },
};

/**
 * 문단 CSS. 한글의 줄 간격은 줄 아래에 붙고(칸의 마지막 줄 뒤는 버림), CSS line-height 는 위아래로 반씩 나눈다.
 * 줄 간격 여분(--lx)을 위로 반 당기고 아래로 반 미뤄 한글과 같은 위치에 글자를 두고,
 * 표 칸의 마지막 문단은 CSS 규칙으로 그 여분을 뺀다.
 */
export function paraStyle(a: Record<string, any>, maxSizePt = 10): string {
  const s: string[] = [];
  s.push(`text-align:${a.align === 'distribute' ? 'justify' : a.align}`);
  if (a.align === 'distribute') s.push('text-align-last:justify');
  // 한글의 들여쓰기(+)/내어쓰기(-) — 내어쓰기는 왼쪽 여백을 늘리고 첫 줄만 당긴다
  const indent = px(a.indent);
  const left = px(a.marginLeft) + (indent < 0 ? -indent : 0);
  if (left) s.push(`padding-left:${left}px`);
  if (indent) s.push(`text-indent:${indent}px`);
  if (a.marginRight) s.push(`padding-right:${px(a.marginRight)}px`);
  const ls = (a.lineSpacing ?? 160) / 100;
  const lx = Math.max(0, ls - 1) * maxSizePt;
  s.push(`--lx:${lx.toFixed(2)}pt`, `--sb:${px(a.spaceBefore)}px`, `--sa:${px(a.spaceAfter)}px`);
  s.push(`line-height:${ls}`);
  return s.join(';');
}

/** 문단 안 글자 중 가장 작은 크기(pt) — 문단 자체 글자 크기(줄 받침 높이)를 이 값으로 두어 줄이 부풀지 않게 한다 */
function minSizePt(n: import('prosemirror-model').Node): number {
  if (!n.content.size) return ((n.attrs.markChar?.size as number) ?? 1000) / 100;
  let min = Infinity;
  n.forEach((c) => {
    const m = c.marks.find((x) => x.type.name === 'size');
    min = Math.min(min, m ? m.attrs.size / 100 : 10);
  });
  return Number.isFinite(min) ? min : 10;
}

/** 문단 자체 글꼴 = 첫 글자(빈 문단은 문단 끝 글자)의 글꼴. 줄 받침과 글자의 글꼴 비율이 달라 줄이 부푸는 것을 막는다 */
function baseFont(n: import('prosemirror-model').Node): string {
  let f: { hangul?: string; latin?: string } | undefined;
  if (!n.content.size) {
    const mc = n.attrs.markChar as { fontHangul?: string; fontLatin?: string } | null;
    if (mc?.fontHangul || mc?.fontLatin) f = { hangul: mc.fontHangul, latin: mc.fontLatin };
  } else {
    const m = n.firstChild?.marks.find((x) => x.type.name === 'font');
    if (m) f = m.attrs as { hangul: string; latin: string };
  }
  return f ? `;font-family:${fontStack(f.latin, f.hangul)};${fitVars(fontStack(f.latin, f.hangul), f.hangul)}` : '';
}

/** 문단 안 글자 중 가장 큰 크기(pt) — 줄 높이 계산용 */
function maxSizePt(n: import('prosemirror-model').Node): number {
  // 빈 문단은 문단 끝 글자 크기로 줄 높이를 정한다
  if (!n.content.size) return ((n.attrs.markChar?.size as number) ?? 1000) / 100;
  let max = 0;
  n.forEach((c) => {
    const m = c.marks.find((x) => x.type.name === 'size');
    max = Math.max(max, m ? m.attrs.size / 100 : 10);
  });
  return max || 10;
}

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  paragraph: {
    group: 'block',
    content: 'inline*',
    attrs: paraAttrs,
    parseDOM: [
      {
        tag: 'p',
        getAttrs: (dom: HTMLElement) => ({
          align: (['left', 'right', 'center', 'justify'].includes(dom.style.textAlign) ? dom.style.textAlign : 'justify'),
          style: dom.getAttribute('data-style'),
        }),
      },
      { tag: 'h1', attrs: { style: '개요 1' } },
      { tag: 'h2', attrs: { style: '개요 2' } },
      { tag: 'h3', attrs: { style: '개요 3' } },
      { tag: 'li' },
      { tag: 'div', priority: 10 },
    ],
    toDOM: (n): DOMOutputSpec => [
      'p',
      {
        style: `${paraStyle(n.attrs, maxSizePt(n))};font-size:${minSizePt(n)}pt${baseFont(n)}`,
        ...(n.attrs.style ? { 'data-style': n.attrs.style } : {}),
        ...(n.attrs.pageBreak ? { 'data-page-break': '1' } : {}),
      },
      0,
    ],
  },
  text: { group: 'inline' },
  tab: {
    group: 'inline',
    inline: true,
    atom: true,
    selectable: false,
    parseDOM: [{ tag: 'span.g-tab' }],
    toDOM: () => ['span', { class: 'g-tab' }, '\t'],
  },
  // 사용자 정의 영역 문자(한컴 확장 문자·기호 글꼴) — 원래 코드를 보존하고 화면에만 대체 표시
  pua: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: { ch: {} },
    parseDOM: [{ tag: 'span.g-pua', getAttrs: (dom: HTMLElement) => ({ ch: dom.dataset.ch }) }],
    toDOM: (n) => {
      const v = puaView(n.attrs.ch.codePointAt(0));
      return [
        'span',
        {
          class: `g-pua${v.boxed ? ' boxed' : ''}${v.unknown ? ' unknown' : ''}`,
          'data-ch': n.attrs.ch,
          title: `U+${n.attrs.ch.codePointAt(0).toString(16).toUpperCase()}`,
        },
        v.text,
      ];
    },
  },
  // 구역 나눔: 다음 구역의 용지 설정을 보관하고 새 쪽에서 시작한다
  section_break: {
    group: 'block',
    atom: true,
    selectable: true,
    attrs: { page: {} },
    parseDOM: [{ tag: 'div.g-section-break', getAttrs: (dom: HTMLElement) => ({ page: dom.dataset.page }) }],
    toDOM: (n) => ['div', { class: 'g-section-break', 'data-page': n.attrs.page, contenteditable: 'false' }],
  },
  hard_break: {
    group: 'inline',
    inline: true,
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },
  image: {
    group: 'inline',
    inline: true,
    draggable: true,
    attrs: { src: {}, ext: { default: 'png' }, width: { default: 14173 }, height: { default: 14173 } },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom: HTMLElement) => {
          const img = dom as HTMLImageElement;
          const w = img.width || img.naturalWidth || 200;
          const h = img.height || img.naturalHeight || 150;
          const src = img.getAttribute('src') ?? '';
          const m = /^data:image\/(\w+)/.exec(src);
          return { src, ext: m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : 'png', width: w * HU_PER_PX, height: h * HU_PER_PX };
        },
      },
    ],
    toDOM: (n) => ['img', { src: n.attrs.src, style: `width:${px(n.attrs.width)}px;height:${px(n.attrs.height)}px` }],
  },
  ...tableNodes({
    tableGroup: 'block',
    cellContent: 'block+',
    cellAttributes: {
      margin: {
        default: null,
        getFromDOM: () => null,
        setDOMAttr: (v, attrs) => {
          const m = v as { left: number; right: number; top: number; bottom: number } | null;
          if (m) attrs.style = (attrs.style || '') + `padding:${[m.top, m.right, m.bottom, m.left].map((v) => `${Math.max(0, px(v) - 0.5)}px`).join(' ')};`;
        },
      },
      background: {
        default: null,
        getFromDOM: (dom) => (dom as HTMLElement).style.backgroundColor || null,
        setDOMAttr: (v, attrs) => {
          if (v) attrs.style = (attrs.style || '') + `background-color:${v};`;
        },
      },
      vertAlign: {
        default: 'center',
        getFromDOM: (dom) => (dom as HTMLElement).style.verticalAlign || 'center',
        setDOMAttr: (v, attrs) => {
          attrs.style = (attrs.style || '') + `vertical-align:${v === 'center' ? 'middle' : v};`;
        },
      },
      height: {
        default: null,
        getFromDOM: () => null,
        setDOMAttr: (v, attrs) => {
          if (v) attrs.style = (attrs.style || '') + `height:${px(v as number)}px;`;
        },
      },
    },
  }),
};

// 표 전체 속성(테두리 표시)
nodes.table = {
  ...nodes.table,
  attrs: { borders: { default: true }, inMargin: { default: null }, outMargin: { default: null }, hostLine: { default: null }, pageBreak: { default: false } },
  toDOM: (n) => ['table', { class: n.attrs.borders ? 'g-table bordered' : 'g-table' }, ['tbody', 0]],
};

const marks: Record<string, MarkSpec> = {
  bold: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight', getAttrs: (v) => /^(bold(er)?|[6-9]\d\d)$/.test(v as string) && null }],
    toDOM: () => ['strong', 0],
  },
  italic: { parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }], toDOM: () => ['em', 0] },
  underline: { parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }], toDOM: () => ['u', 0] },
  strike: { parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }], toDOM: () => ['s', 0] },
  superscript: { excludes: 'subscript', parseDOM: [{ tag: 'sup' }], toDOM: () => ['sup', 0] },
  subscript: { excludes: 'superscript', parseDOM: [{ tag: 'sub' }], toDOM: () => ['sub', 0] },
  color: {
    attrs: { color: {} },
    parseDOM: [{ style: 'color', getAttrs: (v) => ({ color: v }) }],
    toDOM: (m) => ['span', { style: `color:${m.attrs.color}` }, 0],
  },
  highlight: {
    attrs: { color: {} },
    parseDOM: [{ tag: 'mark', getAttrs: (dom: HTMLElement) => ({ color: dom.style.backgroundColor || '#FFFF00' }) }],
    toDOM: (m) => ['mark', { style: `background-color:${m.attrs.color}` }, 0],
  },
  font: {
    attrs: { hangul: {}, latin: {} },
    parseDOM: [],
    toDOM: (m) => [
      'span',
      {
        style: `font-family:${fontStack(m.attrs.latin, m.attrs.hangul)};${fitVars(fontStack(m.attrs.latin, m.attrs.hangul), m.attrs.hangul)}${HEAVY.test(m.attrs.hangul ?? '') ? ';font-weight:800' : ''}`,
      },
      0,
    ],
  },
  size: {
    attrs: { size: {} },
    parseDOM: [],
    toDOM: (m) => ['span', { style: `font-size:${m.attrs.size / 100}pt` }, 0],
  },
  charExtra: {
    // 장평(ratio)·자간(spacing)
    attrs: { ratio: { default: 100 }, spacing: { default: 0 } },
    parseDOM: [],
    toDOM: (m) => [
      'span',
      {
        class: 'g-char-extra',
        // 장평은 글자 폭을 줄이는 것이므로 줄바꿈 폭이 같아지도록 자간으로 근사한다(한글은 전각: 1em 기준)
        style: `letter-spacing:calc(var(--fls, 0em) + ${(((m.attrs.ratio - 100) + (m.attrs.spacing * m.attrs.ratio) / 100) / 100).toFixed(3)}em)`,
      },
      0,
    ],
  },
};

const SANS = /고딕|돋움|굴림|Gothic|Dotum|Gulim|Sans/i;
const SERIF = /명조|바탕|궁서|Myeongjo|Myungjo|Batang|Gungsuh|Serif|Times|Georgia/i;
/** 이름 자체가 굵은 글꼴(헤드라인·견고딕 등) — 없을 때 굵게 대체 */
export const HEAVY = /헤드라인|견고딕|견명조|울릉도|굵은|Bold|Black|Heavy| B$/i;

/** 문서 글꼴이 없을 때 비슷한 계열(명조↔고딕)로 대체 */
export function fontStack(latin?: string, hangul?: string): string {
  const fams = [latin, hangul].filter(Boolean).map((f) => `"${f}"`);
  const name = hangul || latin || '';
  const serif = !SANS.test(name) && SERIF.test(name);
  const fallback = serif
    ? ['"AppleMyungjo"', '"Nanum Myeongjo"', '"Noto Serif KR"', 'serif']
    : ['"Apple SD Gothic Neo"', '"Malgun Gothic"', 'sans-serif'];
  return [...new Set(fams), ...fallback].join(',');
}

export const schema = new Schema({ nodes, marks });
