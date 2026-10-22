// AI 도우미 창(오른쪽): 설치된 Claude Code·Codex 에게 본문 쓰기, 선택 부분 고치기, 그림 고치기·그리기, 묻기를 맡긴다
import { closeHistory, undo } from 'prosemirror-history';
import { NodeSelection, TextSelection, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { AgentEvent, AgentMode, Engine, EngineInfo } from '../../preload/index';
import { aiTargetKey, setAiTarget, type AiTarget } from '../../editor/aitarget';
import { cleanReply, docToMarkdown, replaceWithMarkdown } from '../../editor/markdown';
import { schema } from '../../editor/schema';
import { ICONS } from './icons';

export interface AgentHost {
  view: EditorView;
  /** 본문 폭(px) */
  textWidth: () => number;
  toast: (msg: string) => void;
}

const MODES: { id: AgentMode; label: string; hint: string; placeholder: string; suggest: string[] }[] = [
  {
    id: 'write',
    label: '본문에 쓰기',
    hint: '커서 자리에 새 내용을 써 넣습니다.',
    placeholder: '무엇을 써 넣을까요? 예) 이 문서의 추진 배경을 세 문단으로',
    suggest: ['앞 내용에 이어 다음 문단 쓰기', '지금까지 내용을 요약하는 문단', '추진 일정을 표로 정리'],
  },
  {
    id: 'rewrite',
    label: '선택 부분 고치기',
    hint: '선택한 부분만 고쳐 그 자리에 바꿔 넣습니다.',
    placeholder: '선택한 부분을 어떻게 고칠까요? 예) 더 간결하게',
    suggest: ['더 간결하게', '공문서 문체로', '맞춤법·띄어쓰기 고치기', '개조식으로 바꾸기', '영어로 번역'],
  },
  {
    id: 'image-edit',
    label: '그림 고치기',
    hint: '선택한 그림을 고쳐 바꿔 넣습니다.',
    placeholder: '그림을 어떻게 고칠까요? 예) 배경을 흰색으로',
    suggest: ['흑백으로', '아래에 제목 글자 넣기', '빨간 테두리 두르기', '배경을 흰색으로'],
  },
  {
    id: 'image-draw',
    label: '그림 그리기',
    hint: '그림을 그려 커서 자리에 넣습니다.',
    placeholder: '무엇을 그릴까요? 예) 신청 → 검토 → 승인 업무 흐름도',
    suggest: ['이 문서 내용의 업무 흐름도', '표지에 넣을 단정한 일러스트', '항목별 막대 그래프'],
  },
  {
    id: 'ask',
    label: '묻기',
    hint: '본문은 그대로 두고 문서에 대해 답합니다.',
    placeholder: '문서에 대해 물어보세요. 예) 빠진 내용이 있나요?',
    suggest: ['이 문서를 세 줄로 요약', '빠지거나 모순된 내용 점검', '더 보강할 부분 제안'],
  },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;

interface Job {
  id: string;
  mode: AgentMode;
  engine: Engine;
  el: HTMLElement;
  text: string;
  resolve: () => void;
}

export function createAgentPanel(host: AgentHost) {
  const api = window.gyeol;
  const { view } = host;
  const panel = document.getElementById('ai-panel')!;
  let engines: EngineInfo[] = [];
  let engine: Engine = (localStorage.getItem('gyeol.agent.engine') as Engine) || 'claude';
  let mode: AgentMode = 'write';
  let manual = false; // 사용자가 직접 고른 작업 종류
  let job: Job | null = null;

  panel.innerHTML = `
    <div class="ai-head"><span class="ai-title">${ICONS.ai}<b>AI 도우미</b></span><button class="ai-x" data-act="close" title="닫기">${ICONS.close}</button></div>
    <div class="ai-engines" id="ai-engines"></div>
    <div class="ai-log" id="ai-log"><div class="ai-empty">
      <p><b>설치된 AI 에이전트로 문서를 함께 씁니다.</b></p>
      <p>본문에서 글자를 선택하면 그 부분만, 그림을 선택하면 그 그림을 고칩니다. 아무것도 선택하지 않으면 커서 자리에 써 넣습니다.</p>
      <p class="muted">바꾼 내용은 ⌘Z 로 되돌릴 수 있습니다.</p></div></div>
    <div class="ai-compose">
      <div class="ai-modes" id="ai-modes">${MODES.map((m) => `<button data-mode="${m.id}">${m.label}</button>`).join('')}</div>
      <div class="ai-target-line" id="ai-target-line"></div>
      <div class="ai-suggest" id="ai-suggest"></div>
      <div class="ai-input"><textarea id="ai-prompt" rows="3"></textarea><button class="ai-send" id="ai-send" title="보내기 (Enter)">${ICONS.send}</button></div>
    </div>`;
  const log = $(panel, '#ai-log');
  const input = $<HTMLTextAreaElement>(panel, '#ai-prompt');
  const sendBtn = $<HTMLButtonElement>(panel, '#ai-send');

  // ---------- 에이전트 고르기 ----------
  function renderEngines() {
    const box = $(panel, '#ai-engines');
    if (!engines.length) {
      box.innerHTML = `<span class="muted">에이전트를 찾는 중…</span>`;
      return;
    }
    if (!engines.some((e) => e.engine === engine && e.path)) engine = engines.find((e) => e.path)?.engine ?? engine;
    box.innerHTML =
      engines
        .map(
          (e) =>
            `<button data-engine="${e.engine}" class="${e.engine === engine ? 'on' : ''}" ${e.path ? '' : 'disabled'} title="${esc(e.path ? `${e.path}\n${e.version}` : '이 컴퓨터에 설치되어 있지 않습니다')}"><span class="dot ${e.path ? 'ok' : ''}"></span>${e.label}</button>`,
        )
        .join('') + `<button class="ai-rescan" data-act="rescan" title="다시 찾기">${ICONS.refresh}</button>`;
    if (!engines.some((e) => e.path))
      box.insertAdjacentHTML('beforeend', `<div class="ai-missing">Claude Code(<code>npm i -g @anthropic-ai/claude-code</code>) 또는 Codex(<code>npm i -g @openai/codex</code>)를 설치하고 로그인한 뒤 ↻ 를 누르세요.</div>`);
  }

  async function loadEngines(force = false) {
    engines = [];
    renderEngines();
    engines = await api.agentEngines(force);
    renderEngines();
  }

  // ---------- 작업 종류 / 대상 ----------
  function autoMode(s: EditorState): AgentMode {
    const sel = s.selection;
    if (sel instanceof NodeSelection && sel.node.type === schema.nodes.image) return 'image-edit';
    if (!sel.empty) return 'rewrite';
    return 'write';
  }

  function targetText(s: EditorState): string {
    const sel = s.selection;
    if (mode === 'image-edit') {
      if (sel instanceof NodeSelection && sel.node.type === schema.nodes.image) return `${ICONS.image}<span>선택한 그림 1개</span>`;
      return `<span class="warn">고칠 그림을 본문에서 먼저 선택하세요.</span>`;
    }
    if (mode === 'rewrite') {
      if (sel.empty) return `<span class="warn">고칠 부분을 본문에서 먼저 선택하세요.</span>`;
      const t = s.doc.textBetween(sel.from, sel.to, ' ', ' ').replace(/\s+/g, ' ').trim();
      return `<span>선택 ${t.length.toLocaleString()}자 · “${esc(t.length > 36 ? `${t.slice(0, 36)}…` : t)}”</span>`;
    }
    if (mode === 'ask') return `<span>문서 전체를 읽고 답합니다.</span>`;
    return `<span>커서 자리에 넣습니다.</span>`;
  }

  function sync() {
    if (panel.hidden) return;
    const s = view.state;
    if (!manual && !job) mode = autoMode(s);
    for (const b of panel.querySelectorAll<HTMLElement>('[data-mode]')) b.classList.toggle('on', b.dataset.mode === mode);
    const m = MODES.find((x) => x.id === mode)!;
    $(panel, '#ai-target-line').innerHTML = targetText(s);
    if (input.dataset.mode !== mode) {
      input.dataset.mode = mode;
      input.placeholder = m.placeholder;
      $(panel, '#ai-suggest').innerHTML = m.suggest.map((t) => `<button data-suggest="${esc(t)}">${esc(t)}</button>`).join('');
    }
    sendBtn.classList.toggle('stop', !!job);
    sendBtn.innerHTML = job ? ICONS.stop : ICONS.send;
    sendBtn.title = job ? '멈추기' : '보내기 (Enter)';
  }

  // ---------- 대화 기록 ----------
  function bubble(cls: string, html: string): HTMLElement {
    log.querySelector('.ai-empty')?.remove();
    const el = document.createElement('div');
    el.className = `ai-msg ${cls}`;
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  // ---------- 보내기 ----------
  function markedDocument(s: EditorState, m: AgentMode): string {
    const tr = s.tr;
    const { from, to } = s.selection;
    try {
      if (m === 'rewrite') tr.insertText('⟦선택 끝⟧', to).insertText('⟦선택 시작⟧', from);
      else if (m === 'write' || m === 'image-draw') tr.insertText('⟦커서⟧', from);
    } catch {
      /* 글자를 넣을 수 없는 자리(표 사이 등)면 표시 없이 */
    }
    return docToMarkdown(tr.doc);
  }

  async function imageBytes(src: string, ext: string): Promise<{ bytes: Uint8Array; ext: string }> {
    if (/^data:image\/(png|jpeg);base64,/.test(src)) {
      const b64 = src.slice(src.indexOf(',') + 1);
      return { bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), ext: ext === 'jpg' ? 'jpg' : 'png' };
    }
    // 그 밖의 형식(GIF·BMP·SVG 등)은 PNG 로 바꿔 보낸다
    const img = await loadImage(src);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || 800;
    c.height = img.naturalHeight || 600;
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: 'png' };
  }

  async function send(instruction: string): Promise<void> {
    instruction = instruction.trim();
    if (!instruction || job) return;
    const s = view.state;
    const sel = s.selection;
    const info = engines.find((e) => e.engine === engine);
    if (!info?.path) return host.toast('사용할 수 있는 AI 에이전트가 없습니다.');
    let target: AiTarget | null = null;
    let image: { bytes: Uint8Array; ext: string } | undefined;
    if (mode === 'image-edit') {
      if (!(sel instanceof NodeSelection) || sel.node.type !== schema.nodes.image) return host.toast('고칠 그림을 먼저 선택하세요.');
      image = await imageBytes(sel.node.attrs.src, sel.node.attrs.ext);
      target = { from: sel.from, to: sel.to, kind: 'node', label: '✦ 그림 고치는 중' };
    } else if (mode === 'rewrite') {
      if (sel.empty) return host.toast('고칠 부분을 먼저 선택하세요.');
      target = { from: sel.from, to: sel.to, kind: 'text', label: '✦ 고치는 중' };
    } else if (mode === 'write' || mode === 'image-draw') {
      target = { from: sel.to, to: sel.to, kind: 'point', label: mode === 'write' ? '✦ 쓰는 중' : '✦ 그리는 중' };
    }
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const m = MODES.find((x) => x.id === mode)!;
    bubble('user', `<div class="ai-tag">${m.label} · ${info.label}</div><div>${esc(instruction)}</div>`);
    const el = bubble('agent busy', `<div class="ai-steps"></div><div class="ai-text"></div><div class="ai-status"><span class="spin"></span>${info.label}가 작업 중…</div>`);
    if (target) view.dispatch(setAiTarget(view.state, target));
    input.value = '';
    const req = {
      id,
      engine,
      mode,
      instruction,
      document: markedDocument(s, mode),
      selection: mode === 'rewrite' ? s.doc.textBetween(sel.from, sel.to, '\n\n', ' ') : undefined,
      image,
    };
    const done = new Promise<void>((resolve) => (job = { id, mode, engine, el, text: '', resolve }));
    sync();
    api.agentRun(req);
    return done;
  }

  // ---------- 결과 받기 ----------
  function finish(j: Job) {
    job = null;
    manual = false;
    view.dispatch(setAiTarget(view.state, null));
    j.el.classList.remove('busy');
    j.resolve();
    sync();
  }

  function undoButton(): string {
    return `<button class="ai-undo" data-act="undo">${ICONS.undo}되돌리기</button>`;
  }

  async function apply(j: Job, ev: Extract<AgentEvent, { kind: 'done' }>) {
    const t = aiTargetKey.getState(view.state);
    const status = $(j.el, '.ai-status');
    if (j.mode === 'ask') {
      $(j.el, '.ai-text').textContent = cleanReply(ev.text);
      status.innerHTML = `<button class="ai-undo" data-act="insert">${ICONS.paste}본문에 넣기</button>`;
      return;
    }
    if (j.mode === 'write' || j.mode === 'rewrite') {
      const md = cleanReply(ev.text);
      $(j.el, '.ai-text').textContent = md;
      if (!t) return void (status.textContent = '넣을 자리를 찾지 못했습니다.');
      view.dispatch(closeHistory(view.state.tr));
      const tr = replaceWithMarkdown(view.state.tr.setMeta(aiTargetKey, null), t.from, t.to, md, host.textWidth() - 4);
      const end = tr.mapping.map(t.to, 1);
      tr.setSelection(TextSelection.create(tr.doc, Math.min(end, tr.doc.content.size)));
      view.dispatch(tr.scrollIntoView());
      status.innerHTML = `<span class="ok">✓ ${j.mode === 'write' ? '본문에 넣었습니다.' : '선택 부분을 바꿨습니다.'}</span>${undoButton()}`;
      return;
    }
    // 그림
    if (!ev.image || !t) return void (status.textContent = '그림을 받지 못했습니다.');
    const { src, w, h } = await toDataUrl(ev.image.bytes, ev.image.mime);
    $(j.el, '.ai-text').innerHTML = `<img class="ai-thumb" src="${src}" alt="">${ev.text ? `<div>${esc(ev.text)}</div>` : ''}`;
    const ext = src.startsWith('data:image/jpeg') ? 'jpg' : 'png';
    view.dispatch(closeHistory(view.state.tr));
    const tr = view.state.tr.setMeta(aiTargetKey, null);
    if (j.mode === 'image-edit') {
      const node = view.state.doc.nodeAt(t.from);
      if (!node || node.type !== schema.nodes.image) return void (status.textContent = '바꿀 그림을 찾지 못했습니다.');
      // 문서에 보이는 너비는 그대로, 높이는 새 그림 비율로
      tr.setNodeMarkup(t.from, undefined, { ...node.attrs, src, ext, height: Math.round((node.attrs.width * h) / w) });
      tr.setSelection(NodeSelection.create(tr.doc, t.from));
    } else {
      const maxW = host.textWidth() * 0.8;
      const dw = Math.min(maxW, w);
      tr.insert(t.from, schema.nodes.image.create({ src, ext, width: Math.round(dw * 75), height: Math.round(((dw * h) / w) * 75) }));
    }
    view.dispatch(tr.scrollIntoView());
    status.innerHTML = `<span class="ok">✓ ${j.mode === 'image-edit' ? '그림을 바꿨습니다.' : '그림을 넣었습니다.'}</span>${undoButton()}`;
  }

  api.onAgentEvent(async (ev) => {
    const j = job;
    if (!j || ev.id !== j.id) return;
    if (ev.kind === 'text') {
      j.text += ev.text;
      $(j.el, '.ai-text').textContent = j.text;
    } else if (ev.kind === 'step') {
      $(j.el, '.ai-steps').insertAdjacentHTML('beforeend', `<div>${ICONS.tool}<span>${esc(ev.text)}</span></div>`);
    } else if (ev.kind === 'error') {
      $(j.el, '.ai-status').innerHTML = `<span class="err">${esc(ev.text)}</span>`;
      finish(j);
    } else if (ev.kind === 'done') {
      try {
        await apply(j, ev);
      } catch (e) {
        $(j.el, '.ai-status').innerHTML = `<span class="err">넣지 못했습니다: ${esc((e as Error).message)}</span>`;
      }
      finish(j);
    }
    log.scrollTop = log.scrollHeight;
  });

  // ---------- 입력 ----------
  panel.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const b = t.closest('button') as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.engine) {
      engine = b.dataset.engine as Engine;
      localStorage.setItem('gyeol.agent.engine', engine);
      renderEngines();
    } else if (b.dataset.mode && !job) {
      mode = b.dataset.mode as AgentMode;
      manual = true;
      sync();
      input.focus();
    } else if (b.dataset.suggest) {
      input.value = b.dataset.suggest;
      input.focus();
    } else if (b === sendBtn) {
      if (job) api.agentCancel(job.id);
      else send(input.value);
    } else if (b.dataset.act === 'close') toggle(false);
    else if (b.dataset.act === 'rescan') loadEngines(true);
    else if (b.dataset.act === 'undo') {
      undo(view.state, view.dispatch);
      b.remove();
      view.focus();
    } else if (b.dataset.act === 'insert') {
      const text = b.closest('.ai-msg')?.querySelector('.ai-text')?.textContent ?? '';
      const { from, to } = view.state.selection;
      view.dispatch(replaceWithMarkdown(view.state.tr, from, to, text, host.textWidth() - 4).scrollIntoView());
      view.focus();
    }
  });
  // 패널 단추를 눌러도 본문 선택이 풀리지 않게
  panel.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });

  function toggle(open = panel.hidden) {
    panel.hidden = !open;
    document.body.classList.toggle('ai-open', open);
    if (open) {
      if (!engines.length) loadEngines();
      sync();
      input.focus();
    } else view.focus();
  }

  return {
    toggle,
    sync,
    /** 검증·시연용: 작업 종류를 정하고 지시를 보내 끝날 때까지 기다린다 */
    run: async (m: AgentMode | 'auto', instruction: string, eng?: Engine) => {
      if (panel.hidden) toggle(true);
      if (!engines.length) await loadEngines();
      if (eng) engine = eng;
      renderEngines();
      manual = m !== 'auto';
      mode = m === 'auto' ? autoMode(view.state) : m;
      sync();
      await send(instruction);
    },
    get busy() {
      return !!job;
    },
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('그림을 읽을 수 없습니다.'));
    img.src = src;
  });
}

/** 받은 그림 → 문서에 넣을 data: 주소(SVG·WebP 는 PNG 로 바꾼다) */
async function toDataUrl(bytes: Uint8Array, mime: string): Promise<{ src: string; w: number; h: number }> {
  const blobUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
  try {
    const img = await loadImage(blobUrl);
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const svg = mime === 'image/svg+xml';
    if (svg && (!w || !h)) [w, h] = [800, 600];
    if (!svg && (mime === 'image/png' || mime === 'image/jpeg')) {
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { src: `data:${mime};base64,${btoa(bin)}`, w, h };
    }
    // SVG 는 선명하게 2배로 그려 PNG 로
    const k = svg ? Math.min(2, 2400 / Math.max(w, h)) : 1;
    const c = document.createElement('canvas');
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    const ctx = c.getContext('2d')!;
    if (svg) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { src: c.toDataURL('image/png'), w, h };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
