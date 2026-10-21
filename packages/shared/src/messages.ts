/** Extension-internal messaging (popup / manager <-> service worker, content scripts -> service worker). */
import type { DownloadTask, DualStreamLayout, MediaItem, Settings } from './types.ts';

export interface NativeStatus {
  connected: boolean;
  version?: string;
  ffmpeg?: string;
  ffprobe?: string;
  platform?: string;
  defaultOutputDir?: string;
  error?: string;
}

export interface StartDownloadParams {
  itemId: string;
  qualityId?: string;
  audioId?: string;
  subtitleIds?: string[];
  container?: Settings['container'];
  /** Download every feed of a presentation group into one multi-track file. */
  mergeGroup?: boolean;
  /** Dual-stream layout for multi-track presentations (default: multi-track). */
  layout?: DualStreamLayout;
}

export type BgRequest =
  | { type: 'getState'; tabId?: number }
  | { type: 'refresh'; tabId: number }
  | { type: 'startDownload'; params: StartDownloadParams }
  | {
      type: 'taskAction';
      taskId: string;
      action: 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'open' | 'reveal';
    }
  | { type: 'clearCompleted' }
  | { type: 'getSettings' }
  | { type: 'setSettings'; settings: Partial<Settings> }
  | { type: 'nativeStatus' }
  | { type: 'diagnostics' };

export interface PopupState {
  tabId: number;
  tabTitle: string;
  tabUrl: string;
  items: MediaItem[];
  tasks: DownloadTask[];
  settings: Settings;
  native: NativeStatus;
  scanning: boolean;
}

export type BgResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export interface DomMediaReport {
  type: 'domMedia';
  pageTitle: string;
  pageUrl: string;
  media: { url: string; kind: 'video' | 'audio'; title?: string; duration?: number; poster?: string; blob?: boolean }[];
  ogTitle?: string;
}

export interface MediasiteReport {
  type: 'mediasiteOptions';
  pageUrl: string;
  payload: unknown;
}

export type ContentReport = DomMediaReport | MediasiteReport;
