import { contextBridge, ipcRenderer } from 'electron';

export interface OpenedFile {
  path: string;
  name: string;
  bytes: Uint8Array;
}

const api = {
  openDialog: () => ipcRenderer.invoke('file:open-dialog'),
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
};

export type GyeolApi = typeof api;
contextBridge.exposeInMainWorld('gyeol', api);
