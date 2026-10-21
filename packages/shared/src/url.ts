/** URL helpers and stream classification. */

export type UrlClass =
  | { type: 'hls' }
  | { type: 'dash' }
  | { type: 'direct'; audioOnly: boolean; ext: string }
  | { type: 'subtitle' }
  | { type: 'segment' }
  | { type: 'ignore' };

const DIRECT_VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv']);
const DIRECT_AUDIO_EXT = new Set(['mp3', 'm4a', 'ogg', 'oga', 'opus', 'flac', 'wav', 'aac']);
const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'fmp4', 'key', 'vtt-seg']);
const VOLATILE_PARAMS = new Set([
  'token',
  'sig',
  'signature',
  'expires',
  'expire',
  'exp',
  'e',
  'st',
  'hdnts',
  'hmac',
  'policy',
  'key-pair-id',
  '__gda__',
  'range',
  'bytestart',
  'byteend',
  't',
  'ts',
  'timestamp',
  'cb',
  'rand',
  'nocache',
]);

const AD_HOST_PATTERNS = [
  /(^|\.)doubleclick\.net$/,
  /(^|\.)googlesyndication\.com$/,
  /(^|\.)googleadservices\.com$/,
  /(^|\.)imasdk\.googleapis\.com$/,
  /(^|\.)moatads\.com$/,
  /(^|\.)scorecardresearch\.com$/,
  /(^|\.)adnxs\.com$/,
  /(^|\.)adsrvr\.org$/,
  /(^|\.)advertising\.com$/,
  /(^|\.)taboola\.com$/,
  /(^|\.)outbrain\.com$/,
  /(^|\.)criteo\.(com|net)$/,
  /(^|\.)pubmatic\.com$/,
  /(^|\.)rubiconproject\.com$/,
  /(^|\.)spotxchange\.com$/,
  /(^|\.)freewheel\.tv$/,
  /(^|\.)google-analytics\.com$/,
  /(^|\.)facebook\.net$/,
  /(^|\.)hotjar\.com$/,
];
const AD_PATH_PATTERNS = [/\/ads?\//i, /\/vast[/.?]/i, /\/adserver/i, /[/_-]preroll/i, /\/pixel[/.?]/i, /\/beacon/i];

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseUrl(value: string, base?: string): URL | undefined {
  try {
    return new URL(value, base);
  } catch {
    return undefined;
  }
}

export function resolveUrl(ref: string, base: string): string {
  return new URL(ref, base).toString();
}

export function getExtension(url: string): string {
  const u = parseUrl(url);
  if (!u) return '';
  const last = u.pathname.split('/').pop() ?? '';
  const idx = last.lastIndexOf('.');
  if (idx < 0) return '';
  return last.slice(idx + 1).toLowerCase();
}

export function isAdOrTracker(url: string): boolean {
  const u = parseUrl(url);
  if (!u) return true;
  const host = u.hostname.toLowerCase();
  if (AD_HOST_PATTERNS.some((p) => p.test(host))) return true;
  return AD_PATH_PATTERNS.some((p) => p.test(u.pathname));
}

/** Heuristic: does this URL look like one media segment of a larger stream? */
export function isLikelySegment(url: string): boolean {
  const u = parseUrl(url);
  if (!u) return false;
  const ext = getExtension(url);
  if (SEGMENT_EXT.has(ext)) return true;
  if (/\/(seg|segment|chunk|frag|fragment)[-_]?\d+/i.test(u.pathname)) return true;
  if (/[-_/]\d+\.(m4s|ts|aac|mp4)$/i.test(u.pathname) && ext !== 'mp4') return true;
  if (/\/(init|initialization)[^/]*\.(mp4|m4s)$/i.test(u.pathname)) return true;
  if (u.searchParams.has('bytestart') || u.searchParams.has('range')) return true;
  return false;
}

export function classifyUrl(url: string, contentType?: string): UrlClass {
  if (!isHttpUrl(url)) return { type: 'ignore' };
  if (isAdOrTracker(url)) return { type: 'ignore' };
  const ext = getExtension(url);
  const ct = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

  if (ext === 'm3u8' || ext === 'm3u' || /mpegurl/.test(ct)) return { type: 'hls' };
  if (ext === 'mpd' || ct === 'application/dash+xml') return { type: 'dash' };
  if (ext === 'vtt' || ext === 'srt' || ext === 'ttml' || ct === 'text/vtt') return { type: 'subtitle' };
  if (ct === 'video/mp2t' || ct === 'video/iso.segment' || ct === 'audio/mp2t') return { type: 'segment' };
  if (isLikelySegment(url)) return { type: 'segment' };

  if (ct.startsWith('video/') || DIRECT_VIDEO_EXT.has(ext)) {
    if (ct === 'video/mp2t') return { type: 'segment' };
    return { type: 'direct', audioOnly: false, ext: ext || extFromMime(ct) };
  }
  if (ct.startsWith('audio/') || DIRECT_AUDIO_EXT.has(ext)) {
    return { type: 'direct', audioOnly: true, ext: ext || extFromMime(ct) };
  }
  return { type: 'ignore' };
}

export function extFromMime(mime: string): string {
  const m = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  const map: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-m4v': 'm4v',
    'video/x-matroska': 'mkv',
    'video/ogg': 'ogv',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/flac': 'flac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
  };
  return map[m] ?? '';
}

/** Key used to deduplicate detections of the same resource (volatile query params removed). */
export function dedupeKey(url: string): string {
  const u = parseUrl(url);
  if (!u) return url;
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !VOLATILE_PARAMS.has(k.toLowerCase()) && !/^x-amz-/i.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = params.map(([k, v]) => `${k}=${v}`).join('&');
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}${qs ? `?${qs}` : ''}`;
}

/** Remove credentials/tokens from a URL for safe logging. */
export function redactUrl(url: string): string {
  const u = parseUrl(url);
  if (!u) return '[invalid-url]';
  u.username = '';
  u.password = '';
  u.search = u.search ? '?…' : '';
  u.hash = '';
  return u.toString();
}

/** Header values must not contain control characters (header injection). */
export function isSafeHeaderValue(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value) && value.length < 16384;
}
