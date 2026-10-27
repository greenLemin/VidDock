/** Turn parsed manifests into the quality/audio/subtitle model shown in the UI. */
import { areCodecsCompatible, parseMpd } from './dash.ts';
import { parseHls } from './hls.ts';
import { dedupeQualities, qualityLabel, sortQualities } from './quality.ts';
import type { AudioTrack, Quality, SubtitleTrack } from './types.ts';

export interface DescribedMedia {
  qualities: Quality[];
  audioTracks: AudioTrack[];
  subtitles: SubtitleTrack[];
  durationSec?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  isLive?: boolean;
  unsupportedReason?: string;
}

const AUDIO_CODEC = /^(mp4a|ac-3|ec-3|opus|vorbis|flac|mp3)/i;

function isAudioOnlyCodecs(codecs: string | undefined): boolean {
  if (!codecs) return false;
  const parts = codecs.split(',').map((c) => c.trim());
  return parts.length > 0 && parts.every((c) => AUDIO_CODEC.test(c));
}

function subtitleFormat(url: string): SubtitleTrack['format'] {
  if (/\.(vtt|webvtt)(\?|$)/i.test(url) || /\.m3u8(\?|$)/i.test(url)) return 'vtt';
  if (/\.srt(\?|$)/i.test(url)) return 'srt';
  if (/\.(ttml|xml|dfxp)(\?|$)/i.test(url)) return 'ttml';
  return 'unknown';
}

export function describeHls(text: string, url: string): DescribedMedia {
  const pl = parseHls(text, url);
  if (pl.type === 'media') {
    const first = pl.segments[0]?.url ?? '';
    const audioOnly = /\.(aac|mp3|m4a)(\?|$)/i.test(first);
    let unsupportedReason: string | undefined = pl.drm;
    if (!unsupportedReason && pl.segments.length === 0) unsupportedReason = 'Playlist contains no segments';
    return {
      qualities: [{ id: 'q0', label: 'Original', ref: url }],
      audioTracks: [],
      subtitles: [],
      durationSec: pl.totalDuration || undefined,
      hasVideo: !audioOnly,
      hasAudio: true,
      isLive: pl.isLive,
      unsupportedReason,
    };
  }
  const audioOnlyVariants =
    pl.variants.length > 0 && pl.variants.every((v) => !v.height && isAudioOnlyCodecs(v.codecs));
  const qualities: Quality[] = dedupeQualities(
    sortQualities(
      pl.variants.map((v, i) => ({
        id: `q${i}`,
        label: qualityLabel(v.height, v.bandwidth, v.frameRate),
        height: v.height,
        width: v.width,
        bandwidth: v.bandwidth,
        codecs: v.codecs,
        frameRate: v.frameRate,
        ref: v.url,
        audioGroup: v.audioGroup,
      })),
    ),
  );
  const audioTracks: AudioTrack[] = pl.audio
    .filter((a) => a.uri)
    .map((a, i) => ({
      id: `a${i}`,
      label: a.name,
      language: a.language,
      ref: a.uri as string,
      groupId: a.groupId,
      isDefault: a.isDefault,
    }));
  const subtitles: SubtitleTrack[] = pl.subtitles
    .filter((s) => s.uri)
    .map((s, i) => ({
      id: `s${i}`,
      label: s.name,
      language: s.language,
      url: s.uri as string,
      format: subtitleFormat(s.uri as string),
    }));
  return {
    qualities,
    audioTracks,
    subtitles,
    hasVideo: !audioOnlyVariants,
    hasAudio: true,
    unsupportedReason: pl.drm ?? (qualities.length === 0 ? 'Master playlist has no variants' : undefined),
  };
}

export function describeDash(text: string, url: string): DescribedMedia {
  const mpd = parseMpd(text, url);
  const period = mpd.periods[0];
  let unsupportedReason: string | undefined = mpd.drm;

  if (!unsupportedReason && mpd.periods.length > 1) {
    const p0Videos =
      mpd.periods[0]?.adaptations.filter((a) => a.contentType === 'video').flatMap((a) => a.representations) ?? [];
    const p0Audios =
      mpd.periods[0]?.adaptations.filter((a) => a.contentType === 'audio').flatMap((a) => a.representations) ?? [];

    for (let i = 1; i < mpd.periods.length; i++) {
      const pi = mpd.periods[i]!;
      const piVideos = pi.adaptations.filter((a) => a.contentType === 'video').flatMap((a) => a.representations);
      const piAudios = pi.adaptations.filter((a) => a.contentType === 'audio').flatMap((a) => a.representations);

      if (p0Videos.length > 0) {
        if (piVideos.length === 0) {
          unsupportedReason = `Multi-period manifest has missing video in period ${i + 1}`;
          break;
        }
        const hasCompatibleVideo = p0Videos.some((v0) =>
          piVideos.some((vi) => areCodecsCompatible(v0.codecs, vi.codecs)),
        );
        if (!hasCompatibleVideo) {
          unsupportedReason = 'Multi-period manifest has incompatible video codecs across periods';
          break;
        }
      }

      if (p0Audios.length > 0) {
        if (piAudios.length === 0) {
          unsupportedReason = `Multi-period manifest has missing audio in period ${i + 1}`;
          break;
        }
        const hasCompatibleAudio = p0Audios.some((a0) =>
          piAudios.some((ai) => areCodecsCompatible(a0.codecs, ai.codecs)),
        );
        if (!hasCompatibleAudio) {
          unsupportedReason = 'Multi-period manifest has incompatible audio codecs across periods';
          break;
        }
      }
    }
  }
  const videos = period?.adaptations.filter((a) => a.contentType === 'video') ?? [];
  const audios = period?.adaptations.filter((a) => a.contentType === 'audio') ?? [];
  const qualities: Quality[] = dedupeQualities(
    sortQualities(
      videos.flatMap((a) =>
        a.representations.map((r) => ({
          id: `v${r.id}`,
          label: qualityLabel(r.height, r.bandwidth, r.frameRate),
          height: r.height,
          width: r.width,
          bandwidth: r.bandwidth,
          codecs: r.codecs,
          frameRate: r.frameRate,
          ref: r.id,
        })),
      ),
    ),
  );
  const audioTracks: AudioTrack[] = audios.flatMap((a) =>
    a.representations.map((r) => ({
      id: `a${r.id}`,
      label: `${a.label ?? a.lang ?? 'Audio'} (${Math.round(r.bandwidth / 1000)} kbps)`,
      language: a.lang,
      ref: r.id,
      groupId: a.id,
      bandwidth: r.bandwidth,
    })),
  );
  if (!unsupportedReason && qualities.length === 0 && audioTracks.length === 0) {
    unsupportedReason = 'Manifest has no downloadable representations';
  }
  return {
    qualities:
      qualities.length > 0
        ? qualities
        : audioTracks.map((a) => ({ id: a.id, label: a.label, ref: a.ref, bandwidth: a.bandwidth })),
    audioTracks: qualities.length > 0 ? audioTracks : [],
    subtitles: [],
    durationSec: mpd.durationSec || undefined,
    hasVideo: qualities.length > 0,
    hasAudio: audios.length > 0 || videos.length > 0,
    isLive: mpd.isLive,
    unsupportedReason,
  };
}
