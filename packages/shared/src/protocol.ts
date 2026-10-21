/** Native-messaging protocol and strict request validation (shared by both sides). */
import type {
  Container,
  DownloadOptions,
  NativeDownloadRequest,
  NativeSubtitle,
  NativeTrack,
  RequestHeaders,
  TaskInfo,
} from './types.ts';
import { isHttpUrl, isSafeHeaderValue } from './url.ts';

export const NATIVE_HOST_NAME = 'com.viddock.host';
export const PROTOCOL_VERSION = 1;

export type HostRequest =
  | { type: 'hello'; id: string }
  | { type: 'download.start'; id: string; request: NativeDownloadRequest }
  | { type: 'download.pause' | 'download.resume' | 'download.cancel' | 'download.remove'; id: string; taskId: string }
  | { type: 'file.open' | 'file.reveal'; id: string; path: string }
  | { type: 'config'; id: string; maxSimultaneous: number }
  | { type: 'diagnostics'; id: string }
  | { type: 'tasks.list'; id: string };

export type HostMessage =
  | { type: 'reply'; id: string; ok: true; data?: unknown }
  | { type: 'reply'; id: string; ok: false; error: string; code?: string }
  | { type: 'task.update'; task: TaskInfo };

export interface HelloData {
  protocol: number;
  version: string;
  platform: string;
  ffmpeg?: string;
  ffprobe?: string;
  defaultOutputDir: string;
}

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_URL = 8192;

function fail(msg: string): never {
  throw new Error(`Invalid request: ${msg}`);
}

function str(v: unknown, name: string, max = 1000): string {
  if (typeof v !== 'string') fail(`${name} must be a string`);
  if (v.length > max) fail(`${name} too long`);
  return v;
}

function url(v: unknown, name: string): string {
  const s = str(v, name, MAX_URL);
  if (!isHttpUrl(s)) fail(`${name} must be an http(s) URL`);
  return s;
}

function int(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(`${name} must be an integer ${min}..${max}`);
  return v;
}

function validateHeaders(h: unknown): RequestHeaders {
  if (h === undefined || h === null) return {};
  if (typeof h !== 'object') fail('headers must be an object');
  const o = h as Record<string, unknown>;
  const out: RequestHeaders = {};
  for (const key of ['cookie', 'referer', 'userAgent'] as const) {
    const v = o[key];
    if (v === undefined) continue;
    const s = str(v, `headers.${key}`, 16384);
    if (!isSafeHeaderValue(s)) fail(`headers.${key} contains illegal characters`);
    out[key] = s;
  }
  return out;
}

function validateTrack(t: unknown, i: number): NativeTrack {
  if (!t || typeof t !== 'object') fail(`tracks[${i}] invalid`);
  const o = t as Record<string, unknown>;
  const label = o.label === undefined ? undefined : str(o.label, 'label', 200);
  switch (o.type) {
    case 'hls':
      return {
        type: 'hls',
        url: url(o.url, 'track.url'),
        variantUrl: o.variantUrl === undefined ? undefined : url(o.variantUrl, 'track.variantUrl'),
        audioUrl: o.audioUrl === undefined ? undefined : url(o.audioUrl, 'track.audioUrl'),
        label,
      };
    case 'dash':
      return {
        type: 'dash',
        url: url(o.url, 'track.url'),
        videoRepId: o.videoRepId === undefined ? undefined : str(o.videoRepId, 'videoRepId', 200),
        audioRepId: o.audioRepId === undefined ? undefined : str(o.audioRepId, 'audioRepId', 200),
        label,
      };
    case 'direct':
      return { type: 'direct', url: url(o.url, 'track.url'), label };
    default:
      return fail(`tracks[${i}].type unsupported`);
  }
}

export function validateDownloadRequest(input: unknown): NativeDownloadRequest {
  if (!input || typeof input !== 'object') fail('request must be an object');
  const r = input as Record<string, unknown>;
  const taskId = str(r.taskId, 'taskId', 64);
  if (!TASK_ID.test(taskId)) fail('taskId has illegal characters');
  const container = r.container as Container;
  if (!['auto', 'mp4', 'mkv', 'webm'].includes(container)) fail('container unsupported');
  if (!Array.isArray(r.tracks) || r.tracks.length < 1 || r.tracks.length > 8) fail('tracks must have 1..8 entries');
  const subs: unknown[] = Array.isArray(r.subtitles) ? r.subtitles : [];
  if (subs.length > 32) fail('too many subtitles');
  const subtitles: NativeSubtitle[] = subs.map((s, i) => {
    if (!s || typeof s !== 'object') fail(`subtitles[${i}] invalid`);
    const o = s as Record<string, unknown>;
    return {
      url: url(o.url, 'subtitle.url'),
      language: o.language === undefined ? undefined : str(o.language, 'language', 35),
      label: o.label === undefined ? undefined : str(o.label, 'label', 200),
    };
  });
  const subtitleMode = (r.subtitleMode ?? 'none') as NativeDownloadRequest['subtitleMode'];
  if (!['none', 'separate', 'embed'].includes(subtitleMode)) fail('subtitleMode unsupported');
  const o = (r.options ?? {}) as Record<string, unknown>;
  const options: DownloadOptions = {
    segmentConcurrency: int(o.segmentConcurrency ?? 6, 'segmentConcurrency', 1, 32),
    maxRetries: int(o.maxRetries ?? 5, 'maxRetries', 0, 20),
    retryBaseMs: int(o.retryBaseMs ?? 1000, 'retryBaseMs', 0, 60_000),
  };
  let expectedDurationSec: number | undefined;
  if (r.expectedDurationSec !== undefined) {
    if (typeof r.expectedDurationSec !== 'number' || !(r.expectedDurationSec >= 0) || r.expectedDurationSec > 1e6)
      fail('expectedDurationSec invalid');
    expectedDurationSec = r.expectedDurationSec;
  }
  return {
    taskId,
    title: str(r.title ?? '', 'title', 500),
    fileName: str(r.fileName, 'fileName', 500),
    outputDir: r.outputDir === undefined || r.outputDir === '' ? undefined : str(r.outputDir, 'outputDir', 1024),
    container,
    tracks: r.tracks.map(validateTrack),
    subtitles,
    subtitleMode,
    headers: validateHeaders(r.headers),
    options,
    expectedDurationSec,
  };
}

export function isHostRequest(m: unknown): m is HostRequest {
  return !!m && typeof m === 'object' && typeof (m as { type?: unknown }).type === 'string' && typeof (m as { id?: unknown }).id === 'string';
}
