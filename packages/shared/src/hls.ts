/** HLS / M3U8 playlist parser (RFC 8216). */
import { resolveUrl } from './url.ts';

export interface HlsVariant {
  url: string;
  bandwidth: number;
  avgBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  frameRate?: number;
  audioGroup?: string;
  subtitleGroup?: string;
}

export interface HlsRendition {
  type: 'AUDIO' | 'SUBTITLES' | 'VIDEO' | 'CLOSED-CAPTIONS';
  groupId: string;
  name: string;
  language?: string;
  uri?: string;
  isDefault: boolean;
  autoselect: boolean;
  channels?: string;
}

export interface HlsMaster {
  type: 'master';
  variants: HlsVariant[];
  audio: HlsRendition[];
  subtitles: HlsRendition[];
  drm?: string;
}

export interface HlsKey {
  method: 'NONE' | 'AES-128' | 'SAMPLE-AES' | string;
  uri?: string;
  iv?: string;
  keyFormat?: string;
}

export interface HlsMap {
  url: string;
  byteRange?: { length: number; offset: number };
}

export interface HlsSegment {
  url: string;
  duration: number;
  /** Media sequence number (used for default AES IV). */
  seq: number;
  byteRange?: { length: number; offset: number };
  discontinuity: boolean;
  key?: HlsKey & { url?: string };
  map?: HlsMap;
}

export interface HlsMedia {
  type: 'media';
  segments: HlsSegment[];
  targetDuration: number;
  endList: boolean;
  playlistType?: string;
  totalDuration: number;
  drm?: string;
  isLive: boolean;
}

export type HlsPlaylist = HlsMaster | HlsMedia;

export function parseAttributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const key = m[1] as string;
    out[key] = m[3] !== undefined ? m[3] : (m[2] as string);
  }
  return out;
}

function detectDrm(key: HlsKey): string | undefined {
  if (key.method === 'SAMPLE-AES' || key.method === 'SAMPLE-AES-CTR' || key.method === 'SAMPLE-AES-CENC') {
    return `Encrypted with ${key.method} (DRM-style protection)`;
  }
  if (key.method === 'AES-128') {
    const kf = (key.keyFormat ?? 'identity').toLowerCase();
    if (kf !== 'identity') return `Key format "${key.keyFormat}" requires a DRM license`;
  }
  return undefined;
}

export function isMasterPlaylist(text: string): boolean {
  return /#EXT-X-STREAM-INF:/.test(text);
}

export function parseHls(text: string, baseUrl: string): HlsPlaylist {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines[0] !== '#EXTM3U') throw new Error('Not an M3U8 playlist (missing #EXTM3U)');
  return isMasterPlaylist(text) ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines: string[], baseUrl: string): HlsMaster {
  const variants: HlsVariant[] = [];
  const audio: HlsRendition[] = [];
  const subtitles: HlsRendition[] = [];
  let drm: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      let j = i + 1;
      while (j < lines.length && (lines[j] as string).startsWith('#')) j++;
      const uri = lines[j];
      if (!uri) continue;
      const res = /^(\d+)x(\d+)$/.exec(attrs.RESOLUTION ?? '');
      variants.push({
        url: resolveUrl(uri, baseUrl),
        bandwidth: Number(attrs.BANDWIDTH ?? 0) || 0,
        avgBandwidth: attrs['AVERAGE-BANDWIDTH'] ? Number(attrs['AVERAGE-BANDWIDTH']) : undefined,
        width: res ? Number(res[1]) : undefined,
        height: res ? Number(res[2]) : undefined,
        codecs: attrs.CODECS,
        frameRate: attrs['FRAME-RATE'] ? Number(attrs['FRAME-RATE']) : undefined,
        audioGroup: attrs.AUDIO,
        subtitleGroup: attrs.SUBTITLES,
      });
      i = j;
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      const type = a.TYPE as HlsRendition['type'] | undefined;
      if (!type) continue;
      const r: HlsRendition = {
        type,
        groupId: a['GROUP-ID'] ?? '',
        name: a.NAME ?? a.LANGUAGE ?? 'Track',
        language: a.LANGUAGE,
        uri: a.URI ? resolveUrl(a.URI, baseUrl) : undefined,
        isDefault: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES',
        channels: a.CHANNELS,
      };
      if (type === 'AUDIO') audio.push(r);
      else if (type === 'SUBTITLES') subtitles.push(r);
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      const a = parseAttributes(line.slice('#EXT-X-SESSION-KEY:'.length));
      drm ??= detectDrm({ method: a.METHOD ?? 'NONE', keyFormat: a.KEYFORMAT });
    }
  }
  return { type: 'master', variants, audio, subtitles, drm };
}

function parseByteRange(value: string, prevEnd: number): { length: number; offset: number } {
  const [len, off] = value.split('@');
  const length = Number(len);
  const offset = off !== undefined ? Number(off) : prevEnd;
  return { length, offset };
}

function parseMedia(lines: string[], baseUrl: string): HlsMedia {
  const segments: HlsSegment[] = [];
  let seq = 0;
  let targetDuration = 0;
  let endList = false;
  let playlistType: string | undefined;
  let pendingDuration = 0;
  let pendingRange: { length: number; offset: number } | undefined;
  let pendingDiscontinuity = false;
  let currentKey: (HlsKey & { url?: string }) | undefined;
  let currentMap: HlsMap | undefined;
  let drm: string | undefined;
  let lastRangeEnd = 0;
  let lastRangeUri = '';

  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(line.split(':')[1]) || 0;
    else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) playlistType = line.split(':')[1];
    else if (line === '#EXT-X-ENDLIST') endList = true;
    else if (line === '#EXT-X-DISCONTINUITY') pendingDiscontinuity = true;
    else if (line.startsWith('#EXTINF:')) pendingDuration = parseFloat(line.slice(8)) || 0;
    else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = { length: 0, offset: 0 };
      pendingRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length), -1);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      const key: HlsKey & { url?: string } = {
        method: a.METHOD ?? 'NONE',
        uri: a.URI,
        iv: a.IV,
        keyFormat: a.KEYFORMAT,
        url: a.URI ? resolveUrl(a.URI, baseUrl) : undefined,
      };
      drm ??= detectDrm(key);
      currentKey = key.method === 'NONE' ? undefined : key;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (a.URI) {
        const map: HlsMap = { url: resolveUrl(a.URI, baseUrl) };
        if (a.BYTERANGE) map.byteRange = parseByteRange(a.BYTERANGE, 0);
        currentMap = map;
      }
    } else if (!line.startsWith('#')) {
      const url = resolveUrl(line, baseUrl);
      let byteRange: { length: number; offset: number } | undefined;
      if (pendingRange) {
        byteRange = { ...pendingRange };
        if (byteRange.offset < 0) byteRange.offset = lastRangeUri === url ? lastRangeEnd : 0;
        lastRangeEnd = byteRange.offset + byteRange.length;
        lastRangeUri = url;
      }
      segments.push({
        url,
        duration: pendingDuration,
        seq,
        byteRange,
        discontinuity: pendingDiscontinuity,
        key: currentKey,
        map: currentMap,
      });
      seq += 1;
      pendingDuration = 0;
      pendingRange = undefined;
      pendingDiscontinuity = false;
    }
  }
  const totalDuration = segments.reduce((s, x) => s + x.duration, 0);
  return {
    type: 'media',
    segments,
    targetDuration,
    endList,
    playlistType,
    totalDuration,
    drm,
    isLive: !endList && playlistType !== 'VOD',
  };
}
