// HWPX(OWPML) 쓰기 — 공개 표준 구조로 직접 생성한다.
import JSZip from 'jszip';
import type { Block, CharProps, GDocument, Paragraph, ParaProps, Section, Table } from '../../model/doc';
import { DEFAULT_CELL_MARGIN, DEFAULT_CHAR, plainText, type Margin } from '../../model/doc';
import { esc } from './xml';

const NS =
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" ' +
  'xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ' +
  'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" ' +
  'xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" ' +
  'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" ' +
  'xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" ' +
  'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'] as const;
const LANG_ATTR = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
const ALIGN: Record<string, string> = { left: 'LEFT', right: 'RIGHT', center: 'CENTER', justify: 'JUSTIFY', distribute: 'DISTRIBUTE' };

/** 같은 값은 같은 id 를 주는 참조 테이블 */
class Table_<T> {
  items: T[] = [];
  private keys = new Map<string, number>();
  constructor(private start = 0) {}
  id(v: T): number {
    const k = JSON.stringify(v);
    let i = this.keys.get(k);
    if (i === undefined) {
      i = this.items.length + this.start;
      this.items.push(v);
      this.keys.set(k, i);
    }
    return i;
  }
}

interface BF {
  border: boolean;
  bg?: string;
}

class Builder {
  fonts = new Table_<string>();
  chars = new Table_<Required<Pick<CharProps, 'fontHangul' | 'fontLatin' | 'size' | 'color'>> & CharProps>();
  paras = new Table_<ParaProps>();
  // id 1: 쪽 테두리용(없음), id 2: 글자용(없음) — 나머지는 표 칸
  borders = new Table_<BF>(1);
  styles = new Table_<string>();
  bins: { id: string; path: string; ext: string; data: Uint8Array }[] = [];
  private pid = 0;

  constructor() {
    this.borders.id({ border: false });
    this.borders.id({ border: false, bg: 'char' });
    this.styles.id('바탕글');
    this.char({});
    this.para({});
  }

  char(c: CharProps): number {
    const full = { ...DEFAULT_CHAR, ...c };
    this.fonts.id(full.fontHangul);
    this.fonts.id(full.fontLatin);
    // undefined 키 제거로 dedupe 안정화
    return this.chars.id(JSON.parse(JSON.stringify(full)));
  }

  para(p: ParaProps): number {
    return this.paras.id(JSON.parse(JSON.stringify({ align: 'justify', lineSpacing: 160, ...p })));
  }

  nextId(): number {
    // 문단 id 는 고유하면 충분하다
    return ++this.pid;
  }

  // ---- body ----
  section(sec: Section, first: boolean): string {
    const parts: string[] = [];
    let isFirst = first;
    const blocks = sec.blocks.length ? sec.blocks : [{ type: 'paragraph', para: {}, runs: [] } as Paragraph];
    blocks.forEach((b) => {
      parts.push(this.block(b, isFirst ? sec : undefined));
      isFirst = false;
    });
    return `${XML}<hs:sec ${NS}>${parts.join('')}</hs:sec>`;
  }

  block(b: Block, secHead?: Section): string {
    if (b.type === 'paragraph') return this.paragraph(b, secHead);
    // 표는 문단 안의 개체로 들어간다 — 원래 담고 있던 줄의 줄 간격·글자 크기를 되살린다
    const hl = b.hostLine;
    const host: Paragraph = {
      type: 'paragraph',
      para: hl ? { lineSpacing: hl.lineSpacing } : {},
      runs: [],
      ...(hl ? { markChar: { size: hl.size } } : {}),
      ...(b.pageBreak ? { pageBreak: true } : {}),
    };
    return this.paragraph(host, secHead, this.table(b), hl ? this.char({ size: hl.size }) : 0);
  }

  paragraph(p: Paragraph, secHead?: Section, object?: string, objectChar = 0): string {
    const styleId = this.styles.id(p.style || '바탕글');
    const paraId = this.para(p.para);
    const runs: string[] = [];
    if (secHead) runs.push(`<hp:run charPrIDRef="0">${this.secPr(secHead)}<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>`);
    if (object) runs.push(`<hp:run charPrIDRef="${objectChar}">${object}<hp:t/></hp:run>`);

    // 같은 글자 모양끼리 하나의 run 으로 묶는다
    let curChar = -1;
    let buf = '';
    const flush = () => {
      if (curChar >= 0) runs.push(`<hp:run charPrIDRef="${curChar}"><hp:t>${buf}</hp:t></hp:run>`);
      buf = '';
    };
    for (const r of p.runs) {
      if (r.type === 'image') {
        flush();
        curChar = -1;
        runs.push(`<hp:run charPrIDRef="0">${this.picture(r.data, r.ext, r.width, r.height)}<hp:t/></hp:run>`);
        continue;
      }
      const cid = r.type === 'text' ? this.char(r.char) : curChar >= 0 ? curChar : 0;
      if (cid !== curChar) {
        flush();
        curChar = cid;
      }
      if (r.type === 'text') buf += esc(r.text);
      else if (r.type === 'tab') buf += '<hp:tab width="4000" leader="0" type="1"/>';
      else buf += '<hp:lineBreak/>';
    }
    flush();
    if (!object && !p.runs.length) runs.push(`<hp:run charPrIDRef="${p.markChar ? this.char(p.markChar) : 0}"><hp:t/></hp:run>`);
    return `<hp:p id="${this.nextId()}" paraPrIDRef="${paraId}" styleIDRef="${styleId}" pageBreak="${p.pageBreak ? 1 : 0}" columnBreak="0" merged="0">${runs.join('')}</hp:p>`;
  }

  secPr(s: Section): string {
    const m = s.page.margin;
    return (
      `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">` +
      `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>` +
      `<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>` +
      `<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>` +
      `<hp:pagePr landscape="${s.page.landscape ? 'NARROWLY' : 'WIDELY'}" width="${s.page.width}" height="${s.page.height}" gutterType="LEFT_ONLY">` +
      `<hp:margin header="${m.header}" footer="${m.footer}" gutter="${m.gutter}" left="${m.left}" right="${m.right}" top="${m.top}" bottom="${m.bottom}"/></hp:pagePr>` +
      `<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>` +
      `<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>` +
      ['BOTH', 'EVEN', 'ODD']
        .map(
          (t) =>
            `<hp:pageBorderFill type="${t}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`,
        )
        .join('') +
      `</hp:secPr>`
    );
  }

  table(t: Table): string {
    // 병합을 고려해 격자 좌표와 열 수를 계산
    const occupied: boolean[][] = [];
    const placed: { r: number; c: number; cell: Table['rows'][number]['cells'][number] }[] = [];
    let colCnt = 0;
    t.rows.forEach((row, r) => {
      occupied[r] ??= [];
      let c = 0;
      for (const cell of row.cells) {
        while (occupied[r][c]) c++;
        placed.push({ r, c, cell });
        for (let dr = 0; dr < cell.rowSpan; dr++)
          for (let dc = 0; dc < cell.colSpan; dc++) {
            occupied[r + dr] ??= [];
            occupied[r + dr][c + dc] = true;
          }
        c += cell.colSpan;
        colCnt = Math.max(colCnt, c);
      }
    });
    const rowCnt = t.rows.length;
    const defaultW = Math.round(42520 / Math.max(colCnt, 1));
    let totalW = 0;
    for (const p of placed) if (p.r === 0) totalW += p.cell.width ?? defaultW * p.cell.colSpan;
    let totalH = 0;
    t.rows.forEach((row) => (totalH += Math.max(...row.cells.map((c) => (c.rowSpan === 1 ? (c.height ?? 1000) : 1000)), 1000)));

    const tableBf = this.borders.id({ border: t.borders });
    const inM = t.inMargin ?? DEFAULT_CELL_MARGIN;
    const rowsXml = t.rows.map((_, r) => {
      const cells = placed
        .filter((p) => p.r === r)
        .map(({ c, cell }) => {
          const bf = this.borders.id({ border: t.borders, ...(cell.background ? { bg: cell.background } : {}) });
          const w = cell.width ?? defaultW * cell.colSpan;
          const h = cell.height ?? 1000;
          const va = (cell.vertAlign ?? 'center').toUpperCase();
          const inner = (cell.blocks.length ? cell.blocks : [{ type: 'paragraph', para: {}, runs: [] } as Paragraph])
            .map((b) => this.block(b))
            .join('');
          return (
            `<hp:tc name="" header="0" hasMargin="${cell.margin ? 1 : 0}" protect="0" editable="0" dirty="0" borderFillIDRef="${bf}">` +
            `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${va}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${inner}</hp:subList>` +
            `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="${cell.colSpan}" rowSpan="${cell.rowSpan}"/>` +
            `<hp:cellSz width="${w}" height="${h}"/>${marginXml('cellMargin', cell.margin ?? inM)}</hp:tc>`
          );
        })
        .join('');
      return `<hp:tr>${cells}</hp:tr>`;
    });
    return (
      `<hp:tbl id="${1000000000 + this.nextId()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="${tableBf}" noAdjust="0">` +
      `<hp:sz width="${totalW}" widthRelTo="ABSOLUTE" height="${totalH}" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      `${marginXml('outMargin', t.outMargin ?? { left: 283, right: 283, top: 283, bottom: 283 })}${marginXml('inMargin', inM)}` +
      rowsXml.join('') +
      `</hp:tbl>`
    );
  }

  picture(data: Uint8Array, ext: string, w: number, h: number): string {
    const id = `image${this.bins.length + 1}`;
    const e = ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase();
    this.bins.push({ id, path: `BinData/${id}.${e}`, ext: e, data });
    const cx = Math.round(w / 2);
    const cy = Math.round(h / 2);
    return (
      `<hp:pic id="${1100000000 + this.nextId()}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${this.nextId()}" reverse="0">` +
      `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="0" vertical="0"/>` +
      `<hp:rotationInfo angle="0" centerX="${cx}" centerY="${cy}" rotateimage="1"/>` +
      `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>` +
      `<hc:img binaryItemIDRef="${id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
      `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>` +
      `<hp:imgClip left="0" right="${w}" top="0" bottom="${h}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${w}" dimheight="${h}"/><hp:effects/>` +
      `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      `<hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic>`
    );
  }

  // ---- header ----
  header(secCnt: number): string {
    const fonts = this.fonts.items;
    const fontfaces = LANGS.map(
      (lang) =>
        `<hh:fontface lang="${lang}" fontCnt="${fonts.length}">` +
        fonts.map((f, i) => `<hh:font id="${i}" face="${esc(f)}" type="TTF" isEmbedded="0"/>`).join('') +
        `</hh:fontface>`,
    ).join('');

    const side = (name: string, on: boolean) => `<hh:${name} type="${on ? 'SOLID' : 'NONE'}" width="0.12 mm" color="#000000"/>`;
    const borderFills = this.borders.items
      .map((b, i) => {
        const fill = b.bg && b.bg !== 'char' ? `<hc:fillBrush><hc:winBrush faceColor="${b.bg}" hatchColor="#999999" alpha="0"/></hc:fillBrush>` : '';
        return (
          `<hh:borderFill id="${i + 1}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
          `<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>` +
          side('leftBorder', b.border) + side('rightBorder', b.border) + side('topBorder', b.border) + side('bottomBorder', b.border) +
          `<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>${fill}</hh:borderFill>`
        );
      })
      .join('');

    const charPrs = this.chars.items
      .map((c, i) => {
        const fh = fonts.indexOf(c.fontHangul);
        const fl = fonts.indexOf(c.fontLatin);
        const refs = LANG_ATTR.map((l) => `${l}="${l === 'latin' ? fl : fh}"`).join(' ');
        const all7 = (v: number) => LANG_ATTR.map((l) => `${l}="${v}"`).join(' ');
        return (
          `<hh:charPr id="${i}" height="${c.size}" textColor="${c.color}" shadeColor="${c.highlight ?? 'none'}" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">` +
          `<hh:fontRef ${refs}/><hh:ratio ${all7(c.ratio ?? 100)}/><hh:spacing ${all7(c.spacing ?? 0)}/><hh:relSz ${all7(100)}/><hh:offset ${all7(0)}/>` +
          (c.bold ? '<hh:bold/>' : '') +
          (c.italic ? '<hh:italic/>' : '') +
          `<hh:underline type="${c.underline ? 'BOTTOM' : 'NONE'}" shape="SOLID" color="${c.color}"/>` +
          `<hh:strikeout shape="${c.strike ? 'SOLID' : 'NONE'}" color="${c.color}"/>` +
          `<hh:outline type="NONE"/><hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/>` +
          (c.superscript ? '<hh:supscript/>' : '') +
          (c.subscript ? '<hh:subscript/>' : '') +
          `</hh:charPr>`
        );
      })
      .join('');

    const margin = (p: ParaProps, k: number) =>
      `<hh:margin><hc:intent value="${(p.indent ?? 0) * k}" unit="HWPUNIT"/><hc:left value="${(p.marginLeft ?? 0) * k}" unit="HWPUNIT"/>` +
      `<hc:right value="${(p.marginRight ?? 0) * k}" unit="HWPUNIT"/><hc:prev value="${(p.spaceBefore ?? 0) * k}" unit="HWPUNIT"/>` +
      `<hc:next value="${(p.spaceAfter ?? 0) * k}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="${p.lineSpacing ?? 160}" unit="HWPUNIT"/>`;
    const paraPrs = this.paras.items
      .map(
        (p, i) =>
          `<hh:paraPr id="${i}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">` +
          `<hh:align horizontal="${ALIGN[p.align ?? 'justify']}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>` +
          `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>` +
          `<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>` +
          // case: HWPUNIT 그대로, default: 하위 호환용 2배 값(실제 한글 저장본과 같은 규칙)
          `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${margin(p, 1)}</hp:case><hp:default>${margin(p, 2)}</hp:default></hp:switch>` +
          `<hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`,
      )
      .join('');

    const styles = this.styles.items
      .map(
        (name, i) =>
          `<hh:style id="${i}" type="PARA" name="${esc(name)}" engName="${i === 0 ? 'Normal' : ''}" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="${i}" langID="1042" lockForm="0"/>`,
      )
      .join('');

    return (
      `${XML}<hh:head ${NS} version="1.5" secCnt="${secCnt}">` +
      `<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>` +
      `<hh:fontfaces itemCnt="${LANGS.length}">${fontfaces}</hh:fontfaces>` +
      `<hh:borderFills itemCnt="${this.borders.items.length}">${borderFills}</hh:borderFills>` +
      `<hh:charProperties itemCnt="${this.chars.items.length}">${charPrs}</hh:charProperties>` +
      `<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>` +
      `<hh:paraProperties itemCnt="${this.paras.items.length}">${paraPrs}</hh:paraProperties>` +
      `<hh:styles itemCnt="${this.styles.items.length}">${styles}</hh:styles>` +
      `</hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>` +
      `<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>`
    );
  }
}

function marginXml(tag: string, m: Margin): string {
  return `<hp:${tag} left="${m.left}" right="${m.right}" top="${m.top}" bottom="${m.bottom}"/>`;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' };

export async function writeHwpx(doc: GDocument): Promise<Uint8Array> {
  const b = new Builder();
  const sections = doc.sections.map((s) => b.section(s, true));
  const header = b.header(sections.length);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const zip = new JSZip();
  // mimetype 은 첫 항목, 무압축이어야 한다(OCF 규칙)
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
  zip.file(
    'version.xml',
    `${XML}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="10" xmlVersion="1.5" application="Gyeol Writer" appVersion="0.1.0"/>`,
  );
  zip.file('Contents/header.xml', header);
  sections.forEach((s, i) => zip.file(`Contents/section${i}.xml`, s));
  // 이미 압축된 그림(png/jpg/gif/webp)은 다시 압축하지 않는다
  for (const bin of b.bins) zip.file(bin.path, bin.data, /^(png|jpg|gif|webp)$/.test(bin.ext) ? { compression: 'STORE' } : {});
  zip.file('Preview/PrvText.txt', plainText(doc).slice(0, 1024));
  zip.file(
    'settings.xml',
    `${XML}<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`,
  );
  const rdfParts = ['Contents/header.xml', ...sections.map((_, i) => `Contents/section${i}.xml`)]
    .map(
      (p, i) =>
        `<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="${p}"/></rdf:Description>` +
        `<rdf:Description rdf:about="${p}"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#${i === 0 ? 'HeaderFile' : 'SectionFile'}"/></rdf:Description>`,
    )
    .join('');
  zip.file(
    'META-INF/container.rdf',
    `${XML}<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${rdfParts}<rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description></rdf:RDF>`,
  );
  zip.file(
    'Contents/content.hpf',
    `${XML}<opf:package ${NS} version="" unique-identifier="" id=""><opf:metadata><opf:title>${esc(doc.meta.title ?? '')}</opf:title><opf:language>ko</opf:language>` +
      `<opf:meta name="creator" content="text">${esc(doc.meta.creator ?? '')}</opf:meta><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/>` +
      `<opf:meta name="lastsaveby" content="text">Gyeol Writer</opf:meta><opf:meta name="CreatedDate" content="text">${doc.meta.createdAt ?? now}</opf:meta>` +
      `<opf:meta name="ModifiedDate" content="text">${now}</opf:meta><opf:meta name="keyword" content="text"/></opf:metadata><opf:manifest>` +
      `<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>` +
      sections.map((_, i) => `<opf:item id="section${i}" href="Contents/section${i}.xml" media-type="application/xml"/>`).join('') +
      b.bins.map((x) => `<opf:item id="${x.id}" href="${x.path}" media-type="${MIME[x.ext] ?? 'application/octet-stream'}" isEmbeded="1"/>`).join('') +
      `<opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine>` +
      `<opf:itemref idref="header" linear="yes"/>` +
      sections.map((_, i) => `<opf:itemref idref="section${i}" linear="yes"/>`).join('') +
      `</opf:spine></opf:package>`,
  );
  zip.file(
    'META-INF/container.xml',
    `${XML}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/><ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></ocf:rootfiles></ocf:container>`,
  );
  zip.file('META-INF/manifest.xml', `${XML}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`);

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/hwp+zip' });
}
