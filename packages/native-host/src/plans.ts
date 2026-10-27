import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isAudioUrlOrMime, parseHls, parseMpd, pickQuality, sortQualities } from '@viddock/shared';
import type { DashRepresentation, HlsMedia, NativeTrack } from '@viddock/shared';
import { HttpClient, HttpError } from './http.ts';
import type { RangeSpec } from './http.ts';

export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface Part {
  url: string;
  range?: RangeSpec;
  dest: string;
  key?: { url: string; iv?: Buffer; seq: number };
  /** Large single-file part: resume with Range after interruption. */
  resume?: boolean;
}

export interface StreamPlan {
  id: string;
  kind: 'video' | 'audio' | 'muxed';
  /** Final assembled file for this stream. */
  file: string;
  parts: Part[];
  /** When true, parts[0].dest is already the assembled file. */
  direct?: boolean;
  durationSec?: number;
  label?: string;
}

export interface TrackPlan {
  label?: string;
  streams: StreamPlan[];
  durationSec?: number;
  /** True for a plain-file track whose original container can be kept as-is. */
  originalExt?: string;
}

export interface PlanContext {
  client: HttpClient;
  workDir: string;
  signal: AbortSignal;
  trackIndex: number;
}

const pad = (n: number) => String(n).padStart(6, '0');

function hexIv(iv: string | undefined): Buffer | undefined {
  if (!iv) return undefined;
  const hex = iv.replace(/^0x/i, '').padStart(32, '0');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new UserFacingError('Invalid HLS key IV', 'BAD_PLAYLIST');
  return Buffer.from(hex, 'hex');
}

export function defaultIv(seq: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(Math.floor(seq / 2 ** 32) >>> 0, 8);
  b.writeUInt32BE(seq >>> 0, 12);
  return b;
}

function mediaTypeExt(url: string, fallback: string): string {
  const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(new URL(url).pathname + '?');
  return m ? (m[1] as string).toLowerCase() : fallback;
}

async function planHlsMedia(url: string, kind: StreamPlan['kind'], id: string, ctx: PlanContext): Promise<StreamPlan> {
  const { text, finalUrl } = await ctx.client.getText(url, ctx.signal);
  const pl = parseHls(text, finalUrl);
  if (pl.type !== 'media')
    throw new UserFacingError('Expected a media playlist but found a master playlist', 'BAD_PLAYLIST');
  assertDownloadableHls(pl);
  const dir = path.join(ctx.workDir, `t${ctx.trackIndex}`, id);
  fs.mkdirSync(dir, { recursive: true });
  const parts: Part[] = [];
  let lastMap = '';
  let idx = 0;
  let hasMap = false;
  for (const seg of pl.segments) {
    if (seg.map) {
      hasMap = true;
      const mk = `${seg.map.url}|${seg.map.byteRange?.offset ?? ''}`;
      if (mk !== lastMap) {
        lastMap = mk;
        parts.push({ url: seg.map.url, range: seg.map.byteRange, dest: path.join(dir, `${pad(idx++)}.seg`) });
      }
    }
    const encrypted = seg.key && seg.key.method === 'AES-128' && seg.key.url;
    parts.push({
      url: seg.url,
      range: seg.byteRange,
      dest: path.join(dir, `${pad(idx++)}.seg`),
      key: encrypted ? { url: seg.key?.url as string, iv: hexIv(seg.key?.iv), seq: seg.seq } : undefined,
    });
  }
  const firstUrl = pl.segments[0]?.url ?? '';
  const ext = hasMap ? 'mp4' : /\.(aac|mp3|m4a|ac3|eac3)(\?|$)/i.test(firstUrl) ? mediaTypeExt(firstUrl, 'aac') : 'ts';
  return { id, kind, file: path.join(dir, `stream.${ext}`), parts, durationSec: pl.totalDuration };
}

export function assertDownloadableHls(pl: HlsMedia): void {
  if (pl.drm) throw new UserFacingError(`${pl.drm}. VidDock does not bypass DRM.`, 'DRM');
  if (pl.isLive) throw new UserFacingError('Live streams are not supported', 'LIVE');
  if (pl.segments.length === 0) throw new UserFacingError('Playlist contains no segments', 'BAD_PLAYLIST');
}

async function planHls(track: Extract<NativeTrack, { type: 'hls' }>, ctx: PlanContext): Promise<TrackPlan> {
  const { text, finalUrl } = await ctx.client.getText(track.url, ctx.signal);
  const pl = parseHls(text, finalUrl);
  if (pl.type === 'media') {
    const isAudio = /audio|mic|sound/i.test(track.label || '') || isAudioUrlOrMime(undefined, track.url);
    const s = await planHlsMedia(track.url, isAudio ? 'audio' : 'muxed', isAudio ? 'audio' : 'main', ctx);
    s.label = track.label;
    return { label: track.label, streams: [s], durationSec: s.durationSec };
  }
  if (pl.drm) throw new UserFacingError(`${pl.drm}. VidDock does not bypass DRM.`, 'DRM');
  let variant = pl.variants.find((v) => v.url === track.variantUrl);
  if (!variant) {
    if (track.variantUrl) {
      // Variant URL not listed (e.g. token changed): trust it but derive nothing.
      const s = await planHlsMedia(track.variantUrl, 'muxed', 'main', ctx);
      s.label = track.label;
      const streams = [s];
      let audioUrl = track.audioUrl;
      if (!audioUrl && pl.audio && pl.audio.length > 0) {
        const withUri = pl.audio.filter((a) => a.uri);
        audioUrl = (withUri.find((a) => a.isDefault) ?? withUri.find((a) => a.autoselect) ?? withUri[0])?.uri;
      }
      if (audioUrl) {
        const audioPlan = await planHlsMedia(audioUrl, 'audio', 'audio', ctx);
        audioPlan.label = 'Audio';
        streams.push(audioPlan);
      }
      streams[0]!.kind = audioUrl ? 'video' : 'muxed';
      return { label: track.label, streams, durationSec: s.durationSec };
    }
    const best = pickQuality(
      pl.variants.map((v) => ({ ...v })),
      'best',
    );
    variant = best;
  }
  if (!variant) throw new UserFacingError('Master playlist has no variants', 'BAD_PLAYLIST');
  let audioUrl = track.audioUrl;
  if (!audioUrl && variant.audioGroup) {
    const group = pl.audio.filter((a) => a.groupId === variant?.audioGroup && a.uri);
    audioUrl = (group.find((a) => a.isDefault) ?? group.find((a) => a.autoselect) ?? group[0])?.uri;
  }
  if (!audioUrl && pl.audio && pl.audio.length > 0) {
    const withUri = pl.audio.filter((a) => a.uri);
    audioUrl = (withUri.find((a) => a.isDefault) ?? withUri.find((a) => a.autoselect) ?? withUri[0])?.uri;
  }
  const video = await planHlsMedia(variant.url, audioUrl ? 'video' : 'muxed', 'main', ctx);
  video.label = track.label;
  const streams: StreamPlan[] = [video];
  if (audioUrl) {
    const audioPlan = await planHlsMedia(audioUrl, 'audio', 'audio', ctx);
    audioPlan.label = 'Audio';
    streams.push(audioPlan);
  }
  return { label: track.label, streams, durationSec: video.durationSec };
}

function parseRange(r: string | undefined): RangeSpec | undefined {
  const m = /^(\d+)-(\d+)$/.exec(r ?? '');
  if (!m) return undefined;
  const a = Number(m[1]);
  return { offset: a, length: Number(m[2]) - a + 1 };
}

function dashStream(
  rep: DashRepresentation,
  kind: 'video' | 'audio',
  id: string,
  ctx: PlanContext,
  label?: string,
): StreamPlan {
  const dir = path.join(ctx.workDir, `t${ctx.trackIndex}`, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'stream.mp4');
  if (rep.singleFile) {
    return { id, kind, file, direct: true, label, parts: [{ url: rep.singleFile, dest: file, resume: true }] };
  }
  const parts: Part[] = [];
  let idx = 0;
  if (rep.init)
    parts.push({ url: rep.init, range: parseRange(rep.initRange), dest: path.join(dir, `${pad(idx++)}.seg`) });
  for (const s of rep.segments) {
    parts.push({ url: s.url, range: parseRange(s.range), dest: path.join(dir, `${pad(idx++)}.seg`) });
  }
  if (rep.segments.length === 0) throw new UserFacingError(`Representation ${rep.id} has no segments`, 'BAD_MANIFEST');
  return { id, kind, file, label, parts, durationSec: rep.segments.reduce((s, x) => s + x.duration, 0) };
}

async function planDash(track: Extract<NativeTrack, { type: 'dash' }>, ctx: PlanContext): Promise<TrackPlan> {
  const { text, finalUrl } = await ctx.client.getText(track.url, ctx.signal);
  let mpd;
  try {
    mpd = parseMpd(text, finalUrl);
  } catch (e) {
    throw new UserFacingError((e as Error).message, 'BAD_MANIFEST');
  }
  if (mpd.drm) throw new UserFacingError(`${mpd.drm}. VidDock does not bypass DRM.`, 'DRM');
  if (mpd.isLive) throw new UserFacingError('Live streams are not supported', 'LIVE');
  if (mpd.periods.length !== 1)
    throw new UserFacingError('Multi-period manifests are not supported yet', 'UNSUPPORTED');
  const adaptations = mpd.periods[0]?.adaptations ?? [];
  const videoReps = adaptations.filter((a) => a.contentType === 'video').flatMap((a) => a.representations);
  const audioReps = adaptations.filter((a) => a.contentType === 'audio').flatMap((a) => a.representations);

  const streams: StreamPlan[] = [];
  let video: DashRepresentation | undefined;
  if (videoReps.length > 0) {
    video = track.videoRepId ? videoReps.find((r) => r.id === track.videoRepId) : sortQualities(videoReps)[0];
    if (!video)
      throw new UserFacingError(`Video representation "${track.videoRepId}" not found in manifest`, 'BAD_MANIFEST');
  }
  let audio: DashRepresentation | undefined;
  if (track.audioRepId) {
    audio = audioReps.find((r) => r.id === track.audioRepId);
    if (!audio)
      throw new UserFacingError(`Audio representation "${track.audioRepId}" not found in manifest`, 'BAD_MANIFEST');
  } else if (audioReps.length > 0) {
    audio = [...audioReps].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  }
  if (!video && !audio) throw new UserFacingError('Manifest has no downloadable representations', 'BAD_MANIFEST');
  if (video) streams.push(dashStream(video, 'video', 'video', ctx, track.label));
  if (audio) streams.push(dashStream(audio, 'audio', 'audio', ctx, track.label || 'Audio'));
  return { label: track.label, streams, durationSec: mpd.durationSec || streams[0]?.durationSec };
}

function planDirect(track: Extract<NativeTrack, { type: 'direct' }>, ctx: PlanContext): TrackPlan {
  const ext = mediaTypeExt(track.url, 'mp4');
  const safeExt = /^(mp4|m4v|mov|webm|mkv|ogv|mp3|m4a|aac|ogg|oga|opus|flac|wav)$/.test(ext) ? ext : 'mp4';
  const isAudioExt = /^(mp3|m4a|aac|ogg|oga|opus|flac|wav)$/.test(safeExt);
  const isAudio = isAudioExt || /audio|mic|sound/i.test(track.label || '');
  const dir = path.join(ctx.workDir, `t${ctx.trackIndex}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `direct.${safeExt}`);
  return {
    label: track.label,
    originalExt: safeExt,
    streams: [
      {
        id: 'main',
        kind: isAudio ? 'audio' : 'muxed',
        file,
        direct: true,
        label: track.label,
        parts: [{ url: track.url, dest: file, resume: true }],
      },
    ],
  };
}

export async function planTrack(track: NativeTrack, ctx: PlanContext): Promise<TrackPlan> {
  switch (track.type) {
    case 'hls':
      return planHls(track, ctx);
    case 'dash':
      return planDash(track, ctx);
    case 'direct':
      return planDirect(track, ctx);
  }
}

/** Decrypt an AES-128-CBC HLS segment. */
export function decryptSegment(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([d.update(data), d.final()]);
  } catch (e) {
    throw new HttpError(`Segment decryption failed: ${(e as Error).message}`, undefined, 'DECRYPT', false);
  }
}

/** Concatenate downloaded parts into the stream file. */
export async function assembleStream(stream: StreamPlan): Promise<void> {
  if (stream.direct) return;
  const tmp = `${stream.file}.assembling`;
  const out = fs.createWriteStream(tmp);
  try {
    for (const part of stream.parts) {
      await pipeline(fs.createReadStream(part.dest), out, { end: false });
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    if ((e as { code?: string }).code === 'ENOSPC')
      throw new UserFacingError('Disk is full while assembling the download', 'DISK_FULL');
    throw e;
  }
  fs.renameSync(tmp, stream.file);
}
