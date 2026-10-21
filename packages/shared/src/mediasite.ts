/**
 * Mediasite presentation metadata.
 *
 * The Mediasite player calls `PlayerService.svc/json/GetPlayerOptions`; the JSON reply carries
 * `Presentation.Title`, `Presentation.Duration` (ms) and `Presentation.Streams[].VideoUrls[]`
 * (`Location` + `MimeType`). Field names vary slightly between releases, so parsing is tolerant.
 * Smooth-Streaming locations (`.ism/manifest`) cannot be downloaded directly; we derive an HLS URL
 * (`(format=m3u8-aapl)`) which the extension verifies by fetching before offering it.
 */
import type { MediaKind } from './types.ts';
import { parseUrl } from './url.ts';

export interface MediasiteMediaUrl {
  url: string;
  mimeType: string;
  kind: MediaKind | 'smooth';
  /** Derived (unverified) alternative URL, e.g. HLS for a Smooth Streaming manifest. */
  derivedHls?: string;
}

export interface MediasiteStream {
  index: number;
  streamType?: number;
  label: string;
  urls: MediasiteMediaUrl[];
  /** True when the stream is only slide images (no downloadable video). */
  slidesOnly: boolean;
}

export interface MediasiteCaption {
  url: string;
  language?: string;
  label: string;
}

export interface MediasitePresentation {
  title: string;
  durationSec?: number;
  presenters: string[];
  streams: MediasiteStream[];
  captions: MediasiteCaption[];
  presentationId?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function isMediasiteUrl(url: string): boolean {
  const u = parseUrl(url);
  return !!u && /\/mediasite\//i.test(u.pathname);
}

export function mediasitePresentationId(url: string): string | undefined {
  const u = parseUrl(url);
  if (!u) return undefined;
  const m = /\/Play\/([0-9a-f]{32}[0-9a-f]*)/i.exec(u.pathname);
  return m?.[1];
}

export function kindFromMime(mime: string, url: string): MediaKind | 'smooth' | undefined {
  const m = mime.toLowerCase();
  if (/mpegurl/.test(m) || /\.m3u8(\?|$)/i.test(url)) return 'hls';
  if (m === 'application/dash+xml' || /\.mpd(\?|$)/i.test(url)) return 'dash';
  if (/ms-sstr/.test(m) || /\.ism\/manifest/i.test(url)) return 'smooth';
  if (m.startsWith('video/') || m.startsWith('audio/') || /\.(mp4|m4v|webm|mov)(\?|$)/i.test(url)) return 'direct';
  return undefined;
}

export function deriveHlsFromSmooth(url: string): string {
  const base = url.replace(/\(format=[^)]*\)/i, '').replace(/\/manifest[^/]*$/i, '/manifest');
  return `${base}(format=m3u8-aapl)`;
}

function streamLabel(index: number, total: number, streamType: number | undefined, slides: boolean): string {
  if (slides) return 'Slides';
  if (total <= 1) return 'Presentation video';
  if (index === 0) return 'Primary video';
  return `Secondary video (stream ${index + 1}${streamType !== undefined ? `, type ${streamType}` : ''})`;
}

export function parsePlayerOptions(json: unknown, _pageUrl = ''): MediasitePresentation | undefined {
  const root: any = (json as any)?.d ?? json;
  const pres: any = root?.Presentation;
  if (!pres || typeof pres !== 'object') return undefined;

  const rawStreams: any[] = Array.isArray(pres.Streams) ? pres.Streams : [];
  const streams: MediasiteStream[] = [];
  rawStreams.forEach((s, i) => {
    const urls: MediasiteMediaUrl[] = [];
    for (const v of Array.isArray(s?.VideoUrls) ? s.VideoUrls : []) {
      const loc = typeof v?.Location === 'string' ? v.Location : undefined;
      if (!loc || !parseUrl(loc)) continue;
      const mime = String(v?.MimeType ?? '');
      const kind = kindFromMime(mime, loc);
      if (!kind) continue;
      urls.push({
        url: loc,
        mimeType: mime,
        kind,
        derivedHls: kind === 'smooth' ? deriveHlsFromSmooth(loc) : undefined,
      });
    }
    const hasSlides = Array.isArray(s?.Slides) && s.Slides.length > 0;
    const slidesOnly = urls.length === 0 && hasSlides;
    if (urls.length === 0 && !slidesOnly) return;
    streams.push({
      index: i,
      streamType: typeof s?.StreamType === 'number' ? s.StreamType : undefined,
      label: '',
      urls,
      slidesOnly,
    });
  });
  const videoStreams = streams.filter((s) => !s.slidesOnly);
  videoStreams.forEach((s, i) => {
    s.label = streamLabel(i, videoStreams.length, s.streamType, false);
  });
  streams.filter((s) => s.slidesOnly).forEach((s) => (s.label = 'Slides'));

  const captions: MediasiteCaption[] = [];
  for (const t of Array.isArray(pres.Transcripts) ? pres.Transcripts : []) {
    const url = typeof t?.Url === 'string' ? t.Url : typeof t?.Location === 'string' ? t.Location : undefined;
    if (url && parseUrl(url)) {
      captions.push({ url, language: t?.Language ?? t?.LanguageCode, label: t?.Name ?? t?.Language ?? 'Captions' });
    }
  }

  const presenters: string[] = [];
  for (const p of Array.isArray(pres.Presenters) ? pres.Presenters : []) {
    const name = [p?.FirstName, p?.LastName].filter(Boolean).join(' ') || p?.DisplayName;
    if (name) presenters.push(String(name));
  }

  const title = String(pres.Title ?? '').trim();
  const dur = Number(pres.Duration);
  return {
    title: title || 'Mediasite presentation',
    durationSec: Number.isFinite(dur) && dur > 0 ? dur / 1000 : undefined,
    presenters,
    streams,
    captions,
    presentationId: typeof pres.Id === 'string' ? pres.Id : undefined,
  };
}
