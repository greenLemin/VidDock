/** Core domain types shared by the extension and the native companion. */

export type MediaKind = 'direct' | 'hls' | 'dash';

export interface Quality {
  /** Stable identifier within a MediaItem. */
  id: string;
  label: string;
  height?: number;
  width?: number;
  bandwidth?: number;
  codecs?: string;
  frameRate?: number;
  /** HLS variant playlist URL (absolute) or DASH representation id. */
  ref: string;
  /** HLS: audio group the variant references (if any). */
  audioGroup?: string;
  sizeBytes?: number;
}

export interface AudioTrack {
  id: string;
  label: string;
  language?: string;
  /** HLS media-playlist URL or DASH representation id. */
  ref: string;
  groupId?: string;
  isDefault?: boolean;
  bandwidth?: number;
}

export interface SubtitleTrack {
  id: string;
  label: string;
  language?: string;
  url: string;
  format: 'vtt' | 'srt' | 'ttml' | 'unknown';
}

export type MediaSource = 'network' | 'dom' | 'mediasite';

export interface MediaItem {
  id: string;
  tabId: number;
  kind: MediaKind;
  /** Manifest URL (hls/dash) or file URL (direct). */
  url: string;
  title: string;
  pageUrl: string;
  durationSec?: number;
  qualities: Quality[];
  audioTracks: AudioTrack[];
  subtitles: SubtitleTrack[];
  mimeType?: string;
  sizeBytes?: number;
  thumbnail?: string;
  source: MediaSource;
  /** Items belonging to the same presentation (e.g. Mediasite) share a group id. */
  groupId?: string;
  /** Human label for multi-feed presentations, e.g. "Primary video". */
  trackLabel?: string;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Set when VidDock cannot download this stream (DRM, live, ...). */
  unsupportedReason?: string;
  detectedAt: number;
}

export type TaskState =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'processing'
  | 'verifying'
  | 'completed'
  | 'paused'
  | 'failed'
  | 'cancelled';

export interface TaskProgress {
  bytesDownloaded: number;
  totalBytes?: number;
  bytesPerSec: number;
  segmentsDone: number;
  segmentsTotal: number;
  /** 0..100 */
  percent: number;
  stage?: string;
  elapsedMs: number;
  etaMs?: number;
}

export interface TaskInfo {
  id: string;
  title: string;
  state: TaskState;
  progress: TaskProgress;
  outputPath?: string;
  outputBytes?: number;
  error?: string;
  errorCode?: string;
  warnings?: string[];
  createdAt: number;
  updatedAt: number;
}

/** A task as tracked by the extension (may be backed by Chrome downloads or the native host). */
export interface DownloadTask extends TaskInfo {
  engine: 'chrome' | 'native';
  kind: MediaKind;
  sourceUrl: string;
  pageUrl: string;
  qualityLabel?: string;
  /** Chrome download id, when engine === 'chrome'. */
  chromeDownloadId?: number;
  /** Request stored for resume/retry (never includes credentials). */
  request?: NativeDownloadRequest;
}

export type Container = 'auto' | 'mp4' | 'mkv' | 'webm';

export interface RequestHeaders {
  cookie?: string;
  referer?: string;
  userAgent?: string;
}

export interface DownloadOptions {
  segmentConcurrency: number;
  maxRetries: number;
  retryBaseMs: number;
}

export type NativeTrack =
  | {
      type: 'hls';
      /** Master or media playlist URL. */
      url: string;
      /** Selected variant playlist URL (absolute), when `url` is a master playlist. */
      variantUrl?: string;
      /** Selected separate audio playlist URL. */
      audioUrl?: string;
      label?: string;
    }
  | {
      type: 'dash';
      url: string;
      videoRepId?: string;
      audioRepId?: string;
      label?: string;
    }
  | { type: 'direct'; url: string; label?: string };

export interface NativeSubtitle {
  url: string;
  language?: string;
  label?: string;
}

export interface NativeDownloadRequest {
  taskId: string;
  title: string;
  /** Base file name without extension. Sanitized again by the host. */
  fileName: string;
  /** Output directory; the host restricts this to the user's home directory. */
  outputDir?: string;
  container: Container;
  tracks: NativeTrack[];
  subtitles: NativeSubtitle[];
  subtitleMode: 'none' | 'separate' | 'embed';
  headers: RequestHeaders;
  options: DownloadOptions;
  expectedDurationSec?: number;
}

export interface Settings {
  preferredQuality: 'best' | 1080 | 720 | 480 | 360;
  container: Container;
  filenameTemplate: string;
  maxSimultaneous: number;
  segmentConcurrency: number;
  maxRetries: number;
  retryBaseMs: number;
  notifications: boolean;
  theme: 'system' | 'light' | 'dark';
  subtitleMode: 'none' | 'separate' | 'embed';
  outputDir: string;
  /** Use Chrome's download manager for plain files instead of the companion. */
  directViaChrome: boolean;
  /** Minimum size for network-detected plain media files (bytes). */
  minDirectBytes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  preferredQuality: 'best',
  container: 'auto',
  filenameTemplate: '{title}',
  maxSimultaneous: 3,
  segmentConcurrency: 6,
  maxRetries: 5,
  retryBaseMs: 1000,
  notifications: true,
  theme: 'system',
  subtitleMode: 'separate',
  outputDir: '',
  directViaChrome: true,
  minDirectBytes: 262144,
};
