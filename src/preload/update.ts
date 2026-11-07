/** Minimal, explicit bridge for the update windows (issue #12). */
import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateProbe, UpdateStartResult } from '../shared/types.js';
import type { UpdateState } from '../main/core/update.js';

const api = {
  /** What the confirmation window shows: versions, distribution, runtime. */
  probe(): Promise<UpdateProbe> {
    return ipcRenderer.invoke('update:probe') as Promise<UpdateProbe>;
  },
  /** Starts the accepted plan. Output arrives on `onState`. */
  start(): Promise<UpdateStartResult> {
    return ipcRenderer.invoke('update:start') as Promise<UpdateStartResult>;
  },
  /** Current state, so a late window still renders the running update. */
  state(): Promise<UpdateState> {
    return ipcRenderer.invoke('update:state') as Promise<UpdateState>;
  },
  onState(listener: (state: UpdateState) => void): void {
    ipcRenderer.on('update:state', (_event, state: UpdateState) => listener(state));
  },
  /** Closes the window that sent it (confirmation or finished progress). */
  close(): Promise<void> {
    return ipcRenderer.invoke('update:close') as Promise<void>;
  },
};

contextBridge.exposeInMainWorld('update', api);

export type UpdateBridge = typeof api;
