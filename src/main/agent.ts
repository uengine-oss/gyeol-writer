// AI 도우미: 이 컴퓨터에 설치된 Claude Code(claude) 또는 Codex(codex) 명령을 불러 문서 작업을 맡긴다.
// 화면 쪽은 요청(지시·문서 내용·선택한 그림)을 보내고, 진행 상황과 결과(마크다운 또는 그림)를 받는다.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain, type WebContents } from 'electron';

export type Engine = 'claude' | 'codex';
export type AgentMode = 'write' | 'rewrite' | 'ask' | 'image-edit' | 'image-draw';

export interface AgentRequest {
  id: string;
  engine: Engine;
  mode: AgentMode;
  instruction: string;
  /** 문서 전체(마크다운). 커서·선택 자리는 표시 문자로 들어 있다 */
  document: string;
  selection?: string;
  image?: { bytes: Uint8Array; ext: string };
}

export type AgentEvent =
  | { id: string; kind: 'text'; text: string } // 응답 글이 이어 붙는다
  | { id: string; kind: 'step'; text: string } // 도구 사용 등 진행 단계
  | { id: string; kind: 'done'; text: string; image?: { bytes: Uint8Array; mime: string } }
  | { id: string; kind: 'error'; text: string };

const isWin = process.platform === 'win32';

// ---------------- 명령 찾기 ----------------
// 앱으로 실행하면 터미널의 PATH 를 물려받지 못하므로, 로그인 셸에서 PATH 를 한 번 얻어 온다
let loginPath: Promise<string> | undefined;
function shellPath(): Promise<string> {
  loginPath ??= new Promise((resolve) => {
    const base = process.env.PATH ?? '';
    if (isWin) return resolve(base);
    const sh = process.env.SHELL || '/bin/zsh';
    execFile(sh, ['-ilc', 'printf "__GYEOL__%s" "$PATH"'], { timeout: 8000 }, (_e, out) => {
      const p = /__GYEOL__(.*)$/s.exec(String(out ?? ''))?.[1]?.trim();
      const extra = [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.npm-global/bin'), join(homedir(), '.claude/local')];
      resolve([...new Set([...(p ? p.split(':') : []), ...base.split(':'), ...extra])].filter(Boolean).join(':'));
    });
  });
  return loginPath;
}

async function which(cmd: string): Promise<string | null> {
  const PATH = await shellPath();
  const sep = isWin ? ';' : ':';
  const names = isWin ? [`${cmd}.cmd`, `${cmd}.exe`, cmd] : [cmd];
  for (const dir of PATH.split(sep)) for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  return null;
}

async function version(bin: string): Promise<string> {
  return new Promise((resolve) =>
    execFile(bin, ['--version'], { timeout: 10000, env: childEnv(), shell: isWin }, (_e, out) => resolve(String(out ?? '').trim().split('\n')[0] ?? '')),
  );
}

let pathCache = '';
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: pathCache || process.env.PATH };
  // 개발 실행(VS Code 터미널)에서 물려받은 값이 자식 node 프로그램을 망가뜨리지 않게
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export interface EngineInfo {
  engine: Engine;
  label: string;
  path: string | null;
  version: string;
}

let detected: Promise<EngineInfo[]> | undefined;
export function detectEngines(force = false): Promise<EngineInfo[]> {
  if (force) {
    detected = undefined;
    loginPath = undefined;
  }
  detected ??= (async () => {
    pathCache = await shellPath();
    const list: [Engine, string][] = [
      ['claude', 'Claude Code'],
      ['codex', 'Codex'],
    ];
    return Promise.all(
      list.map(async ([engine, label]) => {
        const path = await which(engine);
        return { engine, label, path, version: path ? await version(path) : '' };
      }),
    );
  })();
  return detected;
}

// ---------------- 지시문 ----------------
const COMMON = `너는 한글 워드프로세서 '결 워드' 안에서 일하는 문서 작성 도우미다.
- 사용자가 지금 편집 중인 문서가 <문서> 안에 마크다운으로 주어진다.
- 응답은 한국어로, 문서의 기존 문체(존댓말·개조식·공문체 등)와 용어를 따른다.
- 사실을 지어내지 말고, 문서에 없는 수치·고유명사는 일반적인 표현으로 쓴다.`;

const OUTPUT_RULE = `출력 규칙: 문서에 그대로 들어갈 내용만 출력한다. 인사말·설명·"다음과 같습니다" 같은 머리말, 코드 울타리(\`\`\`)를 쓰지 않는다.
서식은 마크다운으로: 제목은 #·##·###, 목록은 -, 굵게는 **, 표는 | 칸 | 칸 | 형식.`;

function prompt(req: AgentRequest, engine: Engine, imageName?: string): string {
  const doc = `<문서>\n${req.document.slice(0, 60000) || '(빈 문서)'}\n</문서>`;
  switch (req.mode) {
    case 'write':
      return `${COMMON}\n\n${doc}\n\n문서 안 ⟦커서⟧ 자리에 새 내용을 써 넣으려 한다. 앞뒤 흐름에 맞게 그 자리에 들어갈 내용만 작성하라.\n${OUTPUT_RULE}\n\n<요청>\n${req.instruction}\n</요청>`;
    case 'rewrite':
      return `${COMMON}\n\n${doc}\n\n사용자가 ⟦선택 시작⟧과 ⟦선택 끝⟧ 사이를 선택했다:\n<선택>\n${req.selection ?? ''}\n</선택>\n\n요청대로 고친 새 내용만 출력하라. 그 내용이 선택 부분을 그대로 대신한다. 원문이 한 문단이면 한 문단으로, 요청이 없는 부분의 뜻은 바꾸지 않는다.\n${OUTPUT_RULE}\n\n<요청>\n${req.instruction}\n</요청>`;
    case 'ask':
      return `${COMMON}\n\n${doc}\n\n사용자가 문서에 대해 묻는다. 본문은 고치지 말고 질문에 간결하게 답하라(필요하면 마크다운 목록).\n\n<질문>\n${req.instruction}\n</질문>`;
    case 'image-edit': {
      const how =
        engine === 'codex'
          ? `이미지 생성·편집 도구(imagegen)로 ${imageName}을 바탕으로 고친 그림을 만들거나, 단순한 수정(자르기·색·글자 넣기 등)은 Python(PIL)으로 처리한다.`
          : `Python(PIL)으로 ${imageName}을 고치거나, ${imageName}을 <image href="${imageName}"/>로 깐 SVG 위에 도형·글자를 그려 output.svg 로 저장한다.`;
      return `${COMMON}\n\n${doc}\n\n작업 폴더의 ${imageName}은 사용자가 문서에서 선택한 그림이다. 먼저 그림을 열어 내용을 확인하라.\n${how}\n결과는 이 작업 폴더에 output.png(또는 output.svg) 한 개로 저장한다. 원본 비율과 크기는 요청이 없으면 유지한다.\n저장한 뒤 무엇을 바꿨는지 한 문장으로 답하라.\n\n<요청>\n${req.instruction}\n</요청>`;
    }
    case 'image-draw': {
      const how =
        engine === 'codex'
          ? '이미지 생성 도구(imagegen)로 그림을 만들어 이 작업 폴더에 output.png 로 복사한다. 도식·차트처럼 정확한 글자가 중요하면 SVG 로 그려 output.svg 로 저장해도 된다.'
          : 'SVG 로 직접 그려 이 작업 폴더에 output.svg 로 저장한다. viewBox 와 width/height 를 지정하고, 외부 파일·글꼴·스크립트는 쓰지 않는다. 글자는 font-family="Apple SD Gothic Neo, Malgun Gothic, sans-serif". 문서에 어울리는 단정한 색을 쓴다.';
      return `${COMMON}\n\n${doc}\n\n문서 안 ⟦커서⟧ 자리에 넣을 그림을 그려야 한다.\n${how}\n저장한 뒤 무엇을 그렸는지 한 문장으로 답하라.\n\n<요청>\n${req.instruction}\n</요청>`;
    }
  }
}

// ---------------- 실행 ----------------
const running = new Map<string, { child: ChildProcess; dir?: string; cancelled?: boolean }>();

function args(engine: Engine, mode: AgentMode, dir: string, imageName?: string): string[] {
  const image = mode === 'image-edit' || mode === 'image-draw';
  if (engine === 'claude') {
    const a = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--strict-mcp-config', '--no-session-persistence'];
    // 글 작업은 도구 없이 바로 답하게(빠르다), 그림 작업은 작업 폴더 안에서 파일·Python 만
    if (!image) a.push('--tools', '');
    else a.push('--tools', 'Read,Write,Edit,Bash', '--allowedTools', 'Read', 'Write', 'Edit', 'Bash(python3:*)', 'Bash(ls:*)', 'Bash(file:*)', '--permission-mode', 'acceptEdits');
    return a;
  }
  const a = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', image ? 'workspace-write' : 'read-only', '-C', dir, '-o', join(dir, 'last-message.txt')];
  if (imageName) a.push('-i', join(dir, imageName));
  a.push('-');
  return a;
}

/** 작업 폴더에서 결과 그림을 찾는다. SVG 안의 원본 그림 참조는 data: 로 바꿔 넣는다 */
async function resultImage(dir: string, inputName?: string): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
  const files = await readdir(dir);
  const pick = ['output.png', 'output.jpg', 'output.jpeg', 'output.webp', 'output.svg'].find((f) => files.includes(f)) ?? files.find((f) => /\.(png|jpe?g|webp|svg)$/i.test(f) && f !== inputName);
  if (!pick) return undefined;
  const ext = pick.split('.').pop()!.toLowerCase();
  let bytes = await readFile(join(dir, pick));
  if (ext === 'svg' && inputName && files.includes(inputName)) {
    const ie = inputName.split('.').pop()!.replace('jpg', 'jpeg');
    const data = `data:image/${ie};base64,${(await readFile(join(dir, inputName))).toString('base64')}`;
    bytes = Buffer.from(bytes.toString('utf8').replace(new RegExp(`(href=["'])(\\./)?${inputName.replace('.', '\\.')}(["'])`, 'g'), `$1${data}$3`));
  }
  const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext.replace('jpg', 'jpeg')}`;
  return { bytes: new Uint8Array(bytes), mime };
}

function short(s: string, n = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Claude 도구 사용을 사람이 읽을 말로 */
function claudeStep(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return `명령 실행: ${short(String(input.command ?? ''), 60)}`;
  if (name === 'Write') return `파일 쓰기: ${String(input.file_path ?? '').split('/').pop()}`;
  if (name === 'Read') return `파일 읽기: ${String(input.file_path ?? '').split('/').pop()}`;
  if (name === 'Edit') return `파일 고치기: ${String(input.file_path ?? '').split('/').pop()}`;
  return name;
}

export async function runAgent(req: AgentRequest, send: (e: AgentEvent) => void): Promise<void> {
  const engines = await detectEngines();
  const info = engines.find((e) => e.engine === req.engine);
  if (!info?.path) return send({ id: req.id, kind: 'error', text: `${req.engine} 명령을 찾을 수 없습니다. 설치한 뒤 다시 시도하세요.` });
  const dir = await mkdtemp(join(tmpdir(), 'gyeol-agent-'));
  let imageName: string | undefined;
  if (req.image) {
    imageName = `input.${req.image.ext === 'jpg' ? 'jpg' : req.image.ext}`;
    await writeFile(join(dir, imageName), req.image.bytes);
  }
  const image = req.mode === 'image-edit' || req.mode === 'image-draw';
  const child = spawn(info.path, args(req.engine, req.mode, dir, imageName), { cwd: dir, env: childEnv(), shell: isWin, stdio: ['pipe', 'pipe', 'pipe'] });
  const job: { child: ChildProcess; dir?: string; cancelled?: boolean } = { child, dir };
  running.set(req.id, job);
  child.stdin!.end(prompt(req, req.engine, imageName));

  let text = ''; // 화면에 흘려 보낸 응답 글
  let final = ''; // 마지막 응답(결과)
  let errText = '';
  let buf = '';
  const onLine = (line: string) => {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (req.engine === 'claude') {
      if (o.type === 'stream_event' && o.event?.type === 'content_block_delta' && o.event.delta?.type === 'text_delta') {
        text += o.event.delta.text;
        send({ id: req.id, kind: 'text', text: o.event.delta.text });
      } else if (o.type === 'assistant') {
        for (const c of o.message?.content ?? []) if (c.type === 'tool_use') send({ id: req.id, kind: 'step', text: claudeStep(c.name, c.input ?? {}) });
        // 도구를 쓴 뒤 새 글이 이어지면 줄을 바꾼다
        if (text && !text.endsWith('\n')) {
          text += '\n';
          send({ id: req.id, kind: 'text', text: '\n' });
        }
      } else if (o.type === 'result') {
        if (o.is_error) errText = String(o.result ?? o.subtype ?? '실패');
        else final = String(o.result ?? '');
      }
    } else {
      const it = o.item;
      if (o.type === 'item.completed' && it?.type === 'agent_message') {
        final = String(it.text ?? '');
        const t = (text ? '\n' : '') + final;
        text += t;
        send({ id: req.id, kind: 'text', text: t });
      } else if (o.type === 'item.started' && it?.type === 'command_execution') {
        send({ id: req.id, kind: 'step', text: `명령 실행: ${short(String(it.command ?? '').replace(/^\/bin\/\w+ -lc '?|'$/g, ''), 60)}` });
      } else if (o.type === 'item.started' && it?.type && it.type !== 'reasoning' && it.type !== 'agent_message') {
        const names: Record<string, string> = { file_change: '파일 쓰기', web_search: '웹 검색', mcp_tool_call: '도구 사용', todo_list: '할 일 정리' };
        send({ id: req.id, kind: 'step', text: /image/.test(it.type) ? '그림 생성 중' : names[it.type] ?? it.type });
      } else if (o.type === 'turn.failed' || o.type === 'error') errText = String(o.error?.message ?? o.message ?? '실패');
    }
  };
  child.stdout!.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  let stderr = '';
  child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-4000)));

  await new Promise<void>((resolve) => {
    child.on('error', (e) => {
      errText = e.message;
      resolve();
    });
    child.on('close', () => resolve());
  });
  if (buf.trim()) onLine(buf);
  running.delete(req.id);
  try {
    if (job.cancelled) return send({ id: req.id, kind: 'error', text: '멈췄습니다.' });
    if (req.engine === 'codex' && !final) final = await readFile(join(dir, 'last-message.txt'), 'utf8').catch(() => '');
    const img = image ? await resultImage(dir, imageName) : undefined;
    if (image && !img) return send({ id: req.id, kind: 'error', text: errText || short(final || stderr, 300) || '그림 파일을 만들지 못했습니다.' });
    if (!image && !final.trim()) return send({ id: req.id, kind: 'error', text: errText || short(stderr, 300) || '응답이 없습니다.' });
    send({ id: req.id, kind: 'done', text: final.trim(), image: img });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function cancelAgent(id: string) {
  const job = running.get(id);
  if (!job) return;
  job.cancelled = true;
  job.child.kill('SIGTERM');
  setTimeout(() => job.child.exitCode === null && job.child.kill('SIGKILL'), 3000);
}

export function registerAgentIpc() {
  ipcMain.handle('agent:engines', (_e, force?: boolean) => detectEngines(!!force));
  ipcMain.handle('agent:run', (e, req: AgentRequest) => {
    const wc: WebContents = e.sender;
    runAgent(req, (ev) => !wc.isDestroyed() && wc.send('agent:event', ev));
  });
  ipcMain.handle('agent:cancel', (_e, id: string) => cancelAgent(id));
}
