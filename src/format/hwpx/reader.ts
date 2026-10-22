// HWPX(OWPML, KS X 6101) 읽기 — 공개 표준 구조를 기준으로 작성.
import JSZip from 'jszip';
import type {
  Align,
  Block,
  Cell,
  CharProps,
  Margin,
  GDocument,
  PageSetup,
  Paragraph,
  ParaProps,
  Row,
  Run,
  Section,
  Table,
} from '../../model/doc';
import { A4 } from '../../model/doc';
import { all, attr, first, kid, kids, num, parseXml, type XEl } from './xml';

interface BorderFill {
  visible: boolean;
  background?: string;
}

interface Header {
  fonts: Record<string, Record<string, string>>; // lang → id → face
  charPr: Map<string, CharProps>;
  paraPr: Map<string, ParaProps>;
  borderFill: Map<string, BorderFill>;
  styles: Map<string, string>;
}

interface Ctx {
  header: Header;
  bin: Map<string, { data: Uint8Array; ext: string }>;
}

const ALIGN: Record<string, Align> = {
  LEFT: 'left',
  RIGHT: 'right',
  CENTER: 'center',
  JUSTIFY: 'justify',
  DISTRIBUTE: 'distribute',
  DISTRIBUTE_SPACE: 'distribute',
};

function color(v: string | undefined): string | undefined {
  if (!v || v === 'none') return undefined;
  return v.length === 7 ? v.toUpperCase() : undefined;
}

function readHeader(doc: Document): Header {
  const h: Header = { fonts: {}, charPr: new Map(), paraPr: new Map(), borderFill: new Map(), styles: new Map() };

  for (const ff of all(doc, 'fontface')) {
    const lang = attr(ff, 'lang') ?? 'HANGUL';
    const m: Record<string, string> = {};
    for (const f of kids(ff, 'font')) m[attr(f, 'id') ?? '0'] = attr(f, 'face') ?? '';
    h.fonts[lang] = m;
  }

  for (const bf of all(doc, 'borderFill')) {
    const sides = ['leftBorder', 'rightBorder', 'topBorder', 'bottomBorder'].map((s) => kid(bf, s));
    const visible = sides.some((s) => s && attr(s, 'type') && attr(s, 'type') !== 'NONE');
    const brush = first(bf, 'winBrush');
    h.borderFill.set(attr(bf, 'id') ?? '', { visible, background: color(attr(brush, 'faceColor')) });
  }

  for (const cp of all(doc, 'charPr')) {
    const fr = kid(cp, 'fontRef');
    const c: CharProps = {
      size: num(cp, 'height', 1000),
      color: color(attr(cp, 'textColor')) ?? '#000000',
      fontHangul: h.fonts.HANGUL?.[attr(fr, 'hangul') ?? '0'],
      fontLatin: h.fonts.LATIN?.[attr(fr, 'latin') ?? '0'],
    };
    const shade = color(attr(cp, 'shadeColor'));
    if (shade && shade !== '#FFFFFF') c.highlight = shade;
    if (kid(cp, 'bold')) c.bold = true;
    if (kid(cp, 'italic')) c.italic = true;
    const ul = kid(cp, 'underline');
    if (ul && attr(ul, 'type') && attr(ul, 'type') !== 'NONE') c.underline = true;
    // HWP 에서 변환된 문서는 취소선 없음을 shape="3D" 로 저장하는 경우가 많다(실물 문서 740건 확인)
    const so = kid(cp, 'strikeout');
    const soShape = attr(so, 'shape');
    if (soShape && soShape !== 'NONE' && soShape !== '3D') c.strike = true;
    if (kid(cp, 'supscript')) c.superscript = true;
    if (kid(cp, 'subscript')) c.subscript = true;
    const ratio = num(kid(cp, 'ratio'), 'hangul', 100);
    if (ratio !== 100) c.ratio = ratio;
    const sp = num(kid(cp, 'spacing'), 'hangul', 0);
    if (sp !== 0) c.spacing = sp;
    h.charPr.set(attr(cp, 'id') ?? '', c);
  }

  for (const pp of all(doc, 'paraPr')) {
    const p: ParaProps = { align: ALIGN[attr(kid(pp, 'align'), 'horizontal') ?? 'JUSTIFY'] ?? 'justify' };
    // hp:switch 의 HwpUnitChar case 값을 우선한다(default 는 하위 호환용으로 값이 다르게 저장됨).
    const sw = kid(pp, 'switch');
    const holder = (sw && (kid(sw, 'case') ?? kid(sw, 'default'))) ?? pp;
    const margin = kid(holder, 'margin');
    if (margin) {
      p.indent = num(kid(margin, 'intent'), 'value');
      p.marginLeft = num(kid(margin, 'left'), 'value');
      p.marginRight = num(kid(margin, 'right'), 'value');
      p.spaceBefore = num(kid(margin, 'prev'), 'value');
      p.spaceAfter = num(kid(margin, 'next'), 'value');
    }
    const ls = kid(holder, 'lineSpacing');
    if (ls && (attr(ls, 'type') ?? 'PERCENT') === 'PERCENT') p.lineSpacing = num(ls, 'value', 160);
    h.paraPr.set(attr(pp, 'id') ?? '', p);
  }

  for (const st of all(doc, 'style')) h.styles.set(attr(st, 'id') ?? '', attr(st, 'name') ?? '');
  return h;
}

function readPage(secPr: XEl): PageSetup {
  const pp = kid(secPr, 'pagePr');
  const m = kid(pp, 'margin');
  const page: PageSetup = structuredClone(A4);
  if (!pp) return page;
  page.width = num(pp, 'width', A4.width);
  page.height = num(pp, 'height', A4.height);
  // OWPML: landscape="WIDELY" 가 세로(기본), "NARROWLY" 가 가로
  page.landscape = attr(pp, 'landscape') === 'NARROWLY';
  if (m) {
    for (const k of Object.keys(page.margin) as (keyof PageSetup['margin'])[]) {
      page.margin[k] = num(m, k, page.margin[k]);
    }
  }
  return page;
}

function textRuns(t: XEl, char: CharProps, out: Run[]) {
  for (let n = t.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 || n.nodeType === 4) {
      const text = n.nodeValue ?? '';
      if (text) out.push({ type: 'text', text, char });
    } else if (n.nodeType === 1) {
      const name = (n as XEl).localName;
      if (name === 'tab') out.push({ type: 'tab' });
      else if (name === 'lineBreak') out.push({ type: 'linebreak' });
      else if (name === 'fwSpace' || name === 'nbSpace') out.push({ type: 'text', text: ' ', char });
      else if (name === 'hyphen') out.push({ type: 'text', text: '-', char });
    }
  }
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (r.type === 'text' && last?.type === 'text' && last.char === r.char) last.text += r.text;
    else out.push(r.type === 'text' ? { ...r } : r);
  }
  return out;
}

function readTable(tbl: XEl, ctx: Ctx): Table {
  const rows: Row[] = [];
  let borders = false;
  for (const tr of kids(tbl, 'tr')) {
    const cells: Cell[] = [];
    for (const tc of kids(tr, 'tc')) {
      const span = kid(tc, 'cellSpan');
      const sz = kid(tc, 'cellSz');
      const bf = ctx.header.borderFill.get(attr(tc, 'borderFillIDRef') ?? '');
      if (bf?.visible) borders = true;
      const sub = kid(tc, 'subList');
      const va = attr(sub, 'vertAlign');
      const cm = kid(tc, 'cellMargin');
      cells.push({
        ...(attr(tc, 'hasMargin') === '1' && cm ? { margin: margin(cm) } : {}),
        colSpan: num(span, 'colSpan', 1),
        rowSpan: num(span, 'rowSpan', 1),
        width: num(sz, 'width') || undefined,
        height: num(sz, 'height') || undefined,
        background: bf?.background,
        vertAlign: va === 'CENTER' ? 'center' : va === 'BOTTOM' ? 'bottom' : 'top',
        blocks: readParagraphs(kids(sub, 'p'), ctx).blocks,
      });
    }
    rows.push({ cells });
  }
  const im = kid(tbl, 'inMargin');
  return { type: 'table', rows, borders, ...(im ? { inMargin: margin(im) } : {}) };
}

function margin(el: XEl): Margin {
  return { left: num(el, 'left'), right: num(el, 'right'), top: num(el, 'top'), bottom: num(el, 'bottom') };
}

function readParagraphs(ps: XEl[], ctx: Ctx): { blocks: Block[]; page?: PageSetup } {
  const blocks: Block[] = [];
  let page: PageSetup | undefined;
  for (const p of ps) {
    const para = ctx.header.paraPr.get(attr(p, 'paraPrIDRef') ?? '') ?? {};
    const style = ctx.header.styles.get(attr(p, 'styleIDRef') ?? '');
    let cur: Paragraph = {
      type: 'paragraph',
      para,
      runs: [],
      ...(style && style !== '바탕글' ? { style } : {}),
      ...(attr(p, 'pageBreak') === '1' ? { pageBreak: true } : {}),
    };
    // 문단 끝 글자 모양 = 마지막 run 의 글자 모양
    const runEls = kids(p, 'run');
    const lastChar = runEls.length ? ctx.header.charPr.get(attr(runEls[runEls.length - 1], 'charPrIDRef') ?? '') : undefined;
    if (lastChar && Object.keys(lastChar).length) cur.markChar = lastChar;
    let hasObject = false;
    const startLen = blocks.length;
    let emitted = false;
    const flush = (force: boolean) => {
      cur.runs = mergeRuns(cur.runs);
      // 개체(표) 옆의 공백뿐인 글자는 한글에서 같은 줄에 있으므로 따로 문단을 만들지 않는다
      const blank = cur.runs.every((r) => r.type === 'text' && !r.text.trim());
      if (force || (cur.runs.length && !(hasObject && blank))) blocks.push(cur);
      emitted = blocks.length > startLen;
      cur = { type: 'paragraph', para, runs: [], ...(style && style !== '바탕글' ? { style } : {}) };
    };
    for (const run of kids(p, 'run')) {
      const char = ctx.header.charPr.get(attr(run, 'charPrIDRef') ?? '') ?? {};
      for (const c of kids(run)) {
        switch (c.localName) {
          case 'secPr':
            page = readPage(c);
            break;
          case 't':
            textRuns(c, char, cur.runs);
            break;
          case 'tbl': {
            hasObject = true; // 표 앞 공백뿐인 글자도 같은 줄이므로 따로 문단을 만들지 않는다
            if (cur.runs.length) flush(false);
            const t = readTable(c, ctx);
            const om = kid(c, 'outMargin');
            if (om) t.outMargin = margin(om);
            const size = Math.max(...runEls.map((r) => ctx.header.charPr.get(attr(r, 'charPrIDRef') ?? '')?.size ?? 1000));
            t.hostLine = { lineSpacing: para.lineSpacing ?? 160, size };
            // 문단의 쪽 나눔은 그 문단에서 나온 첫 블록이 이어받는다
            if (attr(p, 'pageBreak') === '1' && !emitted) t.pageBreak = true;
            blocks.push(t);
            emitted = true;
            break;
          }
          case 'pic': {
            const img = first(c, 'img');
            const bin = ctx.bin.get(attr(img, 'binaryItemIDRef') ?? '');
            const sz = kid(c, 'curSz') ?? kid(c, 'sz');
            if (bin) cur.runs.push({ type: 'image', data: bin.data, ext: bin.ext, width: num(sz, 'width', 14173), height: num(sz, 'height', 14173) });
            break;
          }
          case 'rect':
          case 'ellipse':
          case 'polygon':
          case 'container': {
            // 글상자: 안쪽 문단을 본문 흐름으로 펼친다(MVP)
            const dt = first(c, 'drawText');
            const sub = dt && kid(dt, 'subList');
            if (sub) {
              hasObject = true;
              if (cur.runs.length) flush(false);
              blocks.push(...readParagraphs(kids(sub, 'p'), ctx).blocks);
            }
            break;
          }
          default:
            break; // ctrl(머리말/꼬리말/각주 등)·equation 은 MVP 에서 건너뜀
        }
      }
    }
    flush(!hasObject);
  }
  return { blocks, page };
}

export async function readHwpx(bytes: Uint8Array | ArrayBuffer): Promise<GDocument> {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (path: string) => {
    const f = zip.file(path);
    if (!f) throw new Error(`HWPX 구성 파일이 없습니다: ${path}`);
    return f.async('string');
  };

  const mime = zip.file('mimetype');
  if (mime && !(await mime.async('string')).includes('hwp')) throw new Error('HWPX 문서가 아닙니다.');

  const hpfPath = 'Contents/content.hpf';
  const hpf = parseXml(await read(hpfPath));
  const items = new Map<string, { href: string; type: string }>();
  for (const it of all(hpf, 'item')) items.set(attr(it, 'id') ?? '', { href: attr(it, 'href') ?? '', type: attr(it, 'media-type') ?? '' });

  const header = readHeader(parseXml(await read('Contents/header.xml')));

  const bin = new Map<string, { data: Uint8Array; ext: string }>();
  for (const [id, it] of items) {
    if (!it.href.startsWith('BinData/')) continue;
    const f = zip.file(it.href);
    if (f) bin.set(id, { data: await f.async('uint8array'), ext: (it.href.split('.').pop() ?? 'png').toLowerCase() });
  }

  const spine = all(hpf, 'itemref').map((r) => items.get(attr(r, 'idref') ?? '')?.href ?? '');
  let sectionPaths = spine.filter((h) => /section\d+\.xml$/.test(h));
  if (!sectionPaths.length) sectionPaths = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/.test(n)).sort();

  const meta: GDocument['meta'] = {};
  const metaVal = (name: string) => all(hpf, 'meta').find((m) => attr(m, 'name') === name)?.textContent ?? undefined;
  meta.title = first(hpf, 'title')?.textContent ?? undefined;
  meta.creator = metaVal('creator');
  meta.createdAt = metaVal('CreatedDate');
  meta.modifiedAt = metaVal('ModifiedDate');

  const ctx: Ctx = { header, bin };
  const sections: Section[] = [];
  for (const path of sectionPaths) {
    const sec = parseXml(await read(path));
    const root = sec.documentElement as unknown as XEl;
    const { blocks, page } = readParagraphs(kids(root, 'p'), ctx);
    sections.push({ page: page ?? structuredClone(A4), blocks: blocks.length ? blocks : [{ type: 'paragraph', para: {}, runs: [] }] });
  }
  return { meta, sections };
}
