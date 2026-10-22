import { baseKeymap, chainCommands, deleteSelection, joinBackward, selectNodeBackward, splitBlockAs } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { EditorState, type Command, type Transaction } from 'prosemirror-state';
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  columnResizing,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  mergeCells,
  splitCell,
  tableEditing,
  TableView,
} from 'prosemirror-tables';
import { EditorView } from 'prosemirror-view';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';

import type { GyeolApi, OpenedFile } from '../../preload/index';
import { A4, DEFAULT_CELL_MARGIN, newDocument, type CharProps, type GDocument, type PageSetup } from '../../model/doc';
import { readHwpx } from '../../format/hwpx/reader';
import { writeHwpx } from '../../format/hwpx/writer';
import { readHwp5 } from '../../format/hwp5/reader';
import { schema } from '../../editor/schema';
import { fitVars } from '../../editor/fontfit';
import { charMarks, marksToChar, modelToPM, pmToModel } from '../../editor/convert';
import {
  applyStyle,
  currentSize,
  insertImage,
  insertLineBreak,
  insertTab,
  insertTable,
  insertText,
  pageBreak,
  selectedParagraphs,
  setCellAttr,
  setMark,
  setParaAttrs,
  stepSize,
  STYLES,
  toggle,
  toggleTableBorders,
  wordCount,
} from '../../editor/commands';
import { caretPage, geom, PAGE_GAP, paginationKey, paginationPlugin, repaginate, type PageGeom } from '../../editor/pagination';
import { findKey, findPlugin, findStep, replaceAll, replaceCurrent, setQuery } from '../../editor/find';
import { charShapeDialog, colorPopover, docInfoDialog, pageSetupDialog, paraShapeDialog, symbolDialog, tableDialog } from './dialogs';
import { ICONS, LOGO } from './icons';

declare global {
  interface Window {
    gyeol: GyeolApi;
    queryLocalFonts?: () => Promise<{ family: string }[]>;
    __gyeolIsBlank: () => boolean;
    __gyeolPdfOptions: () => { widthIn: number; heightIn: number; landscape: boolean };
    __gyeolBeforePrint: () => void;
    __gyeolAfterPrint: () => void;
    __gyeol: { view: EditorView; run: (id: string) => Promise<void>; open: (name: string, bytes: Uint8Array) => Promise<void>; serialize: () => Promise<Uint8Array>; report: () => { pages: number; starts: string[]; lines: [string, number][]; tops: [string, number, number][]; rows: number[][]; cell: [string, number][]; gaps: [number, string, string][] } };
  }
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const api = window.gyeol;

// ---------------- 문서 상태 ----------------
let page: PageSetup = structuredClone(A4);
let meta: GDocument['meta'] = {};
let filePath: string | undefined;
let fileName = '빈 문서 1';
let dirty = false;
let zoom = 1;
let pages = 1;
let fonts: string[] = ['맑은 고딕', '함초롬바탕', '함초롬돋움', '바탕', '돋움', '굴림', '궁서', 'Apple SD Gothic Neo', 'AppleMyungjo', 'Nanum Gothic', 'Nanum Myeongjo', 'Noto Sans KR', 'Arial', 'Times New Roman'];
let blank = true;

let g: PageGeom = geom(page);
let printing = false;

function createState(doc: PMNode): EditorState {
  return EditorState.create({ doc, plugins: plugins() });
}

const enterKeepShape = splitBlockAs((node) => ({ type: node.type, attrs: { ...node.attrs, pageBreak: false } }));

function plugins() {
  return [
    history(),
    keymap({
      'Mod-z': undo,
      'Mod-Shift-z': redo,
      'Mod-y': redo,
      'Mod-b': toggle('bold'),
      'Mod-i': toggle('italic'),
      'Mod-u': toggle('underline'),
      'Mod-Enter': pageBreak,
      'Shift-Enter': insertLineBreak,
      Enter: enterKeepShape,
      Tab: chainCommands(goToNextCell(1), insertTab),
      'Shift-Tab': goToNextCell(-1),
      Backspace: chainCommands(deleteSelection, removePageBreakAtStart, joinBackward, selectNodeBackward),
    }),
    keymap(baseKeymap),
    dropCursor({ color: '#2f6feb' }),
    gapCursor(),
    columnResizing({ cellMinWidth: 24, View: BorderedTableView }),
    tableEditing(),
    findPlugin,
    paginationPlugin(() => g, () => (printing ? 0 : PAGE_GAP), (n) => {
      if (n !== pages) {
        pages = n;
        renderSheets();
      }
      renderStatus();
    }),
  ];
}

/** 표 테두리 표시 속성을 반영하는 표 화면(prosemirror-tables 기본 화면은 class 를 무시한다) */
class BorderedTableView extends TableView {
  constructor(node: PMNode, cellMinWidth: number) {
    super(node, cellMinWidth);
    this.mark(node);
  }
  update(node: PMNode): boolean {
    const ok = super.update(node);
    if (ok) this.mark(node);
    return ok;
  }
  private mark(node: PMNode) {
    this.table.className = node.attrs.borders ? 'g-table bordered' : 'g-table';
    // 칸 안쪽 여백(표 기본값)
    const m = node.attrs.inMargin as { left: number; right: number; top: number; bottom: number } | null;
    // 표를 담은 줄: 위 = 바깥 여백, 아래 = 바깥 여백 + (줄 간격-100)% × 글자 크기 (한글 배치 규칙)
    const om = node.attrs.outMargin as { top: number; bottom: number } | null;
    const hl = (node.attrs.hostLine as { lineSpacing: number; size: number } | null) ?? { lineSpacing: 160, size: 1000 };
    const below = Math.max(0, ((hl.lineSpacing - 100) / 100) * hl.size); // HWPUNIT(1/100pt = 1 HU)
    (this.dom as HTMLElement).style.margin = `${(om?.top ?? 283) / 75}px 0 ${((om?.bottom ?? 283) + below) / 75}px`;
    // 바깥 표의 값이 상속되지 않도록 항상 명시한다
    const d = DEFAULT_CELL_MARGIN;
    for (const [k, v] of [['--cpl', m?.left ?? d.left], ['--cpr', m?.right ?? d.right], ['--cpt', m?.top ?? d.top], ['--cpb', m?.bottom ?? d.bottom]] as const)
      this.table.style.setProperty(k, `${v / 75}px`);
  }
}

/** 문단 맨 앞에서 Backspace: 쪽 나눔 표시가 있으면 그것부터 지운다 */
const removePageBreakAtStart: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || !$from.parent.attrs.pageBreak) return false;
  if (dispatch) dispatch(state.tr.setNodeMarkup($from.before(), undefined, { ...$from.parent.attrs, pageBreak: false }));
  return true;
};

const view = new EditorView($('#editor'), {
  // 기본 글꼴(맑은 고딕 → 대체 글꼴)의 빈칸·자간 보정
  attributes: { spellcheck: 'false', lang: 'ko', style: fitVars(getComputedStyle(document.body).fontFamily && '"맑은 고딕","Malgun Gothic","Apple SD Gothic Neo",sans-serif', '맑은 고딕') },
  state: createState(modelToPM(newDocument()).doc),
  dispatchTransaction(tr: Transaction) {
    let next = view.state.apply(tr);
    // 빈 문단에서 입력을 시작하면 문단 끝 글자 모양을 따른다(한글 방식)
    const $c = next.selection.$from;
    if (next.selection.empty && !next.storedMarks && $c.parent.type === schema.nodes.paragraph && !$c.parent.content.size && $c.parent.attrs.markChar) {
      next = next.apply(next.tr.setStoredMarks(charMarks($c.parent.attrs.markChar)));
    }
    view.updateState(next);
    if (tr.docChanged) {
      blank = false;
      setDirty(true);
    }
    syncToolbar();
    renderStatus();
  },
  handlePaste(v, e) {
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (!file) return false;
    insertImageFile(file);
    return true;
  },
  handleDrop(v, e) {
    const files = [...((e as DragEvent).dataTransfer?.files ?? [])];
    const img = files.find((f) => f.type.startsWith('image/'));
    if (img) {
      insertImageFile(img);
      return true;
    }
    return false;
  },
});

// ---------------- 용지(쪽) 그리기 ----------------
function layoutPage() {
  g = geom(page);
  const stack = $('#page-stack');
  stack.style.width = `${g.width}px`;
  stack.style.setProperty('zoom', String(zoom));
  stack.dataset.zoom = String(zoom);
  const ed = $('#editor');
  ed.style.padding = `${g.top}px ${g.right}px ${g.bottom}px ${g.left}px`;
  renderSheets();
}

function renderSheets() {
  const gap = printing ? 0 : PAGE_GAP;
  const n = Math.max(pages, 1);
  const sheets = $('#sheets');
  const crop = (cls: string, x: number, y: number) =>
    `<div class="crop ${cls}" style="left:${x}px;top:${y}px"></div>`;
  let html = '';
  for (let i = 0; i < n; i++) {
    const top = i * (g.height + gap);
    html +=
      `<div class="sheet" style="top:${top}px;height:${g.height}px">` +
      crop('tl', g.left - 14, g.top - 14) +
      crop('tr', g.width - g.right, g.top - 14) +
      crop('bl', g.left - 14, g.height - g.bottom) +
      crop('br', g.width - g.right, g.height - g.bottom) +
      `<div class="pno">- ${i + 1} -</div></div>`;
  }
  sheets.innerHTML = html;
  $('#page-stack').style.height = `${n * g.height + (n - 1) * gap}px`;
  $('#editor').style.minHeight = `${n * g.height + (n - 1) * gap}px`;
}

// ---------------- 도구 상자 ----------------
const TOOLS: [string, string, string][][] = [
  [['new', '새 문서', 'new'], ['open', '불러오기', 'open'], ['save', '저장하기', 'save']],
  [['cut', '오려 두기', 'cut'], ['copy', '복사하기', 'copy'], ['paste', '붙이기', 'paste']],
  [['undo', '되돌리기', 'undo'], ['redo', '다시 실행', 'redo']],
  [['table', '표', 'insertTable'], ['image', '그림', 'insertImage'], ['pagebreak', '쪽 나누기', 'pageBreak'], ['symbol', '문자표', 'insertSymbol']],
  [['charshape', '글자 모양', 'charShape'], ['parashape', '문단 모양', 'paraShape'], ['page', '편집 용지', 'pageSetup']],
  [['find', '찾기', 'find'], ['info', '문서 정보', 'docInfo']],
  [['print', '인쇄', 'print'], ['pdf', 'PDF 저장', 'exportPdf']],
];

function buildToolbox() {
  $('#toolbox').innerHTML =
    `<div class="brand">${LOGO}<span>결 워드</span></div>` +
    TOOLS.map(
      (grp) =>
        `<div class="group">${grp.map(([icon, label, id]) => `<button class="tool" data-cmd="${id}" title="${label}">${ICONS[icon]}<span>${label}</span></button>`).join('')}</div>`,
    ).join('');
  $('#toolbox').addEventListener('mousedown', (e) => e.preventDefault());
  $('#toolbox').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-cmd]') as HTMLElement | null;
    if (b) run(b.dataset.cmd!);
  });
}

// ---------------- 서식 도구 모음 ----------------
const LINE_SPACINGS = [100, 130, 150, 160, 180, 200, 250, 300];

function buildFormatbar() {
  const fb = $('#formatbar');
  const btn = (id: string, icon: string, title: string, extra = '') => `<button class="fbtn ${extra}" data-cmd="${id}" title="${title}">${icon}</button>`;
  fb.innerHTML =
    `<select id="fb-style" title="스타일">${Object.keys(STYLES).map((s) => `<option>${s}</option>`).join('')}</select>` +
    `<div class="sep"></div>` +
    `<select id="fb-font" title="글꼴"></select>` +
    `<div class="size-box"><input id="fb-size" title="글자 크기" value="10"><div class="spin"><button data-cmd="fontBigger" title="크게">▲</button><button data-cmd="fontSmaller" title="작게">▼</button></div><span class="unit">pt</span></div>` +
    `<div class="sep"></div>` +
    btn('bold', ICONS.bold, '진하게 (⌘B)') +
    btn('italic', ICONS.italic, '기울임 (⌘I)') +
    btn('underline', ICONS.underline, '밑줄 (⌘U)') +
    btn('strike', ICONS.strike, '취소선') +
    btn('superscript', ICONS.sup, '위 첨자') +
    btn('subscript', ICONS.sub, '아래 첨자') +
    `<div class="sep"></div>` +
    `<button class="fbtn color-btn" data-cmd="textColorApply" title="글자 색">${ICONS.textColor}<span class="bar" id="tc-bar" style="background:#C00000"></span></button>` +
    `<button class="fbtn drop" data-cmd="textColorPick" title="글자 색 고르기">${ICONS.chevron}</button>` +
    `<button class="fbtn color-btn" data-cmd="highlightApply" title="형광펜">${ICONS.highlight}<span class="bar" id="hl-bar" style="background:#FFFF00"></span></button>` +
    `<button class="fbtn drop" data-cmd="highlightPick" title="형광펜 색 고르기">${ICONS.chevron}</button>` +
    `<div class="sep"></div>` +
    btn('alignJustify', ICONS.alignJustify, '양쪽 정렬') +
    btn('alignLeft', ICONS.alignLeft, '왼쪽 정렬') +
    btn('alignCenter', ICONS.alignCenter, '가운데 정렬') +
    btn('alignRight', ICONS.alignRight, '오른쪽 정렬') +
    btn('alignDistribute', ICONS.alignDistribute, '배분 정렬') +
    `<div class="sep"></div>` +
    `<select id="fb-line" title="줄 간격">${LINE_SPACINGS.map((v) => `<option value="${v}">${v}%</option>`).join('')}</select>` +
    btn('indentLess', ICONS.indentLess, '왼쪽 여백 줄이기') +
    btn('indentMore', ICONS.indentMore, '왼쪽 여백 늘리기') +
    `<div class="sep"></div>` +
    btn('toggleMarks', ICONS.marks, '조판 부호 보이기');
  fillFonts();

  fb.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('button')) e.preventDefault();
  });
  fb.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-cmd]') as HTMLElement | null;
    if (b) run(b.dataset.cmd!, b);
  });
  $('#fb-style').addEventListener('change', (e) => {
    exec(applyStyle((e.target as HTMLSelectElement).value));
    view.focus();
  });
  $('#fb-font').addEventListener('change', (e) => {
    const f = (e.target as HTMLSelectElement).value;
    exec(setMark(schema.marks.font, { hangul: f, latin: f }));
    view.focus();
  });
  const size = $<HTMLInputElement>('#fb-size');
  size.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = parseFloat(size.value);
      if (v > 0) exec(setMark(schema.marks.size, { size: Math.round(v * 100) }));
      view.focus();
    }
  });
  $('#fb-line').addEventListener('change', (e) => {
    exec(setParaAttrs({ lineSpacing: Number((e.target as HTMLSelectElement).value) }));
    view.focus();
  });
}

function fillFonts() {
  const sel = $<HTMLSelectElement>('#fb-font');
  if (!sel) return;
  sel.innerHTML = fonts.map((f) => `<option style="font-family:'${f}'">${f}</option>`).join('');
}

async function loadSystemFonts() {
  try {
    const list = await window.queryLocalFonts?.();
    if (!list?.length) return;
    const fams = [...new Set(list.map((f) => f.family))];
    // 한글 글꼴을 앞에
    const ko = fams.filter((f) => /[가-힣]|Gothic|Myeongjo|Batang|Dotum|Gulim|Hancom|HCR|Malgun|Nanum|Noto Sans KR|Noto Serif KR|AppleSD|Apple SD/i.test(f));
    fonts = [...new Set(['맑은 고딕', ...ko, ...fams.filter((f) => !ko.includes(f))])];
    fillFonts();
    syncToolbar();
  } catch {
    /* 권한이 없으면 기본 목록 */
  }
}

let textColor = '#C00000';
let highlightColor = '#FFFF00';

function markActive(state: EditorState, type: (typeof schema.marks)[string]): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

function currentMarks(state: EditorState): readonly Mark[] {
  return state.storedMarks ?? state.selection.$from.marks();
}

function syncToolbar() {
  const s = view.state;
  const fb = $('#formatbar');
  const on = (id: string, v: boolean) => fb.querySelector(`[data-cmd="${id}"]`)?.classList.toggle('on', v);
  for (const m of ['bold', 'italic', 'underline', 'strike', 'superscript', 'subscript']) on(m, markActive(s, schema.marks[m]));
  const para = s.selection.$from.parent.type === schema.nodes.paragraph ? s.selection.$from.parent : selectedParagraphs(s)[0]?.node;
  const align = para?.attrs.align ?? 'justify';
  for (const a of ['Justify', 'Left', 'Center', 'Right', 'Distribute']) on(`align${a}`, align === a.toLowerCase());
  const styleSel = $<HTMLSelectElement>('#fb-style');
  if (document.activeElement !== styleSel) styleSel.value = para?.attrs.style ?? '바탕글';
  const marks = currentMarks(s);
  const font = marks.find((m) => m.type === schema.marks.font)?.attrs.hangul ?? '맑은 고딕';
  const fontSel = $<HTMLSelectElement>('#fb-font');
  if (document.activeElement !== fontSel) {
    if (![...fontSel.options].some((o) => o.value === font)) fontSel.insertAdjacentHTML('afterbegin', `<option>${font}</option>`);
    fontSel.value = font;
  }
  const sizeIn = $<HTMLInputElement>('#fb-size');
  if (document.activeElement !== sizeIn) sizeIn.value = String(currentSize(s) / 100);
  const lineSel = $<HTMLSelectElement>('#fb-line');
  const ls = para?.attrs.lineSpacing ?? 160;
  if (![...lineSel.options].some((o) => Number(o.value) === ls)) lineSel.insertAdjacentHTML('beforeend', `<option value="${ls}">${ls}%</option>`);
  lineSel.value = String(ls);
  on('toggleMarks', document.body.classList.contains('show-marks'));
}

// ---------------- 상태 표시줄 ----------------
function buildStatus() {
  $('#statusbar').innerHTML =
    `<span id="st-page">1/1 쪽</span><span id="st-sec">1구역</span><span id="st-chars"></span><span id="st-dirty"></span><span class="spacer"></span>` +
    `<span class="zoom"><button data-z="-" title="축소">${ICONS.zoomOut}</button><input type="range" id="st-zoom" min="30" max="300" step="10" value="100"><button data-z="+" title="확대">${ICONS.zoomIn}</button><span id="st-zoomv">100%</span></span>`;
  $('#statusbar').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-z]') as HTMLElement | null;
    if (b) setZoom(zoom + (b.dataset.z === '+' ? 0.1 : -0.1));
  });
  $('#st-zoom').addEventListener('input', (e) => setZoom(Number((e.target as HTMLInputElement).value) / 100));
}

let statusTimer = 0;
function renderStatus() {
  cancelAnimationFrame(statusTimer);
  statusTimer = requestAnimationFrame(() => {
    $('#st-page').textContent = `${caretPage(view.state)}/${pages} 쪽`;
    $('#st-chars').textContent = `글자 ${wordCount(view.state.doc).chars.toLocaleString()}`;
    $('#st-dirty').innerHTML = dirty ? '<span class="dirty">● 수정됨</span>' : '';
  });
}

function setZoom(z: number) {
  zoom = Math.round(Math.min(3, Math.max(0.3, z)) * 100) / 100;
  $<HTMLInputElement>('#st-zoom').value = String(Math.round(zoom * 100));
  $('#st-zoomv').textContent = `${Math.round(zoom * 100)}%`;
  layoutPage();
}

// ---------------- 실행 ----------------
function exec(cmd: Command) {
  cmd(view.state, view.dispatch, view);
}

function paraOf(): Required<import('../../model/doc').ParaProps> {
  const p = selectedParagraphs(view.state)[0]?.node.attrs ?? {};
  return {
    align: p.align ?? 'justify',
    indent: p.indent ?? 0,
    marginLeft: p.marginLeft ?? 0,
    marginRight: p.marginRight ?? 0,
    spaceBefore: p.spaceBefore ?? 0,
    spaceAfter: p.spaceAfter ?? 0,
    lineSpacing: p.lineSpacing ?? 160,
  };
}

/** 글자 모양 대화상자 결과를 선택 영역에 반영 */
function applyChar(c: CharProps) {
  const s = view.state;
  const M = schema.marks;
  const managed = [M.bold, M.italic, M.underline, M.strike, M.superscript, M.subscript, M.color, M.highlight, M.font, M.size, M.charExtra];
  const marks = charMarks({ ...c, color: c.color, size: c.size === 1000 ? undefined : c.size });
  const tr = s.tr;
  if (s.selection.empty) {
    const keep = currentMarks(s).filter((m) => !managed.includes(m.type));
    tr.setStoredMarks([...keep, ...marks]);
  } else {
    const { from, to } = s.selection;
    for (const t of managed) tr.removeMark(from, to, t);
    for (const m of marks) tr.addMark(from, to, m);
  }
  view.dispatch(tr);
}

async function run(id: string, anchor?: HTMLElement) {
  const M = schema.marks;
  if (id.startsWith('style:')) return exec(applyStyle(id.slice(6)));
  switch (id) {
    case 'new':
      return api.newWindow();
    case 'open':
      return api.openDialog();
    case 'save':
      return save(false);
    case 'saveAs':
      return save(true);
    case 'exportPdf':
      return exportPdf();
    case 'print':
      return print();
    case 'undo':
      return exec(undo);
    case 'redo':
      return exec(redo);
    case 'cut':
      view.focus();
      return document.execCommand('cut');
    case 'copy':
      view.focus();
      return document.execCommand('copy');
    case 'paste':
      view.focus();
      return document.execCommand('paste');
    case 'bold':
    case 'italic':
    case 'underline':
    case 'strike':
    case 'superscript':
    case 'subscript':
      return exec(toggle(id));
    case 'alignLeft':
    case 'alignCenter':
    case 'alignRight':
    case 'alignJustify':
    case 'alignDistribute':
      return exec(setParaAttrs({ align: id.slice(5).toLowerCase() }));
    case 'indentMore':
    case 'indentLess': {
      const p = paraOf();
      return exec(setParaAttrs({ marginLeft: Math.max(0, p.marginLeft + (id === 'indentMore' ? 1000 : -1000)) }));
    }
    case 'fontBigger':
      return exec(stepSize(100));
    case 'fontSmaller':
      return exec(stepSize(-100));
    case 'textColorApply':
      return exec(setMark(M.color, { color: textColor }));
    case 'textColorPick': {
      const c = await colorPopover(anchor ?? $('#formatbar'), false);
      if (c) {
        textColor = c;
        $('#tc-bar').style.background = c;
        exec(setMark(M.color, { color: c }));
      }
      return view.focus();
    }
    case 'highlightApply':
      return exec(setMark(M.highlight, { color: highlightColor }));
    case 'highlightPick': {
      const c = await colorPopover(anchor ?? $('#formatbar'), true);
      if (c === null) exec(setMark(M.highlight, null));
      else if (c) {
        highlightColor = c;
        $('#hl-bar').style.background = c;
        exec(setMark(M.highlight, { color: c }));
      }
      return view.focus();
    }
    case 'toggleMarks':
      document.body.classList.toggle('show-marks');
      return syncToolbar();
    case 'charShape': {
      const cur = marksToChar(currentMarks(view.state));
      const r = await charShapeDialog({ size: currentSize(view.state), fontHangul: '맑은 고딕', fontLatin: '맑은 고딕', color: '#000000', ...cur }, fonts);
      if (r) applyChar(r);
      return view.focus();
    }
    case 'paraShape': {
      const r = await paraShapeDialog(paraOf());
      if (r) exec(setParaAttrs({ ...r }));
      return view.focus();
    }
    case 'pageSetup': {
      const r = await pageSetupDialog(page);
      if (r) {
        page = r;
        setDirty(true);
        layoutPage();
        repaginate(view, g, PAGE_GAP);
      }
      return view.focus();
    }
    case 'insertTable': {
      const r = await tableDialog();
      if (r) exec(insertTable(r.rows, r.cols, g.width - g.left - g.right - 4));
      return view.focus();
    }
    case 'insertImage': {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/gif,image/bmp,image/webp';
      input.onchange = () => input.files?.[0] && insertImageFile(input.files[0]);
      return input.click();
    }
    case 'pageBreak':
      return exec(pageBreak);
    case 'lineBreak':
      return exec(insertLineBreak);
    case 'insertDate': {
      const d = new Date();
      return exec(insertText(`${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`));
    }
    case 'insertSymbol': {
      const ch = await symbolDialog();
      if (ch) exec(insertText(ch));
      return view.focus();
    }
    case 'addRowBefore':
      return exec(addRowBefore);
    case 'addRowAfter':
      return exec(addRowAfter);
    case 'addColumnBefore':
      return exec(addColumnBefore);
    case 'addColumnAfter':
      return exec(addColumnAfter);
    case 'deleteRow':
      return exec(deleteRow);
    case 'deleteColumn':
      return exec(deleteColumn);
    case 'mergeCells':
      return exec(mergeCells);
    case 'splitCell':
      return exec(splitCell);
    case 'deleteTable':
      return exec(deleteTable);
    case 'toggleBorders':
      return exec(toggleTableBorders);
    case 'cellBackground': {
      const c = await colorPopover($('#formatbar'), true);
      if (c !== undefined) exec(setCellAttr('background', c));
      return view.focus();
    }
    case 'find':
    case 'replace':
      return openFind(id === 'replace');
    case 'docInfo':
    case 'wordCount': {
      const r = await docInfoDialog({
        title: meta.title ?? '',
        creator: meta.creator ?? '',
        path: filePath ?? '',
        created: meta.createdAt,
        modified: meta.modifiedAt,
        pages,
        stats: wordCount(view.state.doc),
      });
      if (r && (r.title !== (meta.title ?? '') || r.creator !== (meta.creator ?? ''))) {
        meta = { ...meta, ...r };
        setDirty(true);
      }
      return view.focus();
    }
    case 'zoomIn':
      return setZoom(zoom + 0.1);
    case 'zoomOut':
      return setZoom(zoom - 0.1);
    case 'zoom100':
      return setZoom(1);
    case 'zoomFit':
      return setZoom(($('#workspace').clientWidth - 48) / g.width);
  }
}

function insertImageFile(file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    const src = String(reader.result);
    const img = new Image();
    img.onload = () => {
      const ext = (/^data:image\/(\w+)/.exec(src)?.[1] ?? 'png').replace('jpeg', 'jpg');
      exec(insertImage(src, ext, img.naturalWidth, img.naturalHeight, g.width - g.left - g.right));
      view.focus();
    };
    img.src = src;
  };
  reader.readAsDataURL(file);
}

// ---------------- 찾기/바꾸기 ----------------
function openFind(withReplace: boolean) {
  const p = $('#find-panel');
  if (p.hidden || p.dataset.replace !== String(withReplace)) {
    p.dataset.replace = String(withReplace);
    p.innerHTML =
      `<div class="r"><input type="text" id="fq" placeholder="찾을 내용"><span class="count" id="fc"></span></div>` +
      (withReplace ? `<div class="r"><input type="text" id="fr" placeholder="바꿀 내용"></div>` : '') +
      `<div class="r"><label style="display:flex;gap:4px;align-items:center;font-size:12px;color:var(--muted)"><input type="checkbox" id="fcase">대소문자 구별</label><span style="flex:1"></span>` +
      `<button class="btn" id="fprev">이전</button><button class="btn" id="fnext">다음</button>` +
      (withReplace ? `<button class="btn" id="frep">바꾸기</button><button class="btn" id="fall">모두 바꾸기</button>` : '') +
      `<button class="btn" id="fclose">닫기</button></div>`;
    const q = $<HTMLInputElement>('#fq');
    const update = () => {
      view.dispatch(setQuery(view.state, q.value, $<HTMLInputElement>('#fcase').checked));
      updateCount();
    };
    q.addEventListener('input', update);
    $('#fcase').addEventListener('change', update);
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
      if (e.key === 'Escape') closeFind();
    });
    $('#fnext').onclick = () => step(1);
    $('#fprev').onclick = () => step(-1);
    $('#fclose').onclick = closeFind;
    if (withReplace) {
      $('#frep').onclick = () => {
        const tr = replaceCurrent(view.state, $<HTMLInputElement>('#fr').value);
        if (tr) view.dispatch(tr);
        step(1);
      };
      $('#fall').onclick = () => {
        const r = replaceAll(view.state, $<HTMLInputElement>('#fr').value);
        if (r) {
          view.dispatch(r.tr);
          toast(`${r.count}개를 바꾸었습니다.`);
        }
        updateCount();
      };
    }
  }
  p.hidden = false;
  const q = $<HTMLInputElement>('#fq');
  const { from, to } = view.state.selection;
  const selText = view.state.doc.textBetween(from, to);
  if (selText && selText.length < 80) {
    q.value = selText;
    view.dispatch(setQuery(view.state, q.value));
    updateCount();
  }
  q.focus();
  q.select();
}

function step(dir: 1 | -1) {
  const tr = findStep(view.state, dir);
  if (tr) view.dispatch(tr);
  updateCount();
}

function updateCount() {
  const s = findKey.getState(view.state);
  const el = document.getElementById('fc');
  if (el && s) el.textContent = s.query ? (s.hits.length ? `${s.current + 1}/${s.hits.length}` : '없음') : '';
}

function closeFind() {
  $('#find-panel').hidden = true;
  view.dispatch(setQuery(view.state, ''));
  view.focus();
}

// ---------------- 파일 ----------------
function setDirty(v: boolean) {
  dirty = v;
  updateTitle();
  renderStatus();
}

function updateTitle() {
  api.setTitle(`${fileName}${dirty ? ' (수정됨)' : ''} — 결 워드`, dirty, filePath);
}

function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(Number(t.dataset.timer));
  t.dataset.timer = String(setTimeout(() => (t.hidden = true), 2400));
}

async function parse(name: string, bytes: Uint8Array): Promise<GDocument> {
  const ext = name.toLowerCase().split('.').pop();
  const magic = bytes.subarray(0, 4);
  if (magic[0] === 0x50 && magic[1] === 0x4b) return readHwpx(bytes);
  if (magic[0] === 0xd0 && magic[1] === 0xcf && magic[2] === 0x11 && magic[3] === 0xe0) return readHwp5(bytes);
  if (ext !== 'txt') throw new Error('지원하지 않는 형식입니다. (HWPX, HWP, HWTX, TXT)');
  const text = new TextDecoder('utf-8').decode(bytes);
  const doc = newDocument();
  doc.sections[0].blocks = text.split(/\r?\n/).map((line) => ({ type: 'paragraph' as const, para: {}, runs: line ? [{ type: 'text' as const, text: line, char: {} }] : [] }));
  return doc;
}

async function openFile(f: OpenedFile) {
  try {
    const doc = await parse(f.name, f.bytes);
    const { doc: pm, page: pg } = modelToPM(doc);
    page = pg;
    meta = doc.meta;
    const ext = f.name.toLowerCase().split('.').pop();
    // 서식 파일과 HWP(바이너리)는 HWPX 로 새로 저장하도록 경로를 비워 둔다
    if (ext === 'hwpx') {
      filePath = f.path;
      fileName = f.name;
    } else {
      filePath = undefined;
      fileName = f.name.replace(/\.\w+$/, '');
    }
    view.updateState(createState(pm));
    blank = false;
    pages = 1;
    layoutPage();
    setDirty(false);
    syncToolbar();
    if (ext === 'hwp') toast('HWP 문서를 열었습니다. 저장하면 HWPX 형식으로 저장됩니다.');
    $('#workspace').scrollTop = 0;
  } catch (e) {
    alert(`문서를 열 수 없습니다.\n${(e as Error).message}`);
  }
}

async function save(saveAs: boolean): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    meta = { ...meta, modifiedAt: now, createdAt: meta.createdAt ?? now };
    const bytes = await writeHwpx(pmToModel(view.state.doc, page, meta));
    const r = await api.save({ path: filePath, suggested: fileName, bytes, saveAs });
    if (!r) return false;
    filePath = r.path;
    fileName = r.name;
    setDirty(false);
    toast('저장했습니다.');
    return true;
  } catch (e) {
    alert(`저장하지 못했습니다.\n${(e as Error).message}`);
    return false;
  }
}

// 인쇄·PDF: 쪽 간격을 0 으로 다시 배치한 뒤 출력
function pdfOptions() {
  return { widthIn: page.width / 7200, heightIn: page.height / 7200, landscape: page.landscape };
}

function beforePrint() {
  printing = true;
  document.body.classList.add('printing');
  let st = document.getElementById('page-css') as HTMLStyleElement | null;
  if (!st) {
    st = document.createElement('style');
    st.id = 'page-css';
    document.head.appendChild(st);
  }
  st.textContent = `@page { size: ${page.width / 7200}in ${page.height / 7200}in; margin: 0; }`;
  const z = zoom;
  zoom = 1;
  layoutPage();
  zoom = z;
  repaginate(view, g, 0);
  renderSheets();
}

function afterPrint() {
  printing = false;
  document.body.classList.remove('printing');
  layoutPage();
  repaginate(view, g, PAGE_GAP);
  renderSheets();
}

async function exportPdf() {
  beforePrint();
  try {
    const out = await api.exportPdf({ suggested: fileName, ...pdfOptions() });
    if (out) toast('PDF로 저장했습니다.');
  } finally {
    afterPrint();
  }
}

async function print() {
  beforePrint();
  try {
    await api.print();
  } finally {
    afterPrint();
  }
}

// ---------------- 시작 ----------------
window.__gyeolIsBlank = () => blank && !dirty;
window.__gyeolPdfOptions = pdfOptions;
window.__gyeolBeforePrint = beforePrint;
window.__gyeolAfterPrint = afterPrint;
window.__gyeol = {
  view,
  run: (id) => run(id),
  open: (name, bytes) => openFile({ name, path: '', bytes }),
  serialize: () => writeHwpx(pmToModel(view.state.doc, page, meta)),
  // 검증용: 쪽 수와 각 쪽 첫 글자들
  report: () => {
    const ps = paginationKey.getState(view.state);
    const doc = view.state.doc;
    const textAt = (pos: number) => doc.textBetween(pos, Math.min(doc.content.size, pos + 200), ' ', ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
    // 문단마다 화면 줄 수(한글 배치 캐시와 비교용)
    const lines: [string, number][] = [];
    doc.descendants((n, pos) => {
      if (n.type.name !== 'paragraph') return true;
      const el = view.nodeDOM(pos) as HTMLElement | null;
      if (el && n.textContent.trim()) {
        const r = document.createRange();
        r.selectNodeContents(el);
        const tops: number[] = [];
        for (const rc of r.getClientRects()) if (rc.width > 0 && !tops.some((t) => Math.abs(t - rc.top) < 4)) tops.push(rc.top);
        lines.push([n.textContent.replace(/\s+/g, ' ').trim().slice(0, 24), tops.length]);
      }
      return false;
    });
    // 최상위 블록의 (쪽, 쪽 안 y[HWPUNIT]) — 한글 vertpos 와 비교
    const tops: [string, number, number][] = [];
    const base = (view.dom as HTMLElement).getBoundingClientRect().top;
    const P = geom(page).height + PAGE_GAP;
    doc.forEach((n, off) => {
      const el = view.nodeDOM(off) as HTMLElement | null;
      if (!el || el.nodeType !== 1) return;
      const y = (el.getBoundingClientRect().top - base) / zoom + (n.type.name === 'paragraph' ? parseFloat(getComputedStyle(el).getPropertyValue('--lx')) * 96 / 72 / 2 || 0 : 0);
      const pg = Math.floor((y + 1) / P);
      tops.push([n.textContent.replace(/\s+/g, ' ').trim().slice(0, 20), pg + 1, Math.round((y - pg * P) * 75)]);
    });
    // 최상위 표의 줄 높이(HWPUNIT)
    const rows: number[][] = [];
    doc.descendants((n, off) => {
      if (n.type.name !== 'table') return true;
      const t = (view.nodeDOM(off) as HTMLElement | null)?.querySelector('table');
      if (t) rows.push([...t.rows].filter((r) => !r.classList.contains('page-gap-row')).map((r) => Math.round((r.getBoundingClientRect().height / zoom) * 75)));
      return true;
    });
    // 지정한 최상위 표(window.__gyeolCellTable 번째)의 첫 칸 안 블록 위치(칸 위 기준, HWPUNIT)
    const cell: [string, number][] = [];
    // 첫 글자가 __gyeolCellText 로 시작하는 칸
    const want = (window as unknown as { __gyeolCellText?: string }).__gyeolCellText;
    let found = false;
    doc.forEach((n, off) => {
      if (!want || found || n.type.name !== 'table') return;
      const tds = [...(view.nodeDOM(off) as HTMLElement).querySelectorAll('td')] as HTMLElement[];
      const td = tds.find((x) => (x.textContent ?? '').trim().startsWith(want));
      if (!td) return;
      found = true;
      const t0 = td.getBoundingClientRect().top;
      for (const ch of td.children) {
        if ((ch as HTMLElement).classList.contains('page-gap')) continue;
        const lx = parseFloat(getComputedStyle(ch).getPropertyValue('--lx')) * 96 / 72 / 2 || 0;
        cell.push([(ch.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 20), Math.round(((ch.getBoundingClientRect().top - t0) / zoom + lx) * 75)]);
      }
    });
    const gaps: [number, string, string][] = (ps?.deco.find() ?? []).map((d) => [d.from, (d.spec as { k: string }).k, textAt(d.from).slice(0, 16)]);
    return { pages, starts: [textAt(0), ...(ps?.breaks ?? []).map(textAt)], lines, tops, rows, cell, gaps };
  },
};

buildToolbox();
buildFormatbar();
buildStatus();
layoutPage();
syncToolbar();
updateTitle();
view.focus();
loadSystemFonts();

api.onOpened(openFile);
api.onMenu((id) => run(id));
api.onRequestClose(async () => {
  if (!dirty) return api.closeOk();
  const r = await api.confirmDiscard(fileName);
  if (r === 'discard' || (r === 'save' && (await save(false)))) api.closeOk();
});

