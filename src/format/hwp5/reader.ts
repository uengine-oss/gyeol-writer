// HWP 5.0 (바이너리 .hwp) 읽기 — 한컴이 공개한 「한글 문서 파일 형식 5.0」 명세에 따라 작성.
// OLE 복합 파일(cfb) → FileHeader / DocInfo / BodyText/Section{n} 레코드 → GDocument.
import * as CFBns from 'cfb';
import { inflateRaw, inflate } from 'pako';
import {
  A4,
  type Align,
  type Block,
  type Cell,
  type CharProps,
  type DocMeta,
  type GDocument,
  type PageSetup,
  type Paragraph,
  type ParaProps,
  type Row,
  type Run,
  type Section,
  type Table,
} from '../../model/doc';

// cfb 는 CommonJS — 번들러/Node ESM 양쪽에서 동작하도록 default 우선.
const CFB: typeof CFBns = ((CFBns as unknown as { default?: typeof CFBns }).default ?? CFBns) as typeof CFBns;

// ───────────────────────── 태그 상수 ─────────────────────────
const TAG_BEGIN = 0x10;
const T = {
  DOCUMENT_PROPERTIES: TAG_BEGIN,
  ID_MAPPINGS: TAG_BEGIN + 1,
  BIN_DATA: TAG_BEGIN + 2,
  FACE_NAME: TAG_BEGIN + 3,
  BORDER_FILL: TAG_BEGIN + 4,
  CHAR_SHAPE: TAG_BEGIN + 5,
  PARA_SHAPE: TAG_BEGIN + 9,
  STYLE: TAG_BEGIN + 10,

  PARA_HEADER: TAG_BEGIN + 50,
  PARA_TEXT: TAG_BEGIN + 51,
  PARA_CHAR_SHAPE: TAG_BEGIN + 52,
  CTRL_HEADER: TAG_BEGIN + 55,
  LIST_HEADER: TAG_BEGIN + 56,
  PAGE_DEF: TAG_BEGIN + 57,
  SHAPE_COMPONENT: TAG_BEGIN + 60,
  TABLE: TAG_BEGIN + 61,
  SHAPE_COMPONENT_PICTURE: TAG_BEGIN + 69,
} as const;

// ───────────────────────── 바이트 유틸 ─────────────────────────
class Reader {
  readonly dv: DataView;
  pos = 0;
  constructor(readonly buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remain(): number {
    return this.buf.length - this.pos;
  }
  u8(): number {
    return this.pos + 1 <= this.buf.length ? this.dv.getUint8(this.pos++) : (this.pos++, 0);
  }
  i8(): number {
    const v = this.u8();
    return v > 127 ? v - 256 : v;
  }
  u16(): number {
    if (this.pos + 2 > this.buf.length) return (this.pos += 2), 0;
    const v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16(): number {
    const v = this.u16();
    return v > 0x7fff ? v - 0x10000 : v;
  }
  u32(): number {
    if (this.pos + 4 > this.buf.length) return (this.pos += 4), 0;
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    return this.u32() | 0;
  }
  skip(n: number): void {
    this.pos += n;
  }
  /** WORD 길이 + WCHAR[len] */
  wstr(): string {
    const n = this.u16();
    const end = Math.min(this.buf.length, this.pos + n * 2);
    const s = utf16(this.buf.subarray(this.pos, end));
    this.pos += n * 2;
    return s;
  }
}

const UTF16 = new TextDecoder('utf-16le');
function utf16(b: Uint8Array): string {
  return UTF16.decode(b.length % 2 ? b.subarray(0, b.length - 1) : b);
}

function colorRef(v: number): string {
  const r = v & 0xff;
  const g = (v >>> 8) & 0xff;
  const b = (v >>> 16) & 0xff;
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function ctrlIdStr(id: number): string {
  return String.fromCharCode((id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff);
}

function toU8(content: unknown): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (Array.isArray(content)) return Uint8Array.from(content as number[]);
  if (content && typeof content === 'object' && 'length' in (content as ArrayLike<number>))
    return Uint8Array.from(content as ArrayLike<number>);
  return new Uint8Array(0);
}

function decompress(data: Uint8Array): Uint8Array {
  try {
    return inflateRaw(data);
  } catch {
    try {
      return inflate(data);
    } catch {
      return data;
    }
  }
}

// ───────────────────────── 레코드 ─────────────────────────
interface Rec {
  tag: number;
  level: number;
  data: Uint8Array;
  children: Rec[];
}

function parseRecords(buf: Uint8Array): Rec[] {
  const out: Rec[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  while (p + 4 <= buf.length) {
    const h = dv.getUint32(p, true);
    p += 4;
    const tag = h & 0x3ff;
    const level = (h >>> 10) & 0x3ff;
    let size = h >>> 20;
    if (size === 0xfff) {
      if (p + 4 > buf.length) break;
      size = dv.getUint32(p, true);
      p += 4;
    }
    const end = Math.min(buf.length, p + size);
    out.push({ tag, level, data: buf.subarray(p, end), children: [] });
    p = end;
  }
  return out;
}

/** 레벨에 따라 트리로 묶는다: 레벨 n 레코드는 직전의 레벨 n-1 레코드의 자식. */
function buildTree(list: Rec[]): Rec[] {
  const roots: Rec[] = [];
  const stack: Rec[] = [];
  for (const r of list) {
    while (stack.length && stack[stack.length - 1].level >= r.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(r);
    else roots.push(r);
    stack.push(r);
  }
  return roots;
}

// ───────────────────────── DocInfo ─────────────────────────
interface CharShape {
  props: CharProps;
}
interface ParaShape {
  props: ParaProps;
}
interface BorderFill {
  hasBorder: boolean;
  background?: string;
}
interface BinItem {
  id: number;
  ext: string;
  compress: number; // 0 = 저장소 기본, 1 = 압축, 2 = 비압축
}
interface DocInfo {
  version: number;
  compressed: boolean;
  fonts: string[][]; // 언어별 글꼴 이름
  charShapes: CharShape[];
  paraShapes: ParaShape[];
  borderFills: BorderFill[];
  styles: string[];
  binItems: BinItem[]; // 순서 = 1-based BinItem id - 1
}

const ALIGN: Align[] = ['justify', 'left', 'right', 'center', 'distribute', 'distribute'];

function parseDocInfo(recs: Rec[], version: number, compressed: boolean): DocInfo {
  const info: DocInfo = {
    version,
    compressed,
    fonts: [[], [], [], [], [], [], []],
    charShapes: [],
    paraShapes: [],
    borderFills: [],
    styles: [],
    binItems: [],
  };
  let fontCounts: number[] = [];
  let faceIndex = 0;
  for (const r of recs) {
    try {
      const rd = new Reader(r.data);
      switch (r.tag) {
        case T.ID_MAPPINGS: {
          const counts: number[] = [];
          while (rd.remain >= 4) counts.push(rd.i32());
          fontCounts = counts.slice(1, 8);
          break;
        }
        case T.FACE_NAME: {
          rd.u8(); // 속성
          const name = rd.wstr();
          // 언어 그룹 결정: ID_MAPPINGS 의 언어별 개수를 순서대로 소비
          let lang = 0;
          let acc = 0;
          for (; lang < 7; lang++) {
            acc += fontCounts[lang] ?? 0;
            if (faceIndex < acc) break;
          }
          if (lang >= 7) lang = fontCounts.length ? 6 : 0;
          info.fonts[lang].push(name);
          faceIndex++;
          break;
        }
        case T.BIN_DATA: {
          const attr = rd.u16();
          const type = attr & 0xf;
          const compress = (attr >>> 4) & 0x3;
          if (type === 0) {
            rd.wstr();
            rd.wstr();
            info.binItems.push({ id: 0, ext: '', compress });
          } else {
            const id = rd.u16();
            const ext = type === 1 ? rd.wstr() : '';
            info.binItems.push({ id, ext: ext.toLowerCase(), compress });
          }
          break;
        }
        case T.BORDER_FILL: {
          rd.u16(); // 속성
          let hasBorder = false;
          for (let i = 0; i < 4; i++) {
            const type = rd.u8();
            rd.u8(); // 굵기
            rd.u32(); // 색
            if (type !== 0) hasBorder = true;
          }
          rd.skip(6); // 대각선
          const bf: BorderFill = { hasBorder };
          if (rd.remain >= 4) {
            const fillType = rd.u32();
            if (fillType & 1) {
              const bg = rd.u32();
              if (bg !== 0xffffffff && (bg & 0xffffff) !== 0xffffff) bf.background = colorRef(bg);
            }
          }
          info.borderFills.push(bf);
          break;
        }
        case T.CHAR_SHAPE: {
          const face: number[] = [];
          for (let i = 0; i < 7; i++) face.push(rd.u16());
          const ratio: number[] = [];
          for (let i = 0; i < 7; i++) ratio.push(rd.u8());
          const spacing: number[] = [];
          for (let i = 0; i < 7; i++) spacing.push(rd.i8());
          rd.skip(7); // 상대 크기
          rd.skip(7); // 글자 위치
          const size = rd.i32();
          const attr = rd.u32();
          rd.skip(2); // 그림자 간격
          const color = rd.u32();
          rd.u32(); // 밑줄 색
          const shade = rd.u32();
          const p: CharProps = {
            fontHangul: info.fonts[0][face[0]],
            fontLatin: info.fonts[1][face[1]],
            size,
            color: colorRef(color),
          };
          if (attr & 1) p.italic = true;
          if (attr & 2) p.bold = true;
          if ((attr >>> 2) & 3) p.underline = true;
          if ((attr >>> 18) & 7) p.strike = true;
          if (attr & (1 << 15)) p.superscript = true;
          if (attr & (1 << 16)) p.subscript = true;
          if (ratio[0] && ratio[0] !== 100) p.ratio = ratio[0];
          if (spacing[0]) p.spacing = spacing[0];
          if (shade !== 0xffffffff && (shade & 0xffffff) !== 0xffffff) p.highlight = colorRef(shade);
          if (!p.fontHangul) delete p.fontHangul;
          if (!p.fontLatin) delete p.fontLatin;
          info.charShapes.push({ props: p });
          break;
        }
        case T.PARA_SHAPE: {
          const attr1 = rd.u32();
          const left = rd.i32();
          const right = rd.i32();
          const indent = rd.i32();
          const prev = rd.i32();
          const next = rd.i32();
          const oldLine = rd.i32();
          let lineType = attr1 & 3;
          let line = oldLine;
          // 5.0.2.5 이상: 속성3(줄 간격 종류) + 줄 간격
          if (r.data.length >= 54 && version >= 0x05000205) {
            rd.pos = 46;
            const attr3 = rd.u32();
            const l2 = rd.u32();
            lineType = attr3 & 0x1f;
            line = l2;
          }
          const p: ParaProps = {
            align: ALIGN[(attr1 >>> 2) & 7] ?? 'justify',
          };
          // 명세상 문단 여백/간격 값은 HWPUNIT 의 2배 단위로 저장된다(데이터 확인).
          if (left) p.marginLeft = Math.round(left / 2);
          if (right) p.marginRight = Math.round(right / 2);
          if (indent) p.indent = Math.round(indent / 2);
          if (prev) p.spaceBefore = Math.round(prev / 2);
          if (next) p.spaceAfter = Math.round(next / 2);
          if (lineType === 0 && line > 0) p.lineSpacing = line;
          info.paraShapes.push({ props: p });
          break;
        }
        case T.STYLE: {
          info.styles.push(rd.wstr());
          break;
        }
      }
    } catch {
      // 알 수 없는/깨진 레코드는 무시
    }
  }
  return info;
}

// ───────────────────────── BodyText ─────────────────────────
interface Ctx {
  info: DocInfo;
  files: Map<string, Uint8Array>;
}

function isExtended(c: number): boolean {
  return c === 1 || c === 2 || c === 3 || c === 11 || c === 12 || (c >= 14 && c <= 18) || (c >= 21 && c <= 23);
}
function isInline(c: number): boolean {
  return (c >= 4 && c <= 9) || c === 19 || c === 20;
}

function readPageDef(r: Rec): PageSetup {
  const rd = new Reader(r.data);
  let width = rd.u32();
  let height = rd.u32();
  const left = rd.u32();
  const right = rd.u32();
  const top = rd.u32();
  const bottom = rd.u32();
  const header = rd.u32();
  const footer = rd.u32();
  const gutter = rd.u32();
  const attr = rd.u32();
  const landscape = (attr & 1) === 1;
  if (landscape && width < height) [width, height] = [height, width];
  if (!width || !height) return structuredClone(A4);
  return { width, height, landscape, margin: { left, right, top, bottom, header, footer, gutter } };
}

function findDeep(r: Rec, tag: number): Rec | undefined {
  for (const c of r.children) {
    if (c.tag === tag) return c;
    const d = findDeep(c, tag);
    if (d) return d;
  }
  return undefined;
}

interface ParaOut {
  blocks: Block[];
  page?: PageSetup;
}

/** 문단(PARA_HEADER 와 그 자식들)을 블록들로 변환. 표가 있으면 문단이 여러 블록으로 나뉜다. */
function convertParagraph(ph: Rec, ctx: Ctx): ParaOut {
  const hd = new Reader(ph.data);
  hd.u32(); // 글자 수
  hd.u32(); // 컨트롤 마스크
  const paraShapeId = hd.u16();
  const styleId = hd.u8();
  const breakType = hd.u8();

  let textRec: Rec | undefined;
  let csRec: Rec | undefined;
  const ctrls: Rec[] = [];
  for (const c of ph.children) {
    if (c.tag === T.PARA_TEXT) textRec = c;
    else if (c.tag === T.PARA_CHAR_SHAPE) csRec = c;
    else if (c.tag === T.CTRL_HEADER) ctrls.push(c);
  }

  // 글자 모양 구간
  const csPos: number[] = [];
  const csId: number[] = [];
  if (csRec) {
    const rd = new Reader(csRec.data);
    while (rd.remain >= 8) {
      csPos.push(rd.u32());
      csId.push(rd.u32());
    }
  }
  let csIdx = 0;
  const shapeAt = (pos: number): number => {
    while (csIdx + 1 < csPos.length && csPos[csIdx + 1] <= pos) csIdx++;
    return csId[csIdx] ?? 0;
  };
  const charProps = (id: number): CharProps => ({ ...(ctx.info.charShapes[id]?.props ?? {}) });

  const paraProps: ParaProps = { ...(ctx.info.paraShapes[paraShapeId]?.props ?? {}) };
  const style = ctx.info.styles[styleId];

  const out: ParaOut = { blocks: [] };
  let runs: Run[] = [];
  let curShape = -1;
  let first = true;
  let emittedSomething = false;

  const pushText = (s: string, pos: number) => {
    const id = shapeAt(pos);
    const last = runs[runs.length - 1];
    if (last && last.type === 'text' && curShape === id) last.text += s;
    else {
      runs.push({ type: 'text', text: s, char: charProps(id) });
      curShape = id;
    }
  };
  const flush = (force: boolean) => {
    if (!runs.length && !force) return;
    const p: Paragraph = { type: 'paragraph', para: { ...paraProps }, runs };
    if (style) p.style = style;
    if (first && breakType & 0x04) p.pageBreak = true;
    first = false;
    out.blocks.push(p);
    emittedSomething = true;
    runs = [];
    curShape = -1;
  };
  const pushBlock = (b: Block) => {
    flush(false);
    first = false;
    out.blocks.push(b);
    emittedSomething = true;
  };

  let ctrlIdx = 0;
  const handleCtrl = () => {
    const c = ctrls[ctrlIdx++];
    if (!c) return;
    let id = '';
    try {
      id = ctrlIdStr(new Reader(c.data).u32());
    } catch {
      return;
    }
    try {
      if (id === 'secd') {
        const pd = c.children.find((x) => x.tag === T.PAGE_DEF);
        if (pd) out.page = readPageDef(pd);
      } else if (id === 'tbl ') {
        const t = convertTable(c, ctx);
        if (t) pushBlock(t);
      } else if (id === 'gso ') {
        convertGso(c, ctx, runs, pushBlock, () => curShape = -1);
      }
      // 머리말/꼬리말/각주/필드/수식 등은 건너뜀(필드 안의 보이는 글자는 본문에 그대로 있음)
    } catch {
      // 컨트롤 하나가 깨져도 문서 전체는 계속
    }
  };

  if (textRec) {
    const b = textRec.data;
    const n = b.length >> 1;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let i = 0;
    let seg = '';
    let segStart = 0;
    const flushSeg = () => {
      if (!seg) return;
      // 구간 안에서 글자 모양이 바뀌면 나눈다
      let start = segStart;
      let s = seg;
      while (s.length) {
        shapeAt(start); // csIdx 를 start 위치로 맞춤
        const nextPos = csIdx + 1 < csPos.length ? csPos[csIdx + 1] : Infinity;
        const take = Math.max(1, Math.min(s.length, nextPos - start));
        pushText(s.slice(0, take), start);
        s = s.slice(take);
        start += take;
      }
      seg = '';
    };
    while (i < n) {
      const c = dv.getUint16(i * 2, true);
      if (c >= 32) {
        if (!seg) segStart = i;
        seg += String.fromCharCode(c);
        i++;
        continue;
      }
      flushSeg();
      if (c === 13) break;
      if (c === 10) {
        runs.push({ type: 'linebreak' });
        curShape = -1;
        i++;
      } else if (c === 24) {
        segStart = i;
        seg = '-';
        flushSeg();
        i++;
      } else if (c === 30 || c === 31) {
        segStart = i;
        seg = ' ';
        flushSeg();
        i++;
      } else if (c === 9) {
        runs.push({ type: 'tab' });
        curShape = -1;
        i += 8;
      } else if (isExtended(c)) {
        handleCtrl();
        i += 8;
      } else if (isInline(c)) {
        i += 8;
      } else {
        i++;
      }
    }
    flushSeg();
  } else {
    // 텍스트 레코드가 없어도 컨트롤(구역 정의 등)은 처리
    while (ctrlIdx < ctrls.length) handleCtrl();
  }

  if (runs.length || !emittedSomething) flush(true);
  return out;
}

function convertParagraphList(list: Rec[], ctx: Ctx): Block[] {
  const blocks: Block[] = [];
  for (const r of list) if (r.tag === T.PARA_HEADER) blocks.push(...convertParagraph(r, ctx).blocks);
  return blocks;
}

function convertTable(ctrl: Rec, ctx: Ctx): Table | undefined {
  const tblRec = ctrl.children.find((x) => x.tag === T.TABLE);
  if (!tblRec) return undefined;
  const tr = new Reader(tblRec.data);
  tr.u32();
  const nRows = tr.u16();
  const nCols = tr.u16();
  void nCols;

  interface RawCell {
    col: number;
    row: number;
    cell: Cell;
    hasBorder: boolean;
  }
  const cells: RawCell[] = [];
  const kids = ctrl.children;
  for (let i = 0; i < kids.length; i++) {
    const lh = kids[i];
    if (lh.tag !== T.LIST_HEADER) continue;
    const rd = new Reader(lh.data);
    const nParas = rd.i16();
    const attr = rd.u32();
    rd.u16(); // 알 수 없는 2바이트(데이터상 존재)
    const col = rd.u16();
    const row = rd.u16();
    const colSpan = rd.u16() || 1;
    const rowSpan = rd.u16() || 1;
    const width = rd.u32();
    const height = rd.u32();
    rd.skip(8); // 안 여백
    const bfId = rd.u16();
    const paras: Rec[] = [];
    let j = i + 1;
    while (j < kids.length && kids[j].tag === T.PARA_HEADER) {
      paras.push(kids[j]);
      j++;
      if (nParas > 0 && paras.length >= nParas) break;
    }
    i = j - 1;
    const blocks = convertParagraphList(paras, ctx);
    const bf = ctx.info.borderFills[bfId - 1];
    const va = (attr >>> 21) & 3; // 세로 정렬(데이터상 비트 21-22)
    const cell: Cell = {
      colSpan,
      rowSpan,
      width,
      height,
      vertAlign: va === 1 ? 'center' : va === 2 ? 'bottom' : 'top',
      blocks: blocks.length ? blocks : [{ type: 'paragraph', para: {}, runs: [] }],
    };
    if (bf?.background) cell.background = bf.background;
    cells.push({ col, row, cell, hasBorder: !!bf?.hasBorder });
  }
  const rowCount = Math.max(nRows, ...cells.map((c) => c.row + 1), 0);
  const rows: Row[] = Array.from({ length: rowCount }, () => ({ cells: [] }));
  cells.sort((a, b) => a.row - b.row || a.col - b.col);
  for (const c of cells) rows[c.row]?.cells.push(c.cell);
  return {
    type: 'table',
    rows: rows.filter((r) => r.cells.length),
    borders: cells.length ? cells.some((c) => c.hasBorder) : true,
  };
}

/** 그리기 개체: 그림이면 ImageRun, 글상자면 안의 문단을 블록으로. 묶음 개체는 재귀. */
function convertGso(ctrl: Rec, ctx: Ctx, runs: Run[], pushBlock: (b: Block) => void, resetShape: () => void): void {
  const cr = new Reader(ctrl.data);
  cr.skip(16);
  const width = cr.u32();
  const height = cr.u32();
  const walk = (r: Rec) => {
    for (let i = 0; i < r.children.length; i++) {
      const c = r.children[i];
      if (c.tag === T.SHAPE_COMPONENT_PICTURE) {
        const img = readPicture(c, ctx, width, height);
        if (img) {
          runs.push(img);
          resetShape();
        }
      } else if (c.tag === T.LIST_HEADER) {
        // 글상자: 뒤따르는 문단들
        const paras: Rec[] = [];
        let j = i + 1;
        while (j < r.children.length && r.children[j].tag === T.PARA_HEADER) paras.push(r.children[j++]);
        i = j - 1;
        for (const b of convertParagraphList(paras, ctx)) pushBlock(b);
      } else if (c.tag === T.SHAPE_COMPONENT || c.children.length) {
        walk(c);
      }
    }
  };
  walk(ctrl);
}

function readPicture(r: Rec, ctx: Ctx, width: number, height: number): Run | undefined {
  if (r.data.length < 73) return undefined;
  const rd = new Reader(r.data);
  rd.pos = 71;
  const binId = rd.u16();
  const item = ctx.info.binItems[binId - 1];
  if (!item || !item.id) return undefined;
  const name = `BIN${item.id.toString(16).toUpperCase().padStart(4, '0')}.${item.ext}`;
  let data = ctx.files.get(`BinData/${name}`);
  if (!data) {
    // 확장자 대소문자 차이 대비
    const lower = `bindata/${name.toLowerCase()}`;
    for (const [k, v] of ctx.files) if (k.toLowerCase() === lower) data = v;
  }
  if (!data) return undefined;
  const compressed = item.compress === 1 || (item.compress === 0 && ctx.info.compressed);
  if (compressed) data = decompress(data);
  let ext = item.ext === 'jpeg' ? 'jpg' : item.ext;
  if (!ext) ext = 'bin';
  return { type: 'image', data, ext, width, height };
}

// ───────────────────────── 요약 정보 ─────────────────────────
function parseSummary(b: Uint8Array): DocMeta {
  const meta: DocMeta = {};
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 48) return meta;
  const secOff = dv.getUint32(44, true);
  const count = dv.getUint32(secOff + 4, true);
  const fileTime = (o: number) => {
    const lo = dv.getUint32(o, true);
    const hi = dv.getUint32(o + 4, true);
    const ms = (hi * 2 ** 32 + lo) / 10000 - 11644473600000;
    return ms > 0 ? new Date(ms).toISOString() : undefined;
  };
  for (let i = 0; i < count && i < 64; i++) {
    const pid = dv.getUint32(secOff + 8 + i * 8, true);
    const off = secOff + dv.getUint32(secOff + 12 + i * 8, true);
    if (off + 8 > b.length) continue;
    const type = dv.getUint32(off, true);
    let val: string | undefined;
    if (type === 0x1f) {
      const n = dv.getUint32(off + 4, true);
      val = utf16(b.subarray(off + 8, Math.min(b.length, off + 8 + n * 2))).replace(/\0+$/, '');
    } else if (type === 0x40) val = fileTime(off + 4);
    if (val === undefined) continue;
    if (pid === 2) meta.title = val;
    else if (pid === 4) meta.creator = val;
    else if (pid === 12) meta.createdAt = val;
    else if (pid === 13) meta.modifiedAt = val;
  }
  return meta;
}

// ───────────────────────── 진입점 ─────────────────────────
export async function readHwp5(bytes: Uint8Array): Promise<GDocument> {
  let cfb: ReturnType<typeof CFB.read>;
  try {
    cfb = CFB.read(bytes, { type: 'array' });
  } catch {
    throw new Error('HWP 5.0 문서가 아닙니다(OLE 복합 파일을 읽을 수 없음)');
  }
  const files = new Map<string, Uint8Array>();
  cfb.FullPaths.forEach((p, i) => {
    const e = cfb.FileIndex[i];
    if (!e || e.type !== 2) return;
    const key = p.replace(/^[^/]*\//, '');
    files.set(key, toU8(e.content));
  });

  const fh = files.get('FileHeader');
  if (!fh || fh.length < 40) throw new Error('HWP 5.0 문서가 아닙니다(FileHeader 없음)');
  const sig = new TextDecoder('latin1').decode(fh.subarray(0, 17));
  if (sig !== 'HWP Document File') throw new Error('HWP 5.0 문서가 아닙니다(서명 불일치)');
  const fdv = new DataView(fh.buffer, fh.byteOffset, fh.byteLength);
  const version = fdv.getUint32(32, true);
  const flags = fdv.getUint32(36, true);
  if (flags & 0x02) throw new Error('암호가 걸린 문서는 열 수 없습니다');
  if (flags & 0x04 || flags & 0x10 || (!files.has('BodyText/Section0') && files.has('ViewText/Section0')))
    throw new Error('배포용(보호) 문서는 열 수 없습니다');
  const compressed = (flags & 0x01) === 1;
  const stream = (name: string) => {
    const d = files.get(name);
    if (!d) return undefined;
    return compressed ? decompress(d) : d;
  };

  const docInfoBytes = stream('DocInfo');
  const info = parseDocInfo(docInfoBytes ? parseRecords(docInfoBytes) : [], version, compressed);
  const ctx: Ctx = { info, files };

  const sections: Section[] = [];
  for (let n = 0; ; n++) {
    const sb = stream(`BodyText/Section${n}`);
    if (!sb) break;
    const tree = buildTree(parseRecords(sb));
    let page: PageSetup | undefined;
    const blocks: Block[] = [];
    for (const r of tree) {
      if (r.tag !== T.PARA_HEADER) continue;
      try {
        const o = convertParagraph(r, ctx);
        if (o.page && !page) page = o.page;
        blocks.push(...o.blocks);
      } catch {
        // 문단 하나 실패해도 계속
      }
    }
    sections.push({
      page: page ?? structuredClone(A4),
      blocks: blocks.length ? blocks : [{ type: 'paragraph', para: {}, runs: [] }],
    });
  }
  if (!sections.length) sections.push({ page: structuredClone(A4), blocks: [{ type: 'paragraph', para: {}, runs: [] }] });

  let meta: DocMeta = {};
  try {
    const s = files.get('\u0005HwpSummaryInformation');
    if (s) meta = parseSummary(s);
  } catch {
    meta = {};
  }
  return { meta, sections };
}

/** 테스트/디버그용: PrvText 미리보기 문자열 */
export function readHwp5Preview(bytes: Uint8Array): string {
  const cfb = CFB.read(bytes, { type: 'array' });
  const i = cfb.FullPaths.findIndex((p) => p.endsWith('/PrvText'));
  if (i < 0) return '';
  return utf16(toU8(cfb.FileIndex[i].content)).replace(/\0+$/, '');
}
