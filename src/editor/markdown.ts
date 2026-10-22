// AI 도우미와 주고받는 마크다운 ↔ 편집기 문서
// 도우미에게는 문서를 마크다운으로 보여 주고, 돌려받은 마크다운을 문단·표로 바꿔 넣는다.
import { Fragment, Slice, type Mark, type Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { STYLES } from './commands';
import { schema } from './schema';

const N = schema.nodes;
const M = schema.marks;
const HEADINGS = ['개요 1', '개요 2', '개요 3'];

// ---------------- 문서 → 마크다운 ----------------

function inlineMd(n: PMNode): string {
  let s = '';
  n.forEach((c) => {
    if (c.isText) {
      const t = c.text ?? '';
      s += M.bold.isInSet(c.marks) && t.trim() ? `**${t}**` : t;
    } else if (c.type === N.tab) s += '\t';
    else if (c.type === N.hard_break) s += '  \n';
    else if (c.type === N.image) s += '[그림]';
    else if (c.type === N.pua) s += c.attrs.ch;
  });
  // 굵은 글자가 이어져 생긴 **** 는 합친다
  return s.replace(/\*\*\*\*/g, '');
}

function blockMd(n: PMNode, out: string[]) {
  if (n.type === N.paragraph) {
    const h = HEADINGS.indexOf(n.attrs.style);
    // 제목은 통째로 굵으므로 ** 는 뺀다
    const text = h >= 0 ? n.textContent : inlineMd(n);
    out.push(h >= 0 ? `${'#'.repeat(h + 1)} ${text}` : text);
  } else if (n.type === N.table) {
    const rows: string[][] = [];
    n.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => {
        const parts: string[] = [];
        cell.forEach((b) => parts.push(b.type === N.paragraph ? inlineMd(b) : b.textContent));
        cells.push(parts.join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim());
      });
      rows.push(cells);
    });
    if (!rows.length) return;
    const line = (r: string[]) => `| ${r.join(' | ')} |`;
    out.push([line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n'));
  }
}

/** 문서(또는 그 일부 블록들)를 마크다운으로 */
export function docToMarkdown(doc: PMNode): string {
  const out: string[] = [];
  doc.forEach((b) => blockMd(b, out));
  // 빈 문단이 여럿 이어지면 하나로
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------- 마크다운 → 문서 ----------------

/** 응답 전체를 감싼 ```markdown 울타리·앞뒤 빈 줄을 걷어 낸다 */
export function cleanReply(text: string): string {
  let t = text.replace(/\r\n?/g, '\n').trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1].trim();
  return t;
}

/** **굵게**, *기울임*, `코드` → 글자 마디 */
export function inlineNodes(text: string, base: readonly Mark[] = []): PMNode[] {
  const out: PMNode[] = [];
  const re = /\*\*(.+?)\*\*|__(.+?)__|(?<![*\w])\*(?!\s)(.+?)\*(?!\w)|`([^`]+)`/g;
  let last = 0;
  const push = (s: string, extra: Mark[] = []) => {
    if (!s) return;
    let marks = base;
    for (const m of extra) marks = m.addToSet(marks);
    // 탭은 탭 마디로
    s.split('\t').forEach((part, i) => {
      if (i) out.push(N.tab.create());
      if (part) out.push(schema.text(part, marks));
    });
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    push(text.slice(last, m.index));
    if (m[1] ?? m[2]) push(m[1] ?? m[2], [M.bold.create()]);
    else if (m[3]) push(m[3], [M.italic.create()]);
    else push(m[4]);
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out;
}

function paragraph(text: string, base: readonly Mark[], style?: string): PMNode {
  if (!style) return N.paragraph.create(null, inlineNodes(text, base));
  const st = STYLES[style];
  let marks = M.size.removeFromSet(M.bold.removeFromSet(base));
  if (st.size) marks = M.size.create({ size: st.size }).addToSet(marks);
  if (st.bold) marks = M.bold.create().addToSet(marks);
  // 제목 안의 ** 는 이미 굵으니 걷어 낸다
  return N.paragraph.create({ ...st.para, style }, inlineNodes(text.replace(/\*\*/g, ''), marks));
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

function table(lines: string[], base: readonly Mark[], widthPx: number): PMNode {
  const rows = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map(splitRow);
  const cols = Math.max(...rows.map((r) => r.length));
  // 열 너비: 칸 글자 수에 비례(너무 좁아지지 않게 최소 비율을 둔다)
  const len = Array.from({ length: cols }, (_, ci) => Math.max(2, ...rows.map((r) => (r[ci] ?? '').length)));
  const weight = len.map((l) => Math.max(Math.sqrt(l), Math.sqrt(Math.max(...len)) * 0.45));
  const sum = weight.reduce((a, b) => a + b, 0);
  const widths = weight.map((x) => Math.floor((widthPx * x) / sum));
  return N.table.create(
    { borders: true },
    rows.map((r, ri) =>
      N.table_row.create(
        null,
        Array.from({ length: cols }, (_, ci) => {
          const text = r[ci] ?? '';
          // 첫 줄(머리글)은 굵게·가운데
          // 머리글 줄은 굵게·가운데, 나머지는 왼쪽 정렬(좁은 칸에서 양쪽 정렬은 띄어쓰기가 벌어진다)
          const p =
            ri === 0
              ? N.paragraph.create({ align: 'center' }, inlineNodes(text.replace(/\*\*/g, ''), M.bold.create().addToSet(base)))
              : N.paragraph.create({ align: 'left' }, inlineNodes(text, base));
          return N.table_cell.create({ colwidth: [widths[ci]], background: ri === 0 ? '#EEF2F8' : null }, p);
        }),
      ),
    ),
  );
}

/**
 * 마크다운 → 블록 마디들.
 * 제목(#~###) → 개요 1~3, 목록(-, *, 1.) → 글머리 문자를 붙인 문단, 표(| |) → 표, 그 밖의 줄 → 문단.
 */
export function markdownToBlocks(md: string, opts: { base?: readonly Mark[]; tableWidthPx?: number } = {}): PMNode[] {
  const base = opts.base ?? [];
  const lines = cleanReply(md).split('\n');
  const out: PMNode[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(paragraph(para.join(' '), base));
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const rows: string[] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) rows.push(lines[i++].trim());
      i--;
      out.push(table(rows, base, opts.tableWidthPx ?? 600));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      out.push(paragraph(h[2].replace(/\s+#+$/, ''), base, HEADINGS[Math.min(h[1].length, 3) - 1]));
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flush();
      continue;
    }
    const li = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const depth = Math.min(3, Math.floor(li[1].replace(/\t/g, '  ').length / 2));
      const bullet = /\d/.test(li[2]) ? `${li[2].replace(')', '.')} ` : depth ? '- ' : '• ';
      const p = paragraph(bullet + li[3], base);
      out.push(depth ? N.paragraph.create({ ...p.attrs, marginLeft: depth * 1500 }, p.content) : p);
      continue;
    }
    // 마크다운 줄 끝 공백 둘(줄 바꿈)은 한 문단 안 줄 바꿈으로
    if (/ {2}$/.test(line) || para.length === 0) {
      para.push(t);
      if (/ {2}$/.test(line)) {
        out.push(paragraph(para.join(' '), base));
        para = [];
      }
      continue;
    }
    // 마크다운처럼 줄을 이어 붙이지 않고, 줄마다 문단을 나눈다(한국어 문서는 줄 = 문단이 자연스럽다)
    flush();
    para.push(t);
  }
  flush();
  return out.length ? out : [N.paragraph.create()];
}

// ---------------- 넣기 ----------------

/** 넣을 자리의 글자 모양(글꼴·크기·색)을 이어받는다. 굵게·기울임 등은 빼고 */
export function baseMarksAt(state: EditorState, pos: number): readonly Mark[] {
  const $p = state.doc.resolve(pos);
  const keep = [M.font, M.size, M.color, M.charExtra];
  return $p.marks().filter((m) => keep.includes(m.type));
}

/**
 * from~to 를 마크다운 내용으로 바꾼다(from===to 이면 그 자리에 넣기).
 * 한 문단짜리 응답은 문단 안에 글자로, 여러 블록은 문단을 나눠 끼워 넣는다.
 */
export function replaceWithMarkdown(tr: Transaction, from: number, to: number, md: string, tableWidthPx: number): Transaction {
  const state = { doc: tr.doc } as EditorState;
  const base = baseMarksAt(state, from);
  const blocks = markdownToBlocks(md, { base, tableWidthPx });
  const $from = tr.doc.resolve(from);
  const inText = $from.parent.isTextblock;
  const plain = blocks.length === 1 && blocks[0].type === N.paragraph && !blocks[0].attrs.style;
  if (plain && inText) {
    tr.replaceWith(from, to, blocks[0].content);
    return tr;
  }
  if (!inText) {
    tr.replaceRange(from, to, new Slice(Fragment.from(blocks), 0, 0));
    return tr;
  }
  // 빈 문단에 넣으면 그 문단을 통째로 바꾼다
  if (from === to && !$from.parent.content.size && $from.depth > 0) {
    tr.replaceWith($from.before(), $from.after(), blocks);
    return tr;
  }
  // 문단 사이에 끼울 수 있게 앞뒤를 '열린' 보통 문단으로 둔다.
  // 제목·표가 앞뒤 끝에 오면 커서 앞뒤 글자와 합쳐지지 않도록 빈 문단을 덧댄다
  const content = [...blocks];
  const open = (n: PMNode) => n.type === N.paragraph && !n.attrs.style;
  if (!open(content[0])) content.unshift(N.paragraph.create());
  if (!open(content[content.length - 1])) content.push(N.paragraph.create());
  tr.replaceRange(from, to, new Slice(Fragment.from(content), 1, 1));
  return tr;
}
