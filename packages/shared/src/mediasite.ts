/**
 * Mediasite presentation metadata.
 *
 * The Mediasite player calls `PlayerService.svc/json/GetPlayerOptions`; the JSON reply carries
 * `Presentation.Title`, `Presentation.Duration` (ms) and `Presentation.Streams[].VideoUrls[]`
 * (`Location` + `MimeType`). Field names vary slightly between releases, so parsing is tolerant.
 * Smooth-Streaming locations (`.ism/manifest`) cannot be downloaded directly; we derive an HLS URL
 * (`(format=m3u8-aapl)`) which the extension verifies by fetching before offering it.
 */
import type {
  DualStreamLayout,
  MediaKind,
  MediasiteCaption,
  MediasiteMediaUrl,
  MediasitePresentation,
  MediasiteSlide,
  MediasiteStream,
} from './types.ts';
import { parseUrl } from './url.ts';

export type {
  DualStreamLayout,
  MediasiteCaption,
  MediasiteMediaUrl,
  MediasitePresentation,
  MediasiteSlide,
  MediasiteStream,
};

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

function parseSlide(raw: any, defaultIndex: number, pageUrl: string): MediasiteSlide | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const rawTitle = raw.Title ?? raw.SlideTitle ?? raw.Name ?? raw.Description ?? raw.Text;
  const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : undefined;

  const rawTime = raw.Time ?? raw.Timestamp ?? raw.TimeMs ?? raw.PresentationTime ?? raw.StartTime ?? raw.Offset ?? 0;
  const numTime = Number(rawTime);
  const timeMs = Number.isFinite(numTime) && numTime >= 0 ? Math.round(numTime) : 0;
  const timeSec = Number((timeMs / 1000).toFixed(3));

  const rawThumb =
    raw.ThumbnailUrl ??
    raw.Thumbnail ??
    raw.ThumbnailLocation ??
    raw.Url ??
    raw.ImageUrl ??
    raw.Location ??
    raw.ContentUrl ??
    raw.Image;

  let thumbnailUrl: string | undefined;
  if (typeof rawThumb === 'string' && rawThumb.trim()) {
    const trimmed = rawThumb.trim();
    if (parseUrl(trimmed)) {
      thumbnailUrl = trimmed;
    } else if (pageUrl) {
      const resolved = parseUrl(trimmed, pageUrl);
      thumbnailUrl = resolved ? resolved.toString() : trimmed;
    } else {
      thumbnailUrl = trimmed;
    }
  }

  const rawIndex = raw.Index ?? raw.SlideIndex ?? raw.SlideNumber;
  const numIndex = Number(rawIndex);
  const index = Number.isInteger(numIndex) && numIndex >= 0 ? numIndex : defaultIndex;

  return { index, title, timeMs, timeSec, thumbnailUrl };
}

export function parsePlayerOptions(json: unknown, pageUrl = ''): MediasitePresentation | undefined {
  const root: any = (json as any)?.d ?? json;
  const pres: any = root?.Presentation;
  if (!pres || typeof pres !== 'object') return undefined;

  const rawStreams: any[] = Array.isArray(pres.Streams) ? pres.Streams : [];
  const streams: MediasiteStream[] = [];
  const rawSlideSets: any[][] = [];

  if (Array.isArray(pres.Slides)) {
    rawSlideSets.push(pres.Slides);
  }

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

    let streamSlides: MediasiteSlide[] | undefined;
    if (Array.isArray(s?.Slides)) {
      rawSlideSets.push(s.Slides);
      streamSlides = s.Slides.map((slideRaw: any, idx: number) => parseSlide(slideRaw, idx, pageUrl)).filter(
        (sl: MediasiteSlide | undefined): sl is MediasiteSlide => !!sl,
      );
    }

    const hasSlides = !!(streamSlides && streamSlides.length > 0);
    const slidesOnly = urls.length === 0 && hasSlides;
    if (urls.length === 0 && !slidesOnly) return;

    streams.push({
      index: i,
      streamType: typeof s?.StreamType === 'number' ? s.StreamType : undefined,
      label: '',
      urls,
      slidesOnly,
      slides: streamSlides,
    });
  });

  const videoStreams = streams.filter((s) => !s.slidesOnly);
  videoStreams.forEach((s, i) => {
    s.label = streamLabel(i, videoStreams.length, s.streamType, false);
  });
  streams.filter((s) => s.slidesOnly).forEach((s) => (s.label = 'Slides'));

  // Collect, deduplicate, and sort all presentation slides
  const collectedSlides: MediasiteSlide[] = [];
  for (const set of rawSlideSets) {
    for (const item of set) {
      const parsed = parseSlide(item, collectedSlides.length, pageUrl);
      if (parsed) collectedSlides.push(parsed);
    }
  }

  const uniqueSlides: MediasiteSlide[] = [];
  const seen = new Set<string>();
  for (const sl of collectedSlides) {
    const key = `${sl.timeMs}|${sl.thumbnailUrl ?? ''}|${sl.title ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueSlides.push(sl);
    }
  }

  uniqueSlides.sort((a, b) => a.timeMs - b.timeMs);
  uniqueSlides.forEach((sl, i) => {
    sl.index = i;
  });

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
    slides: uniqueSlides,
    captions,
    presentationId: typeof pres.Id === 'string' ? pres.Id : undefined,
  };
}
