import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const isMac = process.platform === 'darwin';
const windows = new Set<BrowserWindow>();
let pendingOpen: string[] = [];
// 렌더러가 '닫아도 된다'고 확인한 창
const allowClose = new WeakSet<BrowserWindow>();

// 열 수 있는 파일
const OPEN_FILTERS = [
  { name: '한글 문서', extensions: ['hwpx', 'hwp', 'hwtx', 'owpml'] },
  { name: '텍스트', extensions: ['txt'] },
  { name: '모든 파일', extensions: ['*'] },
];

function createWindow(filePath?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: Number(process.env.GYEOL_WIN_W || 1280),
    height: Number(process.env.GYEOL_WIN_H || 900),
    minWidth: 900,
    minHeight: 600,
    title: '결 워드',
    backgroundColor: '#E9ECF1',
    show: !process.env.GYEOL_CAPTURE,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  windows.add(win);
  win.on('close', (e) => {
    if (allowClose.has(win) || process.env.GYEOL_CAPTURE) return;
    e.preventDefault();
    win.webContents.send('app:request-close');
  });
  win.on('closed', () => windows.delete(win));

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));

  win.webContents.once('did-finish-load', async () => {
    // 검증용: 글꼴 폭 보정 끄기
    if (process.env.GYEOL_NOFIT)
      await win.webContents.executeJavaScript("globalThis.__gyeolNoFit = true; const pm = document.querySelector('.ProseMirror'); pm.style.removeProperty('--fls'); pm.style.removeProperty('--fws');");
    if (filePath) await sendOpen(win, filePath);
    if (process.env.GYEOL_CAPTURE) capture(win);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

/** 검증용: GYEOL_CAPTURE=out.png 이면 화면을 저장하고 종료 (화면 기록 권한 불필요) */
async function capture(win: BrowserWindow) {
  const script = process.env.GYEOL_CAPTURE_SCRIPT;
  await new Promise((r) => setTimeout(r, 1200));
  if (script) await win.webContents.executeJavaScript(script);
  // 시나리오: 실제 입력 이벤트로 편집 (insert=IME 확정 문자, key=키 입력, menu=메뉴 명령, js=스크립트)
  if (process.env.GYEOL_E2E_STEPS) {
    const steps = JSON.parse(await readFile(process.env.GYEOL_E2E_STEPS, 'utf8')) as [string, ...unknown[]][];
    win.webContents.focus();
    for (const [kind, a, b] of steps) {
      if (kind === 'insert') await win.webContents.insertText(String(a));
      else if (kind === 'key') {
        const modifiers = (b as ('meta' | 'shift' | 'alt' | 'control')[]) ?? [];
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: String(a), modifiers });
        const plain = !modifiers.some((m) => m === 'meta' || m === 'control');
        if (plain && String(a).length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: String(a), modifiers });
        // Enter 는 char('\r') 까지 보내야 폼 제출 등이 일어난다
        if (plain && (a === 'Return' || a === 'Enter')) win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: String(a), modifiers });
      } else if (kind === 'menu') win.webContents.send('menu', a);
      else if (kind === 'js') await win.webContents.executeJavaScript(String(a));
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  await new Promise((r) => setTimeout(r, 800));
  // 검증용: 임의 식을 평가해 결과(JSON)를 파일로
  if (process.env.GYEOL_EVAL && process.env.GYEOL_EVAL_OUT) {
    const v = await win.webContents.executeJavaScript(process.env.GYEOL_EVAL);
    await writeFile(process.env.GYEOL_EVAL_OUT, JSON.stringify(v, null, 1));
  }
  if (process.env.GYEOL_REPORT) {
    await new Promise((r) => setTimeout(r, 1500));
    const rep = await win.webContents.executeJavaScript('window.__gyeol.report()');
    await writeFile(process.env.GYEOL_REPORT, JSON.stringify(rep, null, 1));
  }
  if (process.env.GYEOL_E2E_OUT) {
    const bytes = await win.webContents.executeJavaScript('window.__gyeol.serialize()');
    await writeFile(process.env.GYEOL_E2E_OUT, Buffer.from(bytes));
  }
  // GYEOL_CAPTURE_SHEET=n 이면 n쪽 용지 영역만 저장(한글 미리보기와 비교용)
  const sheet = Number(process.env.GYEOL_CAPTURE_SHEET || 0);
  let rect: Electron.Rectangle | undefined;
  if (sheet) {
    rect = await win.webContents.executeJavaScript(
      `(() => { const s = document.querySelectorAll('.sheet')[${sheet - 1}]; if (!s) return undefined; s.scrollIntoView(); const r = s.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(Math.min(r.height, innerHeight - r.y)) }; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
  }
  const img = await win.webContents.capturePage(rect);
  await writeFile(process.env.GYEOL_CAPTURE!, img.toPNG());
  if (process.env.GYEOL_CAPTURE_PDF) {
    const pdf = await win.webContents.executeJavaScript('window.__gyeolBeforePrint(); window.__gyeolPdfOptions()');
    await new Promise((r) => setTimeout(r, 500));
    await writeFile(process.env.GYEOL_CAPTURE_PDF, await printPdf(win, pdf));
  }
  app.exit(0);
}

async function sendOpen(win: BrowserWindow, filePath: string) {
  try {
    const bytes = await readFile(filePath);
    win.webContents.send('file:opened', { path: filePath, name: basename(filePath), bytes: new Uint8Array(bytes) });
    app.addRecentDocument(filePath);
  } catch (e) {
    dialog.showErrorBox('열기 실패', `${filePath}\n${(e as Error).message}`);
  }
}

function focused(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? [...windows][0];
}

async function openDialog(win?: BrowserWindow) {
  const r = await dialog.showOpenDialog(win ?? focused()!, { properties: ['openFile', 'multiSelections'], filters: OPEN_FILTERS });
  if (r.canceled) return;
  for (const p of r.filePaths) {
    const w = win ?? focused();
    // 현재 창이 빈 새 문서면 그 창에서 연다
    const blank = w && (await w.webContents.executeJavaScript('window.__gyeolIsBlank && window.__gyeolIsBlank()'));
    if (w && blank) await sendOpen(w, p);
    else createWindow(p);
  }
}

async function printPdf(win: BrowserWindow, opt: { widthIn: number; heightIn: number; landscape: boolean } | null) {
  return win.webContents.printToPDF({
    printBackground: true,
    pageSize: opt ? { width: opt.widthIn, height: opt.heightIn } : 'A4',
    margins: { marginType: 'none' },
    preferCSSPageSize: true,
  });
}

ipcMain.handle('file:open-dialog', (e) => openDialog(BrowserWindow.fromWebContents(e.sender) ?? undefined));

ipcMain.handle('file:save', async (e, args: { path?: string; suggested: string; bytes: Uint8Array; saveAs?: boolean }) => {
  const win = BrowserWindow.fromWebContents(e.sender)!;
  let target = args.path;
  if (!target || args.saveAs || extname(target).toLowerCase() !== '.hwpx') {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: args.suggested.replace(/\.(hwp|hwtx|owpml|txt)$/i, '') .replace(/(\.hwpx)?$/i, '.hwpx'),
      filters: [{ name: '한글 문서 (HWPX)', extensions: ['hwpx'] }],
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  await writeFile(target, args.bytes);
  app.addRecentDocument(target);
  return { path: target, name: basename(target) };
});

ipcMain.handle('file:export-pdf', async (e, args: { suggested: string; widthIn: number; heightIn: number; landscape: boolean }) => {
  const win = BrowserWindow.fromWebContents(e.sender)!;
  const r = await dialog.showSaveDialog(win, {
    defaultPath: args.suggested.replace(/\.\w+$/, '') + '.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return null;
  await writeFile(r.filePath, await printPdf(win, args));
  shell.showItemInFolder(r.filePath);
  return r.filePath;
});

ipcMain.handle('file:print', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)!;
  win.webContents.print({ printBackground: true });
});

ipcMain.handle('app:confirm-discard', async (e, name: string) => {
  const win = BrowserWindow.fromWebContents(e.sender)!;
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['저장', '저장 안 함', '취소'],
    defaultId: 0,
    cancelId: 2,
    message: `'${name}' 문서가 변경되었습니다. 저장할까요?`,
  });
  return (['save', 'discard', 'cancel'] as const)[r.response];
});

ipcMain.on('app:close-ok', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  allowClose.add(win);
  win.close();
});

ipcMain.on('app:set-title', (e, title: string, edited: boolean, path?: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.setTitle(title);
  win.setDocumentEdited(edited);
  if (path) win.setRepresentedFilename(path);
});

ipcMain.on('app:new-window', () => createWindow());

// ---- 메뉴 ----
function cmd(id: string): MenuItemConstructorOptions['click'] {
  return () => focused()?.webContents.send('menu', id);
}

function buildMenu() {
  const item = (label: string, id: string, accelerator?: string): MenuItemConstructorOptions => ({ label, accelerator, click: cmd(id) });
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ label: '결 워드', submenu: [{ role: 'about' as const, label: '결 워드에 관하여' }, { type: 'separator' as const }, { role: 'hide' as const, label: '결 워드 가리기' }, { role: 'hideOthers' as const, label: '기타 가리기' }, { type: 'separator' as const }, { role: 'quit' as const, label: '결 워드 종료' }] }] : []),
    {
      label: '파일',
      submenu: [
        { label: '새 문서', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: '불러오기…', accelerator: 'CmdOrCtrl+O', click: () => openDialog() },
        { role: 'recentDocuments', label: '최근 문서', submenu: [{ role: 'clearRecentDocuments', label: '목록 지우기' }] },
        { type: 'separator' },
        item('저장하기', 'save', 'CmdOrCtrl+S'),
        item('다른 이름으로 저장하기…', 'saveAs', 'CmdOrCtrl+Shift+S'),
        item('PDF로 저장하기…', 'exportPdf'),
        { type: 'separator' },
        item('편집 용지…', 'pageSetup', 'F7'),
        item('문서 정보…', 'docInfo', 'CmdOrCtrl+Q+I'),
        { type: 'separator' },
        item('인쇄…', 'print', 'CmdOrCtrl+P'),
        { type: 'separator' },
        { role: 'close', label: '창 닫기' },
      ],
    },
    {
      label: '편집',
      submenu: [
        item('되돌리기', 'undo', 'CmdOrCtrl+Z'),
        item('다시 실행', 'redo', 'CmdOrCtrl+Shift+Z'),
        { type: 'separator' },
        { role: 'cut', label: '오려 두기' },
        { role: 'copy', label: '복사하기' },
        { role: 'paste', label: '붙이기' },
        { role: 'selectAll', label: '모두 선택' },
        { type: 'separator' },
        item('찾기…', 'find', 'CmdOrCtrl+F'),
        item('찾아 바꾸기…', 'replace', 'CmdOrCtrl+H'),
      ],
    },
    {
      label: '보기',
      submenu: [
        item('확대', 'zoomIn', 'CmdOrCtrl+='),
        item('축소', 'zoomOut', 'CmdOrCtrl+-'),
        item('100%', 'zoom100', 'CmdOrCtrl+0'),
        item('쪽 맞춤', 'zoomFit'),
        { type: 'separator' },
        item('조판 부호(탭·문단 끝) 보이기', 'toggleMarks'),
        { type: 'separator' },
        { role: 'toggleDevTools', label: '개발자 도구' },
        { role: 'togglefullscreen', label: '전체 화면' },
      ],
    },
    {
      label: '입력',
      submenu: [
        item('표…', 'insertTable', 'CmdOrCtrl+Alt+T'),
        item('그림…', 'insertImage', 'CmdOrCtrl+Alt+I'),
        { type: 'separator' },
        item('쪽 나누기', 'pageBreak', 'CmdOrCtrl+Enter'),
        item('줄 바꾸기', 'lineBreak', 'Shift+Enter'),
        item('날짜/시간', 'insertDate'),
        item('특수 문자…', 'insertSymbol', 'CmdOrCtrl+F10'),
      ],
    },
    {
      label: '서식',
      submenu: [
        item('글자 모양…', 'charShape', 'Alt+L'),
        item('문단 모양…', 'paraShape', 'Alt+T'),
        { type: 'separator' },
        item('진하게', 'bold', 'CmdOrCtrl+B'),
        item('기울임', 'italic', 'CmdOrCtrl+I'),
        item('밑줄', 'underline', 'CmdOrCtrl+U'),
        { type: 'separator' },
        item('왼쪽 정렬', 'alignLeft', 'CmdOrCtrl+Shift+L'),
        item('가운데 정렬', 'alignCenter', 'CmdOrCtrl+Shift+C'),
        item('오른쪽 정렬', 'alignRight', 'CmdOrCtrl+Shift+R'),
        item('양쪽 정렬', 'alignJustify', 'CmdOrCtrl+Shift+M'),
        item('배분 정렬', 'alignDistribute', 'CmdOrCtrl+Shift+T'),
        { type: 'separator' },
        item('글자 크게', 'fontBigger', 'Alt+Shift+E'),
        item('글자 작게', 'fontSmaller', 'Alt+Shift+R'),
        { type: 'separator' },
        { label: '스타일', submenu: [item('바탕글', 'style:바탕글', 'CmdOrCtrl+1'), item('본문', 'style:본문', 'CmdOrCtrl+2'), item('개요 1', 'style:개요 1', 'CmdOrCtrl+3'), item('개요 2', 'style:개요 2', 'CmdOrCtrl+4'), item('개요 3', 'style:개요 3', 'CmdOrCtrl+5')] },
      ],
    },
    {
      label: '표',
      submenu: [
        item('표 만들기…', 'insertTable'),
        { type: 'separator' },
        item('위쪽에 줄 추가', 'addRowBefore'),
        item('아래쪽에 줄 추가', 'addRowAfter'),
        item('왼쪽에 칸 추가', 'addColumnBefore'),
        item('오른쪽에 칸 추가', 'addColumnAfter'),
        item('줄 지우기', 'deleteRow'),
        item('칸 지우기', 'deleteColumn'),
        { type: 'separator' },
        item('셀 합치기', 'mergeCells', 'M'),
        item('셀 나누기', 'splitCell', 'S'),
        item('셀 배경색…', 'cellBackground'),
        item('표 테두리 보이기/숨기기', 'toggleBorders'),
        { type: 'separator' },
        item('표 지우기', 'deleteTable'),
      ],
    },
    {
      label: '도구',
      submenu: [item('글자 수 세기…', 'wordCount')],
    },
    { role: 'windowMenu', label: '창' },
  ];
  // 표 메뉴의 M/S 는 단독 키라 메뉴 단축키로 등록하지 않는다
  for (const m of template) {
    if (Array.isArray(m.submenu)) for (const s of m.submenu as MenuItemConstructorOptions[]) if (s.accelerator === 'M' || s.accelerator === 'S' || s.accelerator === 'CmdOrCtrl+Q+I') delete s.accelerator;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// macOS: Finder 에서 문서로 열기
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (app.isReady()) createWindow(p);
  else pendingOpen.push(p);
});

app.whenReady().then(() => {
  buildMenu();
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => /\.(hwpx|hwp|hwtx|owpml|txt)$/i.test(a));
  const files = [...pendingOpen, ...args, ...(process.env.GYEOL_OPEN ? [process.env.GYEOL_OPEN] : [])];
  pendingOpen = [];
  if (files.length) files.forEach((f) => createWindow(f));
  else createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
