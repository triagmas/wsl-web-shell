/** Minimal, explicit bridge for the manual update window (issue #12). */
import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateProbe, UpdateRunResult } from '../shared/types.js';

const api = {
  /** Installed and published versions plus the commands the owner runs. */
  probe(): Promise<UpdateProbe> {
    return ipcRenderer.invoke('update:probe') as Promise<UpdateProbe>;
  },
  /** Same read-only inspection again, after the owner ran a command. */
  recheck(): Promise<UpdateProbe> {
    return ipcRenderer.invoke('update:recheck') as Promise<UpdateProbe>;
  },
  /**
   * Runs the shown commands in one visible WSL console, then reports the result.
   *
   * The one channel that executes anything; it refuses plans that are copy-only.
   */
  run(): Promise<UpdateRunResult> {
    return ipcRenderer.invoke('update:run') as Promise<UpdateRunResult>;
  },
  /** Closes the window that sent it. */
  close(): Promise<void> {
    return ipcRenderer.invoke('update:close') as Promise<void>;
  },
};

contextBridge.exposeInMainWorld('update', api);

export type UpdateBridge = typeof api;
