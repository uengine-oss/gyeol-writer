// 대화상자: 글자 모양, 문단 모양, 편집 용지, 표 만들기, 그림 자르기, 특수 문자, 문서 정보
import type { CharProps, PageSetup, ParaProps } from '../../model/doc';
import { MM } from '../../model/doc';
import { fontStack } from '../../editor/schema';
import { ICONS } from './icons';

const dlg = () => document.getElementById('dialog') as HTMLDialogElement;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 공통 틀: 확인 시 collect() 결과로 resolve, 취소 시 null */
function open<T>(title: string, body: string, collect: (root: HTMLElement) => T, okLabel = '설정', setup?: (root: HTMLElement) => void): Promise<T | null> {
  const d = dlg();
  d.innerHTML = `<form method="dialog"><div class="dh"><span>${title}</span><button type="button" data-x aria-label="닫기">${ICONS.close}</button></div>
    <div class="db">${body}</div>
    <div class="df"><button type="button" class="btn" data-cancel>취소</button>${okLabel ? `<button class="btn primary" value="ok">${okLabel}</button>` : ''}</div></form>`;
  return new Promise((resolve) => {
    let result: T | null = null;
    const form = d.querySelector('form')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      result = collect(d);
      d.close();
    });
    d.querySelector('[data-cancel]')!.addEventListener('click', () => d.close());
    d.querySelector('[data-x]')!.addEventListener('click', () => d.close());
    d.addEventListener('close', () => resolve(result), { once: true });
    setup?.(d);
    d.showModal();
    (d.querySelector('input,select') as HTMLElement | null)?.focus();
  });
}

const val = (root: HTMLElement, name: string) => (root.querySelector(`[name="${name}"]`) as HTMLInputElement).value;
const numv = (root: HTMLElement, name: string) => Number(val(root, name)) || 0;
const checked = (root: HTMLElement, name: string) => (root.querySelector(`[name="${name}"]`) as HTMLInputElement).checked;

function fontOptions(fonts: string[], current?: string): string {
  const list = current && !fonts.includes(current) ? [current, ...fonts] : fonts;
  return list.map((f) => `<option ${f === current ? 'selected' : ''}>${esc(f)}</option>`).join('');
}

// ---------- 글자 모양 ----------
export function charShapeDialog(cur: CharProps, fonts: string[]): Promise<CharProps | null> {
  const body = `
    <fieldset><legend>기본</legend>
      <div class="row"><span>기준 크기</span><div class="unit-in"><input type="number" name="size" min="1" max="4096" step="0.5" value="${(cur.size ?? 1000) / 100}"><span>pt</span></div></div>
      <div class="row"><span>한글 글꼴</span><select name="fontHangul">${fontOptions(fonts, cur.fontHangul)}</select></div>
      <div class="row"><span>영문 글꼴</span><select name="fontLatin">${fontOptions(fonts, cur.fontLatin ?? cur.fontHangul)}</select></div>
      <div class="grid2">
        <div class="row" style="grid-template-columns:52px 1fr"><span>장평</span><div class="unit-in"><input type="number" name="ratio" min="50" max="200" value="${cur.ratio ?? 100}"><span>%</span></div></div>
        <div class="row" style="grid-template-columns:52px 1fr"><span>자간</span><div class="unit-in"><input type="number" name="spacing" min="-50" max="50" value="${cur.spacing ?? 0}"><span>%</span></div></div>
      </div>
    </fieldset>
    <fieldset><legend>속성</legend>
      <div class="grid3">
        <label class="chk"><input type="checkbox" name="bold" ${cur.bold ? 'checked' : ''}> 진하게</label>
        <label class="chk"><input type="checkbox" name="italic" ${cur.italic ? 'checked' : ''}> 기울임</label>
        <label class="chk"><input type="checkbox" name="underline" ${cur.underline ? 'checked' : ''}> 밑줄</label>
        <label class="chk"><input type="checkbox" name="strike" ${cur.strike ? 'checked' : ''}> 취소선</label>
        <label class="chk"><input type="checkbox" name="superscript" ${cur.superscript ? 'checked' : ''}> 위 첨자</label>
        <label class="chk"><input type="checkbox" name="subscript" ${cur.subscript ? 'checked' : ''}> 아래 첨자</label>
      </div>
      <div class="grid2">
        <div class="row" style="grid-template-columns:52px 1fr"><span>글자 색</span><input type="color" name="color" value="${cur.color ?? '#000000'}"></div>
        <div class="row" style="grid-template-columns:52px 1fr"><span>음영 색</span><div class="unit-in"><input type="color" name="highlight" value="${cur.highlight ?? '#FFFF00'}"><label class="chk"><input type="checkbox" name="useHighlight" ${cur.highlight ? 'checked' : ''}> 사용</label></div></div>
      </div>
    </fieldset>
    <div class="preview" id="cs-preview">한글 Hangul 123 가나다</div>`;
  const collect = (r: HTMLElement): CharProps => ({
    size: Math.round(numv(r, 'size') * 100),
    fontHangul: val(r, 'fontHangul'),
    fontLatin: val(r, 'fontLatin'),
    ratio: numv(r, 'ratio') || 100,
    spacing: numv(r, 'spacing'),
    bold: checked(r, 'bold'),
    italic: checked(r, 'italic'),
    underline: checked(r, 'underline'),
    strike: checked(r, 'strike'),
    superscript: checked(r, 'superscript'),
    subscript: checked(r, 'subscript') && !checked(r, 'superscript'),
    color: val(r, 'color').toUpperCase(),
    highlight: checked(r, 'useHighlight') ? val(r, 'highlight').toUpperCase() : undefined,
  });
  return open('글자 모양', body, collect, '설정', (root) => {
    const pv = root.querySelector('#cs-preview') as HTMLElement;
    const upd = () => {
      const c = collect(root);
      Object.assign(pv.style, {
        fontSize: `${(c.size ?? 1000) / 100}pt`,
        fontFamily: fontStack(c.fontLatin, c.fontHangul),
        fontWeight: c.bold ? '700' : '400',
        fontStyle: c.italic ? 'italic' : 'normal',
        textDecoration: [c.underline ? 'underline' : '', c.strike ? 'line-through' : ''].join(' ').trim() || 'none',
        color: c.color,
        background: c.highlight ?? 'transparent',
        letterSpacing: `${(c.spacing ?? 0) / 100}em`,
      });
    };
    root.addEventListener('input', upd);
    upd();
  });
}

// ---------- 문단 모양 ----------
export function paraShapeDialog(cur: Required<ParaProps>): Promise<ParaProps | null> {
  const pt = (hu: number) => +(hu / 100).toFixed(1);
  const firstKind = cur.indent > 0 ? 'indent' : cur.indent < 0 ? 'outdent' : 'normal';
  const body = `
    <fieldset><legend>정렬 방식</legend>
      <div class="grid3" style="grid-template-columns:repeat(5,auto)">
        ${(['justify:양쪽', 'left:왼쪽', 'right:오른쪽', 'center:가운데', 'distribute:배분'] as const)
          .map((x) => {
            const [v, l] = x.split(':');
            return `<label class="chk"><input type="radio" name="align" value="${v}" ${cur.align === v ? 'checked' : ''}> ${l}</label>`;
          })
          .join('')}
      </div>
    </fieldset>
    <fieldset><legend>여백</legend>
      <div class="grid2">
        <div class="row" style="grid-template-columns:52px 1fr"><span>왼쪽</span><div class="unit-in"><input type="number" step="0.5" name="marginLeft" value="${pt(cur.marginLeft)}"><span>pt</span></div></div>
        <div class="row" style="grid-template-columns:52px 1fr"><span>오른쪽</span><div class="unit-in"><input type="number" step="0.5" name="marginRight" value="${pt(cur.marginRight)}"><span>pt</span></div></div>
      </div>
    </fieldset>
    <fieldset><legend>첫 줄</legend>
      <div class="grid3" style="grid-template-columns:auto auto auto 1fr">
        <label class="chk"><input type="radio" name="first" value="normal" ${firstKind === 'normal' ? 'checked' : ''}> 보통</label>
        <label class="chk"><input type="radio" name="first" value="indent" ${firstKind === 'indent' ? 'checked' : ''}> 들여쓰기</label>
        <label class="chk"><input type="radio" name="first" value="outdent" ${firstKind === 'outdent' ? 'checked' : ''}> 내어쓰기</label>
        <div class="unit-in"><input type="number" step="0.5" min="0" name="indent" value="${Math.abs(pt(cur.indent)) || 10}"><span>pt</span></div>
      </div>
    </fieldset>
    <fieldset><legend>간격</legend>
      <div class="grid3">
        <div><div style="color:var(--muted);font-size:12px;margin-bottom:4px">줄 간격</div><div class="unit-in"><input type="number" min="50" max="500" step="5" name="lineSpacing" value="${cur.lineSpacing}"><span>%</span></div></div>
        <div><div style="color:var(--muted);font-size:12px;margin-bottom:4px">문단 위</div><div class="unit-in"><input type="number" step="0.5" min="0" name="spaceBefore" value="${pt(cur.spaceBefore)}"><span>pt</span></div></div>
        <div><div style="color:var(--muted);font-size:12px;margin-bottom:4px">문단 아래</div><div class="unit-in"><input type="number" step="0.5" min="0" name="spaceAfter" value="${pt(cur.spaceAfter)}"><span>pt</span></div></div>
      </div>
    </fieldset>`;
  return open('문단 모양', body, (r) => {
    const first = (r.querySelector('[name=first]:checked') as HTMLInputElement).value;
    const ind = Math.round(numv(r, 'indent') * 100);
    return {
      align: (r.querySelector('[name=align]:checked') as HTMLInputElement).value as ParaProps['align'],
      marginLeft: Math.round(numv(r, 'marginLeft') * 100),
      marginRight: Math.round(numv(r, 'marginRight') * 100),
      indent: first === 'indent' ? ind : first === 'outdent' ? -ind : 0,
      lineSpacing: numv(r, 'lineSpacing') || 160,
      spaceBefore: Math.round(numv(r, 'spaceBefore') * 100),
      spaceAfter: Math.round(numv(r, 'spaceAfter') * 100),
    };
  });
}

// ---------- 편집 용지 ----------
const PAPERS: Record<string, [number, number]> = {
  'A4 (국배판)': [210, 297],
  'A3': [297, 420],
  'A5 (국판)': [148, 210],
  'B4 (타블로이드)': [257, 364],
  'B5 (46배판)': [182, 257],
  'Letter': [215.9, 279.4],
  'Legal': [215.9, 355.6],
};

export function pageSetupDialog(cur: PageSetup): Promise<PageSetup | null> {
  const mm = (hu: number) => +(hu / MM).toFixed(1);
  const [pw, ph] = cur.landscape ? [cur.height, cur.width] : [cur.width, cur.height];
  const match = Object.entries(PAPERS).find(([, [w, h]]) => Math.abs(w - mm(pw)) < 1 && Math.abs(h - mm(ph)) < 1)?.[0] ?? '사용자 정의';
  const m = cur.margin;
  const field = (name: string, label: string, v: number) =>
    `<div class="row" style="grid-template-columns:52px 1fr"><span>${label}</span><div class="unit-in"><input type="number" step="0.1" min="0" name="${name}" value="${v}"><span>mm</span></div></div>`;
  const body = `
    <div style="display:grid;grid-template-columns:1fr 150px;gap:14px">
      <div style="display:grid;gap:12px">
        <fieldset><legend>용지 종류</legend>
          <div class="row" style="grid-template-columns:52px 1fr"><span>종류</span><select name="paper">${[...Object.keys(PAPERS), '사용자 정의'].map((k) => `<option ${k === match ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
          <div class="grid2">${field('w', '폭', mm(pw))}${field('h', '길이', mm(ph))}</div>
          <div class="grid2">
            <label class="chk"><input type="radio" name="orient" value="p" ${!cur.landscape ? 'checked' : ''}> 세로</label>
            <label class="chk"><input type="radio" name="orient" value="l" ${cur.landscape ? 'checked' : ''}> 가로</label>
          </div>
        </fieldset>
        <fieldset><legend>용지 여백</legend>
          <div class="grid2">
            ${field('top', '위쪽', mm(m.top))}${field('bottom', '아래쪽', mm(m.bottom))}
            ${field('left', '왼쪽', mm(m.left))}${field('right', '오른쪽', mm(m.right))}
            ${field('header', '머리말', mm(m.header))}${field('footer', '꼬리말', mm(m.footer))}
            ${field('gutter', '제본', mm(m.gutter))}
          </div>
        </fieldset>
      </div>
      <div><div style="color:var(--muted);font-size:12px;margin-bottom:6px;text-align:center">미리 보기</div><div class="page-diagram" id="pd"><div class="body"></div></div></div>
    </div>`;
  const collect = (r: HTMLElement): PageSetup => {
    const land = (r.querySelector('[name=orient]:checked') as HTMLInputElement).value === 'l';
    const w = Math.round(numv(r, 'w') * MM);
    const h = Math.round(numv(r, 'h') * MM);
    const g = (n: string) => Math.round(numv(r, n) * MM);
    return {
      width: land ? h : w,
      height: land ? w : h,
      landscape: land,
      margin: { top: g('top'), bottom: g('bottom'), left: g('left'), right: g('right'), header: g('header'), footer: g('footer'), gutter: g('gutter') },
    };
  };
  return open('편집 용지', body, collect, '설정', (root) => {
    const sel = root.querySelector('[name=paper]') as HTMLSelectElement;
    const pd = root.querySelector('#pd') as HTMLElement;
    const upd = () => {
      const p = collect(root);
      // 화면 표시는 실제 방향대로
      const W = p.landscape ? p.height : p.width;
      const H = p.landscape ? p.width : p.height;
      const vw = p.landscape ? 150 : 120;
      const vh = p.landscape ? 110 : 160;
      const k = Math.min(vw / W, vh / H);
      pd.style.width = `${W * k}px`;
      pd.style.height = `${H * k}px`;
      const b = pd.querySelector('.body') as HTMLElement;
      const m = p.margin;
      Object.assign(b.style, {
        left: `${(m.left + m.gutter) * k}px`,
        right: `${m.right * k}px`,
        top: `${(m.top + m.header) * k}px`,
        bottom: `${(m.bottom + m.footer) * k}px`,
      });
    };
    sel.addEventListener('change', () => {
      const v = PAPERS[sel.value];
      if (!v) return;
      (root.querySelector('[name=w]') as HTMLInputElement).value = String(v[0]);
      (root.querySelector('[name=h]') as HTMLInputElement).value = String(v[1]);
      upd();
    });
    root.addEventListener('input', upd);
    upd();
  });
}

// ---------- 표 만들기 ----------
export function tableDialog(): Promise<{ rows: number; cols: number } | null> {
  const cells = Array.from({ length: 80 }, (_, i) => `<span data-r="${Math.floor(i / 10) + 1}" data-c="${(i % 10) + 1}"></span>`).join('');
  const body = `
    <div class="grid2">
      <div class="row" style="grid-template-columns:40px 1fr"><span>줄 수</span><input type="number" name="rows" min="1" max="500" value="3"></div>
      <div class="row" style="grid-template-columns:40px 1fr"><span>칸 수</span><input type="number" name="cols" min="1" max="62" value="4"></div>
    </div>
    <div><div style="color:var(--muted);font-size:12px;margin-bottom:6px">마우스로 크기 고르기</div><div class="table-picker">${cells}</div></div>`;
  return open('표 만들기', body, (r) => ({ rows: Math.max(1, numv(r, 'rows')), cols: Math.max(1, numv(r, 'cols')) }), '만들기', (root) => {
    const picker = root.querySelector('.table-picker') as HTMLElement;
    const rows = root.querySelector('[name=rows]') as HTMLInputElement;
    const cols = root.querySelector('[name=cols]') as HTMLInputElement;
    const paint = () =>
      picker.querySelectorAll('span').forEach((s) => {
        const el = s as HTMLElement;
        el.classList.toggle('on', +el.dataset.r! <= +rows.value && +el.dataset.c! <= +cols.value);
      });
    picker.addEventListener('mouseover', (e) => {
      const t = e.target as HTMLElement;
      if (!t.dataset.r) return;
      rows.value = t.dataset.r;
      cols.value = t.dataset.c!;
      paint();
    });
    picker.addEventListener('click', () => (root.querySelector('form') as HTMLFormElement).requestSubmit());
    root.addEventListener('input', paint);
    paint();
  });
}

// ---------- 그림 자르기 ----------
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 그림 위에 자를 영역을 끌어서 고른다. 결과는 원본 픽셀 단위 */
export function cropDialog(src: string, natW: number, natH: number): Promise<CropRect | null> {
  // 미리보기 크기: 520×380 안에 맞춘다
  const k = Math.min(520 / natW, 380 / natH, 1);
  const vw = Math.round(natW * k);
  const vh = Math.round(natH * k);
  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<span class="h ${h}" data-h="${h}"></span>`).join('');
  const body = `
    <div class="crop-wrap"><div class="crop-stage" style="width:${vw}px;height:${vh}px"><img src="${esc(src)}" draggable="false" alt=""><div class="crop-box" data-h="move">${handles}</div></div></div>
    <div class="grid2">
      <div class="row" style="grid-template-columns:40px 1fr"><span>너비</span><div class="unit-in"><input type="number" name="cw" min="1" max="${natW}"><span>px</span></div></div>
      <div class="row" style="grid-template-columns:40px 1fr"><span>높이</span><div class="unit-in"><input type="number" name="ch" min="1" max="${natH}"><span>px</span></div></div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:12px"><span>모서리·변을 끌어 크기를, 안쪽을 끌어 위치를 바꿉니다.</span><button type="button" class="btn" data-reset>원래대로</button></div>`;
  // 화면 좌표(미리보기 px)의 자를 영역
  const r: CropRect = { x: 0, y: 0, w: vw, h: vh };
  const MIN = 8;
  return open(
    '그림 자르기',
    body,
    () => {
      const x = Math.round(r.x / k);
      const y = Math.round(r.y / k);
      return { x, y, w: Math.max(1, Math.min(natW - x, Math.round(r.w / k))), h: Math.max(1, Math.min(natH - y, Math.round(r.h / k))) };
    },
    '자르기',
    (root) => {
      const box = root.querySelector('.crop-box') as HTMLElement;
      const stage = root.querySelector('.crop-stage') as HTMLElement;
      const cw = root.querySelector('[name=cw]') as HTMLInputElement;
      const ch = root.querySelector('[name=ch]') as HTMLInputElement;
      const paint = () => {
        Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
        cw.value = String(Math.round(r.w / k));
        ch.value = String(Math.round(r.h / k));
      };
      stage.addEventListener('pointerdown', (e) => {
        const t = e.target as HTMLElement;
        const h = t.dataset.h;
        if (!h) return;
        e.preventDefault();
        const sx = e.clientX;
        const sy = e.clientY;
        const o = { ...r };
        const move = (ev: PointerEvent) => {
          const dx = ev.clientX - sx;
          const dy = ev.clientY - sy;
          if (h === 'move') {
            r.x = Math.min(Math.max(0, o.x + dx), vw - o.w);
            r.y = Math.min(Math.max(0, o.y + dy), vh - o.h);
          } else {
            let { x, y } = o;
            let x2 = o.x + o.w;
            let y2 = o.y + o.h;
            if (h.includes('w')) x = Math.min(Math.max(0, o.x + dx), x2 - MIN);
            if (h.includes('e')) x2 = Math.max(Math.min(vw, x2 + dx), x + MIN);
            if (h.includes('n')) y = Math.min(Math.max(0, o.y + dy), y2 - MIN);
            if (h.includes('s')) y2 = Math.max(Math.min(vh, y2 + dy), y + MIN);
            Object.assign(r, { x, y, w: x2 - x, h: y2 - y });
          }
          paint();
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      // 숫자로 크기 지정(왼쪽 위는 그대로 두고 그림 안으로 제한)
      const typed = () => {
        r.w = Math.max(MIN, Math.min(vw - r.x, (Number(cw.value) || 1) * k));
        r.h = Math.max(MIN, Math.min(vh - r.y, (Number(ch.value) || 1) * k));
        Object.assign(box.style, { width: `${r.w}px`, height: `${r.h}px` });
      };
      cw.addEventListener('change', typed);
      ch.addEventListener('change', typed);
      root.querySelector('[data-reset]')!.addEventListener('click', () => {
        Object.assign(r, { x: 0, y: 0, w: vw, h: vh });
        paint();
      });
      paint();
    },
  );
}

// ---------- 특수 문자 ----------
const SYMBOLS =
  '※○●◎◇◆□■△▲▽▼◁◀▷▶♤♠♡♥♧♣⊙◈▣◐◑▒▤▥▨▧▦▩☆★☏☎☜☞¶†‡↕↗↙↖↘♭♩♪♬㉿㈜№㏇™㏂㏘℡' +
  '→←↑↓↔⇒⇔∀∂∃∇∈∋∑∏√∝∞∠∧∨∩∪∫∬∮∴∵≒≠≡≤≥≪≫⊂⊃⊆⊇±×÷' +
  '「」『』【】〈〉《》〔〕‘’“”·‥…§〃' +
  '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ' +
  '㈀㈁㈂㈃㈄㈅㈆㈇㈈㈉㈊㈋㈌㈍⒜⒝⒞⒟⒠⒡⒢⒣⒤⒥ºª℃℉€£¥¢₩';

export function symbolDialog(): Promise<string | null> {
  const body = `<div class="symbols">${[...SYMBOLS].map((c) => `<button type="button" data-ch="${c}">${c}</button>`).join('')}</div>`;
  return new Promise((resolve) => {
    let picked: string | null = null;
    open('특수 문자', body, () => null, '', (root) => {
      root.querySelector('.symbols')!.addEventListener('click', (e) => {
        const ch = (e.target as HTMLElement).dataset.ch;
        if (!ch) return;
        picked = ch;
        (root as HTMLDialogElement).close();
      });
    }).then(() => resolve(picked));
  });
}

// ---------- 문서 정보 ----------
export function docInfoDialog(info: {
  title: string;
  creator: string;
  path: string;
  created?: string;
  modified?: string;
  pages: number;
  stats: { chars: number; charsNoSpace: number; words: number; paragraphs: number };
}): Promise<{ title: string; creator: string } | null> {
  const fmt = (d?: string) => (d ? new Date(d).toLocaleString('ko-KR') : '-');
  const body = `
    <fieldset><legend>문서 요약</legend>
      <div class="row"><span>제목</span><input type="text" name="title" value="${esc(info.title)}"></div>
      <div class="row"><span>지은이</span><input type="text" name="creator" value="${esc(info.creator)}"></div>
    </fieldset>
    <fieldset><legend>통계</legend>
      <dl class="stats">
        <dt>파일 위치</dt><dd style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(info.path)}">${esc(info.path || '저장되지 않음')}</dd>
        <dt>만든 날짜</dt><dd>${fmt(info.created)}</dd>
        <dt>고친 날짜</dt><dd>${fmt(info.modified)}</dd>
        <dt>쪽 수</dt><dd>${info.pages.toLocaleString()}</dd>
        <dt>글자 (공백 포함)</dt><dd>${info.stats.chars.toLocaleString()}</dd>
        <dt>글자 (공백 제외)</dt><dd>${info.stats.charsNoSpace.toLocaleString()}</dd>
        <dt>낱말</dt><dd>${info.stats.words.toLocaleString()}</dd>
        <dt>문단</dt><dd>${info.stats.paragraphs.toLocaleString()}</dd>
      </dl>
    </fieldset>`;
  return open('문서 정보', body, (r) => ({ title: val(r, 'title'), creator: val(r, 'creator') }), '확인');
}

// ---------- 색 팔레트(도구 모음용 팝오버) ----------
const COLORS = [
  '#000000', '#434343', '#666666', '#999999', '#B7B7B7', '#CCCCCC', '#E7E6E6', '#FFFFFF',
  '#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0',
  '#002060', '#7030A0', '#F4B183', '#FFE699', '#C5E0B4', '#BDD7EE', '#D9E2F3', '#E2CFF5',
  '#843C0C', '#7F6000', '#385723', '#1F4E79', '#203864', '#3A0F5C', '#FF66CC', '#99FFCC',
];

export function colorPopover(anchor: HTMLElement, allowNone: boolean): Promise<string | null | undefined> {
  const pop = document.getElementById('popover')!;
  pop.innerHTML = `<div class="palette">${COLORS.map((c) => `<button style="background:${c}" data-c="${c}" title="${c}"></button>`).join('')}</div>${allowNone ? '<button class="none" data-none>색 없음</button>' : ''}`;
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${r.left}px`;
  pop.style.top = `${r.bottom + 4}px`;
  pop.hidden = false;
  return new Promise((resolve) => {
    const done = (v: string | null | undefined) => {
      pop.hidden = true;
      document.removeEventListener('mousedown', outside, true);
      resolve(v);
    };
    const outside = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node)) done(undefined);
    };
    pop.onclick = (e) => {
      const t = e.target as HTMLElement;
      if (t.dataset.c) done(t.dataset.c);
      else if (t.dataset.none !== undefined) done(null);
    };
    setTimeout(() => document.addEventListener('mousedown', outside, true));
  });
}
