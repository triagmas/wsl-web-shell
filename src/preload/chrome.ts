/** Minimal, explicit bridge for the app-owned footer bar. */
import { contextBridge, ipcRenderer } from 'electron';
import type { ShellStatus, VersionSnapshot } from '../shared/types.js';

export interface FooterAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

const api = {
  requestStatus(): Promise<ShellStatus> {
    return ipcRenderer.invoke('footer:status') as Promise<ShellStatus>;
  },
  requestVersions(): Promise<VersionSnapshot> {
    return ipcRenderer.invoke('footer:versions') as Promise<VersionSnapshot>;
  },
  onStatus(listener: (status: ShellStatus) => void): void {
    ipcRenderer.on('shell:status', (_event, status: ShellStatus) => listener(status));
  },
  onVersions(listener: (versions: VersionSnapshot) => void): void {
    ipcRenderer.on('footer:versions', (_event, versions: VersionSnapshot) => listener(versions));
  },
  toggleSettings(anchor: FooterAnchor): Promise<void> {
    return ipcRenderer.invoke('footer:toggle-settings', anchor) as Promise<void>;
  },
  /** Opens the update confirmation window (issue #12). */
  openUpdate(): Promise<void> {
    return ipcRenderer.invoke('footer:open-update') as Promise<void>;
  },
  /** Opens the upstream release page in the system browser, never in-app. */
  openRelease(): Promise<void> {
    return ipcRenderer.invoke('footer:open-release') as Promise<void>;
  },
};

contextBridge.exposeInMainWorld('footer', api);

export type FooterBridge = typeof api;
