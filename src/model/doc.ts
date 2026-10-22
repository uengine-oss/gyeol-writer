// 결(Gyeol) 문서 모델 — 파일 형식과 무관한 중간 표현.
// 길이 단위는 HWPUNIT(1/7200 inch)을 그대로 쓴다. 1mm ≈ 283.465 HWPUNIT, 1pt = 100 HWPUNIT.

export type Align = 'left' | 'right' | 'center' | 'justify' | 'distribute';

export interface CharProps {
  fontHangul?: string;
  fontLatin?: string;
  /** 글자 크기, 1/100 pt (10pt = 1000) */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** #RRGGBB */
  color?: string;
  /** 형광펜(음영) #RRGGBB */
  highlight?: string;
  superscript?: boolean;
  subscript?: boolean;
  /** 장평 % */
  ratio?: number;
  /** 자간 % */
  spacing?: number;
}

export interface ParaProps {
  align?: Align;
  /** 첫 줄 들여쓰기(+)/내어쓰기(-), HWPUNIT */
  indent?: number;
  marginLeft?: number;
  marginRight?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  /** 줄 간격 % (PERCENT 형식). 기본 160 */
  lineSpacing?: number;
}

export interface TextRun {
  type: 'text';
  text: string;
  char: CharProps;
}

export interface ImageRun {
  type: 'image';
  /** 원본 바이너리 */
  data: Uint8Array;
  /** 'png' | 'jpg' | 'gif' | 'bmp' ... */
  ext: string;
  /** HWPUNIT */
  width: number;
  height: number;
}

export interface TabRun {
  type: 'tab';
}

export interface LineBreakRun {
  type: 'linebreak';
}

export type Run = TextRun | ImageRun | TabRun | LineBreakRun;

export interface Paragraph {
  type: 'paragraph';
  /** 스타일 이름(예: '바탕글', '개요 1') */
  style?: string;
  para: ParaProps;
  runs: Run[];
  /** 이 문단 앞에서 쪽 나눔 */
  pageBreak?: boolean;
  /** 문단 끝(빈 문단 포함)의 글자 모양 — 빈 문단의 줄 높이를 정한다 */
  markChar?: CharProps;
}

/** 칸 안쪽 여백(HWPUNIT) */
export interface Margin {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const DEFAULT_CELL_MARGIN: Margin = { left: 510, right: 510, top: 141, bottom: 141 };

export interface Cell {
  /** 칸 고유 안쪽 여백(없으면 표의 안쪽 여백) */
  margin?: Margin;
  colSpan: number;
  rowSpan: number;
  /** HWPUNIT */
  width?: number;
  height?: number;
  background?: string;
  vertAlign?: 'top' | 'center' | 'bottom';
  blocks: Block[];
}

export interface Row {
  cells: Cell[];
}

export interface Table {
  type: 'table';
  rows: Row[];
  /** 선 표시 여부 (MVP: 모든 칸 실선/없음) */
  borders: boolean;
  /** 모든 칸의 기본 안쪽 여백 */
  inMargin?: Margin;
  /** 표 바깥 여백 */
  outMargin?: Margin;
  /** 표를 담은 줄의 줄 간격(%)과 글자 크기(1/100pt) — 표 아래 간격 = (줄 간격-100)% × 글자 크기 */
  hostLine?: { lineSpacing: number; size: number };
  /** 표를 담은 문단 앞에서 쪽 나눔 */
  pageBreak?: boolean;
}

export type Block = Paragraph | Table;

export interface PageSetup {
  width: number;
  height: number;
  landscape: boolean;
  margin: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    header: number;
    footer: number;
    gutter: number;
  };
}

export interface Section {
  page: PageSetup;
  blocks: Block[];
}

export interface DocMeta {
  title?: string;
  creator?: string;
  createdAt?: string;
  modifiedAt?: string;
}

export interface GDocument {
  meta: DocMeta;
  sections: Section[];
}

export const MM = 7200 / 25.4;

export const A4: PageSetup = {
  width: 59528,
  height: 84186,
  landscape: false,
  margin: { left: 8504, right: 8504, top: 5668, bottom: 4252, header: 4252, footer: 4252, gutter: 0 },
};

export const DEFAULT_CHAR: Required<Pick<CharProps, 'fontHangul' | 'fontLatin' | 'size' | 'color'>> = {
  fontHangul: '맑은 고딕',
  fontLatin: '맑은 고딕',
  size: 1000,
  color: '#000000',
};

export function emptyParagraph(): Paragraph {
  return { type: 'paragraph', para: {}, runs: [] };
}

export function newDocument(): GDocument {
  return {
    meta: { title: '' },
    sections: [{ page: structuredClone(A4), blocks: [emptyParagraph()] }],
  };
}

/** 문서의 순수 텍스트(미리보기·검색용) */
export function plainText(doc: GDocument): string {
  const out: string[] = [];
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.type === 'paragraph') {
        out.push(
          b.runs
            .map((r) => (r.type === 'text' ? r.text : r.type === 'tab' ? '\t' : r.type === 'linebreak' ? '\n' : ''))
            .join(''),
        );
      } else {
        for (const row of b.rows) for (const c of row.cells) walk(c.blocks);
      }
    }
  };
  for (const s of doc.sections) walk(s.blocks);
  return out.join('\n');
}
