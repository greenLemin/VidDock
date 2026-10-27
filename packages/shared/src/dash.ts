/** MPEG-DASH MPD parser: manifests -> representations -> concrete segment URLs. */
import { XMLParser } from 'fast-xml-parser';
import { resolveUrl } from './url.ts';

export interface DashRepresentation {
  id: string;
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  mimeType?: string;
  frameRate?: number;
  /** Segments, already resolved to absolute URLs. */
  init?: string;
  initRange?: string;
  segments: { url: string; duration: number; range?: string }[];
  /** True when the representation is one whole file (BaseURL only / SegmentBase). */
  singleFile?: string;
}

export interface DashAdaptation {
  id: string;
  contentType: 'video' | 'audio' | 'text' | 'unknown';
  mimeType?: string;
  lang?: string;
  label?: string;
  representations: DashRepresentation[];
}

export interface DashManifest {
  isLive: boolean;
  durationSec: number;
  periods: { adaptations: DashAdaptation[] }[];
  drm?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

const ARRAY_TAGS = new Set([
  'Period',
  'AdaptationSet',
  'Representation',
  'S',
  'BaseURL',
  'ContentProtection',
  'SegmentURL',
  'Label',
  'Role',
]);

export function parseIsoDuration(value: string | undefined): number {
  if (!value) return 0;
  const m =
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value.trim(),
    );
  if (!m) return 0;
  const n = (i: number) => (m[i] ? parseFloat(m[i] as string) : 0);
  return n(3) * 86400 + n(4) * 3600 + n(5) * 60 + n(6);
}

export function baseCodec(codec?: string): string {
  if (!codec) return '';
  return codec.split('.')[0]!.trim().toLowerCase();
}

export function areCodecsCompatible(c1?: string, c2?: string): boolean {
  if (!c1 || !c2) return true;
  const b1 = baseCodec(c1);
  const b2 = baseCodec(c2);
  if (b1 === b2) return true;
  if ((b1 === 'hvc1' || b1 === 'hev1') && (b2 === 'hvc1' || b2 === 'hev1')) return true;
  return false;
}

function arr<T = Node>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function baseOf(node: Node, parent: string): string {
  const b = arr(node?.BaseURL)[0];
  const text = typeof b === 'object' ? b?.['#text'] : b;
  return text ? resolveUrl(String(text).trim(), parent) : parent;
}

function formatTemplate(tpl: string, vars: { id: string; bandwidth: number; number?: number; time?: number }): string {
  return tpl.replace(
    /\$(RepresentationID|Bandwidth|Number|Time)(%0(\d+)d)?\$|\$\$/g,
    (m, name: string, _f, width: string) => {
      if (m === '$$') return '$';
      let val: string;
      switch (name) {
        case 'RepresentationID':
          val = vars.id;
          break;
        case 'Bandwidth':
          val = String(vars.bandwidth);
          break;
        case 'Number':
          val = String(vars.number ?? 0);
          break;
        default:
          val = String(vars.time ?? 0);
      }
      return width ? val.padStart(Number(width), '0') : val;
    },
  );
}

function mergeTemplate(parent: Node, child: Node): Node {
  if (!child) return parent;
  if (!parent) return child;
  return { ...parent, ...child };
}

function buildRepresentation(
  rep: Node,
  set: Node,
  period: Node,
  periodBase: string,
  mpdDuration: number,
  periodDuration: number,
): DashRepresentation {
  const id = String(rep['@_id'] ?? '');
  const bandwidth = Number(rep['@_bandwidth'] ?? 0);
  const setBase = baseOf(set, periodBase);
  const repBase = baseOf(rep, setBase);
  const out: DashRepresentation = {
    id,
    bandwidth,
    width: rep['@_width'] ? Number(rep['@_width']) : set['@_width'] ? Number(set['@_width']) : undefined,
    height: rep['@_height'] ? Number(rep['@_height']) : set['@_height'] ? Number(set['@_height']) : undefined,
    codecs: rep['@_codecs'] ?? set['@_codecs'],
    mimeType: rep['@_mimeType'] ?? set['@_mimeType'],
    frameRate: parseFrameRate(rep['@_frameRate'] ?? set['@_frameRate']),
    segments: [],
  };

  const tpl = mergeTemplate(mergeTemplate(period?.SegmentTemplate, set?.SegmentTemplate), rep?.SegmentTemplate);
  const list = rep?.SegmentList ?? set?.SegmentList ?? period?.SegmentList;
  const segBase = rep?.SegmentBase ?? set?.SegmentBase ?? period?.SegmentBase;

  if (tpl) {
    const timescale = Number(tpl['@_timescale'] ?? 1) || 1;
    const initTpl: string | undefined = tpl['@_initialization'] ?? tpl.Initialization?.['@_sourceURL'];
    if (initTpl) out.init = resolveUrl(formatTemplate(initTpl, { id, bandwidth }), repBase);
    const media: string | undefined = tpl['@_media'];
    if (!media) throw new Error(`Representation ${id}: SegmentTemplate without @media`);
    const startNumber = Number(tpl['@_startNumber'] ?? 1);
    const timeline = tpl.SegmentTimeline;
    if (timeline) {
      let time = 0;
      let number = startNumber;
      for (const s of arr(timeline.S)) {
        if (s['@_t'] !== undefined) time = Number(s['@_t']);
        const d = Number(s['@_d']);
        const repeat = Number(s['@_r'] ?? 0);
        const count = repeat < 0 ? Math.max(0, Math.ceil((periodDuration * timescale - time) / d)) : repeat + 1;
        for (let k = 0; k < count; k++) {
          out.segments.push({
            url: resolveUrl(formatTemplate(media, { id, bandwidth, number, time }), repBase),
            duration: d / timescale,
          });
          time += d;
          number += 1;
        }
      }
    } else {
      const dur = Number(tpl['@_duration'] ?? 0);
      if (!dur) throw new Error(`Representation ${id}: SegmentTemplate has neither timeline nor duration`);
      const segDur = dur / timescale;
      const total = periodDuration || mpdDuration;
      const count = Math.max(1, Math.ceil(total / segDur));
      for (let k = 0; k < count; k++) {
        out.segments.push({
          url: resolveUrl(formatTemplate(media, { id, bandwidth, number: startNumber + k, time: k * dur }), repBase),
          duration: segDur,
        });
      }
    }
  } else if (list) {
    const timescale = Number(list['@_timescale'] ?? 1) || 1;
    const dur = Number(list['@_duration'] ?? 0) / timescale;
    const init = list.Initialization?.['@_sourceURL'];
    if (init) out.init = resolveUrl(init, repBase);
    for (const su of arr(list.SegmentURL)) {
      out.segments.push({
        url: resolveUrl(su['@_media'], repBase),
        duration: dur,
        range: su['@_mediaRange'],
      });
    }
  } else if (segBase || arr(rep.BaseURL).length > 0) {
    out.singleFile = repBase;
  } else {
    throw new Error(`Representation ${id}: no segment information`);
  }
  return out;
}

function parseFrameRate(v: unknown): number | undefined {
  if (!v) return undefined;
  const s = String(v);
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    return a && b ? a / b : undefined;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function parseMpd(xml: string, mpdUrl: string): DashManifest {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    isArray: (name: string) => ARRAY_TAGS.has(name),
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: true,
  });
  let doc: Node;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new Error(`Invalid MPD XML: ${(e as Error).message}`);
  }
  const mpd = doc?.MPD;
  if (!mpd) throw new Error('Not an MPD manifest (missing <MPD>)');

  const isLive = mpd['@_type'] === 'dynamic';
  const mpdDuration = parseIsoDuration(mpd['@_mediaPresentationDuration']);
  const mpdBase = baseOf(mpd, mpdUrl);
  let drm: string | undefined;
  const periods: DashManifest['periods'] = [];

  const periodNodes = arr(mpd.Period);
  periodNodes.forEach((period: Node, i: number) => {
    let periodDuration = parseIsoDuration(period['@_duration']);
    if (!periodDuration) {
      const periodStart = parseIsoDuration(period['@_start']);
      const nextPeriodStart = i + 1 < periodNodes.length ? parseIsoDuration(periodNodes[i + 1]['@_start']) : 0;
      if (nextPeriodStart > periodStart) {
        periodDuration = nextPeriodStart - periodStart;
      } else if (mpdDuration && periodStart < mpdDuration) {
        periodDuration = mpdDuration - periodStart;
      } else if (periodNodes.length === 1) {
        periodDuration = mpdDuration;
      } else {
        periodDuration = 0;
      }
    }
    const periodBase = baseOf(period, mpdBase);
    const adaptations: DashAdaptation[] = [];
    for (const set of arr(period.AdaptationSet)) {
      // Any ContentProtection element means the media is encrypted (CENC/DRM): unsupported.
      if (arr(set.ContentProtection).length > 0 || arr(arr(set.Representation)[0]?.ContentProtection).length > 0) {
        drm = 'Manifest declares ContentProtection (encrypted/DRM media)';
      }
      const mimeType = set['@_mimeType'] ?? arr(set.Representation)[0]?.['@_mimeType'];
      const rawType: string = set['@_contentType'] ?? String(mimeType ?? '').split('/')[0] ?? '';
      const contentType: DashAdaptation['contentType'] =
        rawType === 'video' || rawType === 'audio'
          ? rawType
          : rawType === 'text' || /ttml|vtt/.test(String(mimeType))
            ? 'text'
            : 'unknown';
      const reps: DashRepresentation[] = [];
      for (const rep of arr(set.Representation)) {
        if (contentType === 'text') continue;
        reps.push(buildRepresentation(rep, set, period, periodBase, mpdDuration, periodDuration));
      }
      adaptations.push({
        id: String(set['@_id'] ?? adaptations.length),
        contentType,
        mimeType,
        lang: set['@_lang'],
        label: arr(set.Label)[0]
          ? String(typeof arr(set.Label)[0] === 'object' ? arr(set.Label)[0]['#text'] : arr(set.Label)[0])
          : undefined,
        representations: reps,
      });
    }
    periods.push({ adaptations });
  });

  const durationSec =
    mpdDuration ||
    periods.reduce((total, p) => {
      const rep =
        p.adaptations.find((a) => a.contentType === 'video' || a.contentType === 'audio')?.representations[0] ??
        p.adaptations[0]?.representations[0];
      return total + (rep?.segments.reduce((s, x) => s + x.duration, 0) ?? 0);
    }, 0);
  return { isLive, durationSec, periods, drm };
}
