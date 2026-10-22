// 문서 모델 ↔ ProseMirror 문서 변환
import { Fragment, type Mark, type Node as PMNode } from 'prosemirror-model';
import type { Block, Cell, CharProps, GDocument, Paragraph, PageSetup, Run, Section, Table } from '../model/doc';
import { isPua } from '../model/pua';
import { A4 } from '../model/doc';
import { schema } from './schema';

const MIME: Record<string, string> = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', bmp: 'bmp', webp: 'webp', svg: 'svg+xml' };

function toBase64(data: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) s += String.fromCharCode(...data.subarray(i, i + chunk));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function charMarks(c: CharProps): Mark[] {
  const m: Mark[] = [];
  if (c.bold) m.push(schema.marks.bold.create());
  if (c.italic) m.push(schema.marks.italic.create());
  if (c.underline) m.push(schema.marks.underline.create());
  if (c.strike) m.push(schema.marks.strike.create());
  if (c.superscript) m.push(schema.marks.superscript.create());
  else if (c.subscript) m.push(schema.marks.subscript.create());
  if (c.color && c.color.toUpperCase() !== '#000000') m.push(schema.marks.color.create({ color: c.color }));
  if (c.highlight) m.push(schema.marks.highlight.create({ color: c.highlight }));
  if (c.fontHangul || c.fontLatin) m.push(schema.marks.font.create({ hangul: c.fontHangul ?? c.fontLatin, latin: c.fontLatin ?? c.fontHangul }));
  if (c.size && c.size !== 1000) m.push(schema.marks.size.create({ size: c.size }));
  if ((c.ratio && c.ratio !== 100) || c.spacing) m.push(schema.marks.charExtra.create({ ratio: c.ratio ?? 100, spacing: c.spacing ?? 0 }));
  return m;
}

function runToNodes(r: Run): PMNode[] {
  switch (r.type) {
    case 'text':
      return textNodes(r.text, charMarks(r.char));
    case 'tab':
      return [schema.nodes.tab.create()];
    case 'linebreak':
      return [schema.nodes.hard_break.create()];
    case 'image':
      return [
        schema.nodes.image.create({
          src: `data:image/${MIME[r.ext] ?? r.ext};base64,${toBase64(r.data)}`,
          ext: r.ext,
          width: r.width,
          height: r.height,
        }),
      ];
  }
}

/** 글자를 PM 노드로: PUA 문자는 별도 노드로 떼어 낸다 */
function textNodes(text: string, marks: Mark[]): PMNode[] {
  const out: PMNode[] = [];
  let buf = '';
  for (const ch of text) {
    if (isPua(ch.codePointAt(0)!)) {
      if (buf) out.push(schema.text(buf, marks));
      buf = '';
      out.push(schema.nodes.pua.create({ ch }, null, marks));
    } else buf += ch;
  }
  if (buf) out.push(schema.text(buf, marks));
  return out;
}

function paragraphNode(p: Paragraph): PMNode {
  return schema.nodes.paragraph.create(
    {
      align: p.para.align ?? 'justify',
      indent: p.para.indent ?? 0,
      marginLeft: p.para.marginLeft ?? 0,
      marginRight: p.para.marginRight ?? 0,
      spaceBefore: p.para.spaceBefore ?? 0,
      spaceAfter: p.para.spaceAfter ?? 0,
      lineSpacing: p.para.lineSpacing ?? 160,
      style: p.style ?? null,
      pageBreak: !!p.pageBreak,
      markChar: p.markChar ?? null,
    },
    p.runs.flatMap(runToNodes),
  );
}

function cellNode(c: Cell, colwidth: number[] | null): PMNode {
  const blocks = c.blocks.length ? c.blocks : [{ type: 'paragraph', para: {}, runs: [] } as Paragraph];
  return schema.nodes.table_cell.create(
    {
      colspan: c.colSpan,
      rowspan: c.rowSpan,
      colwidth,
      margin: c.margin ?? null,
      background: c.background ?? null,
      vertAlign: c.vertAlign ?? 'center',
      height: c.height ?? null,
    },
    blocks.map(blockNode),
  );
}

/** 병합을 고려해 각 칸의 격자 열 위치를 구한다 */
export function gridPlacement(t: Table): { col: number[][]; colCount: number } {
  const occupied: boolean[][] = [];
  const col: number[][] = [];
  let colCount = 0;
  t.rows.forEach((row, r) => {
    occupied[r] ??= [];
    col[r] = [];
    let c = 0;
    row.cells.forEach((cell, i) => {
      while (occupied[r][c]) c++;
      col[r][i] = c;
      for (let dr = 0; dr < cell.rowSpan; dr++)
        for (let dc = 0; dc < cell.colSpan; dc++) (occupied[r + dr] ??= [])[c + dc] = true;
      c += cell.colSpan;
      colCount = Math.max(colCount, c);
    });
  });
  return { col, colCount };
}

/**
 * 격자 열 너비(HWPUNIT) 풀이: 한 칸짜리 셀 너비로 열을 정하고,
 * 병합 셀은 아직 모르는 열에 남은 너비를 나눠 준다. 줄마다 열 구성이 다른 표(신청서 양식 등)에 필요.
 */
export function columnWidths(t: Table): number[] {
  const { col, colCount } = gridPlacement(t);
  const w: (number | null)[] = Array(colCount).fill(null);
  const cells = t.rows.flatMap((row, r) => row.cells.map((cell, i) => ({ cell, c: col[r][i] })));
  for (const { cell, c } of cells) if (cell.colSpan === 1 && cell.width && w[c] === null) w[c] = cell.width;
  for (let pass = 0; pass < colCount; pass++) {
    let changed = false;
    for (const { cell, c } of cells) {
      if (cell.colSpan === 1 || !cell.width) continue;
      const range = w.slice(c, c + cell.colSpan);
      const unknown = range.filter((x) => x === null).length;
      if (!unknown) continue;
      const known = range.reduce<number>((a, x) => a + (x ?? 0), 0);
      // 남은 너비가 1개 열이면 정확히, 여러 열이면 우선 칸 하나만 확정해 다른 셀 정보로 나머지를 풀게 한다
      if (unknown === 1) {
        const k = range.indexOf(null);
        w[c + k] = Math.max(cell.width - known, 300);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // 그래도 모르는 열: 병합 셀 너비를 균등 분배, 그것도 없으면 평균
  for (const { cell, c } of cells) {
    if (!cell.width) continue;
    const range = w.slice(c, c + cell.colSpan);
    const unknown = range.filter((x) => x === null).length;
    if (!unknown) continue;
    const known = range.reduce<number>((a, x) => a + (x ?? 0), 0);
    const each = Math.max((cell.width - known) / unknown, 300);
    for (let k = 0; k < cell.colSpan; k++) if (w[c + k] === null) w[c + k] = each;
  }
  const knownW = w.filter((x): x is number => x !== null);
  const avg = knownW.length ? knownW.reduce((a, b) => a + b, 0) / knownW.length : 42520 / Math.max(colCount, 1);
  return w.map((x) => Math.round(x ?? avg));
}

function tableNode(t: Table): PMNode {
  const hasWidths = t.rows.some((r) => r.cells.some((c) => c.width));
  const widths = hasWidths ? columnWidths(t).map((hu) => Math.max(8, Math.round(hu / 75))) : null;
  const { col } = gridPlacement(t);
  return schema.nodes.table.create(
    { borders: t.borders, inMargin: t.inMargin ?? null, outMargin: t.outMargin ?? null, hostLine: t.hostLine ?? null, pageBreak: !!t.pageBreak },
    t.rows.map((r, ri) =>
      schema.nodes.table_row.create(
        null,
        r.cells.map((c, i) => cellNode(c, widths ? widths.slice(col[ri][i], col[ri][i] + c.colSpan) : null)),
      ),
    ),
  );
}

function blockNode(b: Block): PMNode {
  return b.type === 'paragraph' ? paragraphNode(b) : tableNode(b);
}

/** 모델 → 편집기. 둘째 구역부터는 앞에 구역 나눔 노드(용지 설정 보관)를 둔다. */
export function modelToPM(doc: GDocument): { doc: PMNode; page: PageSetup } {
  const nodes: PMNode[] = [];
  doc.sections.forEach((sec, i) => {
    if (i > 0) nodes.push(schema.nodes.section_break.create({ page: JSON.stringify(sec.page) }));
    nodes.push(...sec.blocks.map(blockNode));
  });
  if (!nodes.length || nodes[nodes.length - 1].type !== schema.nodes.paragraph) nodes.push(schema.nodes.paragraph.create());
  return { doc: schema.nodes.doc.create(null, nodes), page: doc.sections[0]?.page ?? structuredClone(A4) };
}

// ---- 편집기 → 모델 ----

export function marksToChar(marks: readonly Mark[]): CharProps {
  const c: CharProps = {};
  for (const m of marks) {
    switch (m.type.name) {
      case 'bold':
        c.bold = true;
        break;
      case 'italic':
        c.italic = true;
        break;
      case 'underline':
        c.underline = true;
        break;
      case 'strike':
        c.strike = true;
        break;
      case 'superscript':
        c.superscript = true;
        break;
      case 'subscript':
        c.subscript = true;
        break;
      case 'color':
        c.color = normColor(m.attrs.color);
        break;
      case 'highlight':
        c.highlight = normColor(m.attrs.color);
        break;
      case 'font':
        c.fontHangul = m.attrs.hangul;
        c.fontLatin = m.attrs.latin;
        break;
      case 'size':
        c.size = m.attrs.size;
        break;
      case 'charExtra':
        if (m.attrs.ratio !== 100) c.ratio = m.attrs.ratio;
        if (m.attrs.spacing) c.spacing = m.attrs.spacing;
        break;
    }
  }
  return c;
}

/** rgb(…)·#abc 등 → #RRGGBB */
export function normColor(v: string): string {
  if (!v) return '#000000';
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('').toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return ('#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toUpperCase();
  return v.toUpperCase();
}

/** 같은 글자 모양이 이어지면 한 run 으로 합친다 */
function pushText(runs: Run[], text: string, char: CharProps) {
  const last = runs[runs.length - 1];
  if (last?.type === 'text' && JSON.stringify(last.char) === JSON.stringify(char)) last.text += text;
  else runs.push({ type: 'text', text, char });
}

function paragraphModel(n: PMNode): Paragraph {
  const runs: Run[] = [];
  n.forEach((child) => {
    if (child.isText) pushText(runs, child.text ?? '', marksToChar(child.marks));
    else if (child.type.name === 'pua') pushText(runs, child.attrs.ch, marksToChar(child.marks));
    else if (child.type.name === 'tab') runs.push({ type: 'tab' });
    else if (child.type.name === 'hard_break') runs.push({ type: 'linebreak' });
    else if (child.type.name === 'image') {
      const src: string = child.attrs.src;
      const b64 = src.slice(src.indexOf(',') + 1);
      runs.push({ type: 'image', data: fromBase64(b64), ext: child.attrs.ext, width: child.attrs.width, height: child.attrs.height });
    }
  });
  const a = n.attrs;
  return {
    type: 'paragraph',
    ...(a.style ? { style: a.style } : {}),
    ...(a.pageBreak ? { pageBreak: true } : {}),
    ...(a.markChar ? { markChar: a.markChar } : {}),
    para: {
      align: a.align,
      indent: a.indent,
      marginLeft: a.marginLeft,
      marginRight: a.marginRight,
      spaceBefore: a.spaceBefore,
      spaceAfter: a.spaceAfter,
      lineSpacing: a.lineSpacing,
    },
    runs,
  };
}

function blocksModel(f: Fragment | PMNode): Block[] {
  const out: Block[] = [];
  f.forEach((n) => {
    if (n.type.name === 'paragraph') out.push(paragraphModel(n));
    else if (n.type.name === 'table') out.push(tableModel(n));
  });
  return out;
}

function tableModel(n: PMNode): Table {
  return {
    type: 'table',
    borders: n.attrs.borders,
    ...(n.attrs.inMargin ? { inMargin: n.attrs.inMargin } : {}),
    ...(n.attrs.outMargin ? { outMargin: n.attrs.outMargin } : {}),
    ...(n.attrs.hostLine ? { hostLine: n.attrs.hostLine } : {}),
    ...(n.attrs.pageBreak ? { pageBreak: true } : {}),
    rows: (() => {
      const rows: Table['rows'] = [];
      n.forEach((row) => {
        const cells: Cell[] = [];
        row.forEach((cell) => {
          const cw: number[] | null = cell.attrs.colwidth;
          cells.push({
            colSpan: cell.attrs.colspan,
            rowSpan: cell.attrs.rowspan,
            ...(cw && cw.every(Boolean) ? { width: Math.round(cw.reduce((a, b) => a + b, 0) * 75) } : {}),
            ...(cell.attrs.height ? { height: cell.attrs.height } : {}),
            ...(cell.attrs.background ? { background: normColor(cell.attrs.background) } : {}),
            ...(cell.attrs.margin ? { margin: cell.attrs.margin } : {}),
            vertAlign: cell.attrs.vertAlign,
            blocks: blocksModel(cell),
          });
        });
        rows.push({ cells });
      });
      return rows;
    })(),
  };
}

/** 편집기 → 모델. 구역 나눔 노드에서 구역을 나눈다. */
export function pmToModel(doc: PMNode, page: PageSetup, meta: GDocument['meta']): GDocument {
  const sections: Section[] = [{ page, blocks: [] }];
  doc.forEach((n) => {
    if (n.type.name === 'section_break') {
      let pg: PageSetup = page;
      try {
        pg = JSON.parse(n.attrs.page);
      } catch {
        /* 손상된 값이면 첫 구역 용지 */
      }
      sections.push({ page: pg, blocks: [] });
    } else sections[sections.length - 1].blocks.push(...blocksModel(schema.nodes.doc.create(null, [n])));
  });
  for (const s of sections) if (!s.blocks.length) s.blocks.push({ type: 'paragraph', para: {}, runs: [] });
  return { meta, sections };
}
