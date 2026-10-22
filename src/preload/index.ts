import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AgentEvent, AgentRequest, EngineInfo } from '../main/agent';

export type { AgentEvent, AgentMode, AgentRequest, Engine, EngineInfo } from '../main/agent';

export interface OpenedFile {
  path: string;
  name: string;
  bytes: Uint8Array;
}

const api = {
  openDialog: () => ipcRenderer.invoke('file:open-dialog'),
  openPaths: (paths: string[]) => ipcRenderer.invoke('file:open-paths', paths),
  // 끌어다 놓은 파일의 실제 경로(Electron 32 부터 File.path 가 없어졌다)
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  save: (args: { path?: string; suggested: string; bytes: Uint8Array; saveAs?: boolean }): Promise<{ path: string; name: string } | null> =>
    ipcRenderer.invoke('file:save', args),
  exportPdf: (args: { suggested: string; widthIn: number; heightIn: number; landscape: boolean }): Promise<string | null> =>
    ipcRenderer.invoke('file:export-pdf', args),
  print: () => ipcRenderer.invoke('file:print'),
  confirmDiscard: (name: string): Promise<'save' | 'discard' | 'cancel'> => ipcRenderer.invoke('app:confirm-discard', name),
  closeOk: () => ipcRenderer.send('app:close-ok'),
  setTitle: (title: string, edited: boolean, path?: string) => ipcRenderer.send('app:set-title', title, edited, path),
  newWindow: () => ipcRenderer.send('app:new-window'),
  onOpened: (cb: (f: OpenedFile) => void) => ipcRenderer.on('file:opened', (_e, f) => cb(f)),
  onMenu: (cb: (id: string) => void) => ipcRenderer.on('menu', (_e, id) => cb(id)),
  onRequestClose: (cb: () => void) => ipcRenderer.on('app:request-close', () => cb()),
  // AI 도우미(설치된 claude·codex 명령)
  agentEngines: (force?: boolean): Promise<EngineInfo[]> => ipcRenderer.invoke('agent:engines', force),
  agentRun: (req: AgentRequest) => ipcRenderer.invoke('agent:run', req),
  agentCancel: (id: string) => ipcRenderer.invoke('agent:cancel', id),
  onAgentEvent: (cb: (e: AgentEvent) => void) => ipcRenderer.on('agent:event', (_e, ev) => cb(ev)),
};

export type GyeolApi = typeof api;
contextBridge.exposeInMainWorld('gyeol', api);
