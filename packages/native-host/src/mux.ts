import type { Container, DualStreamLayout } from '@viddock/shared';
import type { ProbeResult } from './ffmpeg.ts';

export interface MuxInput {
  file: string;
  kind: 'video' | 'audio' | 'muxed';
  probe: ProbeResult;
  label?: string;
}

export interface MuxSubtitle {
  file: string;
  language?: string;
  label?: string;
}

export interface ContainerChoice {
  /** File extension of the output. */
  ext: 'mp4' | 'm4a' | 'mkv' | 'mka' | 'webm' | 'mp3' | 'ogg' | 'flac';
  format: string;
  note?: string;
}

const MP4_VIDEO = new Set(['h264', 'hevc', 'av1', 'vp9', 'mpeg4']);
const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'alac']);
const WEBM_VIDEO = new Set(['vp8', 'vp9', 'av1']);
const WEBM_AUDIO = new Set(['opus', 'vorbis']);

const FORMAT_FOR: Record<ContainerChoice['ext'], string> = {
  mp4: 'mp4',
  m4a: 'mp4',
  mkv: 'matroska',
  mka: 'matroska',
  webm: 'webm',
  mp3: 'mp3',
  ogg: 'ogg',
  flac: 'flac',
};

function choice(ext: ContainerChoice['ext'], note?: string): ContainerChoice {
  return { ext, format: FORMAT_FOR[ext], note };
}

export function collectCodecs(inputs: MuxInput[]) {
  const video: string[] = [];
  const audio: string[] = [];
  for (const i of inputs) {
    for (const s of i.probe.streams) {
      if (
        s.codec_type === 'video' &&
        s.codec_name &&
        !(s as { disposition?: { attached_pic?: number } }).disposition?.attached_pic
      )
        video.push(s.codec_name);
      else if (s.codec_type === 'audio' && s.codec_name) audio.push(s.codec_name);
    }
  }
  return { video, audio };
}

/** Choose an output container without ever relabelling an incompatible stream (no fake MP4s). */
export function chooseContainer(pref: Container, inputs: MuxInput[], layout?: DualStreamLayout): ContainerChoice {
  const { video, audio } = collectCodecs(inputs);
  const isDualComposite = (layout === 'side-by-side' || layout === 'pip') && video.length >= 2;
  const effectiveVideo = isDualComposite ? ['h264'] : video;
  if (video.length === 0) {
    // Audio-only output.
    const a = audio[0] ?? '';
    const single = audio.length === 1;
    if (pref === 'mkv') return choice('mka');
    if (single && (a === 'aac' || a === 'alac')) return choice('m4a');
    if (single && a === 'mp3') return choice('mp3');
    if (single && a === 'flac') return choice('flac');
    if (single && (a === 'opus' || a === 'vorbis')) return choice('ogg');
    return choice('mka', audio.length > 1 ? 'Multiple audio streams stored in Matroska audio' : undefined);
  }
  const mp4Ok = effectiveVideo.every((c) => MP4_VIDEO.has(c)) && audio.every((c) => MP4_AUDIO.has(c));
  const webmOk = effectiveVideo.every((c) => WEBM_VIDEO.has(c)) && audio.every((c) => WEBM_AUDIO.has(c));
  const bad = [...effectiveVideo, ...audio].filter((c) => !(MP4_VIDEO.has(c) || MP4_AUDIO.has(c)));
  switch (pref) {
    case 'mkv':
      return choice('mkv');
    case 'mp4':
      return mp4Ok
        ? choice('mp4')
        : choice('mkv', `Saved as MKV: ${bad.join(', ') || 'codecs'} cannot be stored in MP4 without transcoding`);
    case 'webm':
      return webmOk
        ? choice('webm')
        : choice('mkv', 'Saved as MKV: streams are not WebM-compatible without transcoding');
    default:
      if (!isDualComposite && video.length > 1)
        return choice('mkv', 'Multiple video feeds are stored together in one MKV');
      if (mp4Ok) return choice('mp4');
      if (webmOk) return choice('webm');
      return choice('mkv', `Saved as MKV: ${bad.join(', ') || 'codecs'} cannot be stored in MP4 without transcoding`);
  }
}

function safeLang(l: string | undefined): string | undefined {
  const s = (l ?? '')
    .toLowerCase()
    .replace(/[^a-z-]/g, '')
    .slice(0, 8);
  return s || undefined;
}

export function buildMuxArgs(opts: {
  inputs: MuxInput[];
  subtitles: MuxSubtitle[];
  choice: ContainerChoice;
  output: string;
  title: string;
  layout?: DualStreamLayout;
}): string[] {
  const { inputs, subtitles, choice: c, output, layout } = opts;
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-fflags', '+genpts+discardcorrupt'];
  for (const i of inputs) args.push('-i', i.file);
  for (const s of subtitles) args.push('-i', s.file);

  interface StreamRef {
    inputIndex: number;
    streamIndex: number;
    videoIndex?: number;
    audioIndex?: number;
    codecName?: string;
    width?: number;
    height?: number;
  }
  const videoStreams: StreamRef[] = [];
  const audioStreams: StreamRef[] = [];
  inputs.forEach((input, inputIndex) => {
    let videoStreamIndex = 0;
    let audioStreamIndex = 0;
    input.probe.streams.forEach((s) => {
      if (s.codec_type === 'video' && !(s as { disposition?: { attached_pic?: number } }).disposition?.attached_pic) {
        videoStreams.push({
          inputIndex,
          streamIndex: s.index,
          videoIndex: videoStreamIndex++,
          codecName: s.codec_name,
          width: s.width,
          height: s.height,
        });
      } else if (s.codec_type === 'audio') {
        audioStreams.push({
          inputIndex,
          streamIndex: s.index,
          audioIndex: audioStreamIndex++,
          codecName: s.codec_name,
        });
      }
    });
  });

  const isDualStream = (layout === 'side-by-side' || layout === 'pip') && videoStreams.length >= 2;
  if (isDualStream) {
    let v0 = videoStreams[0]!;
    let v1 = videoStreams[1]!;

    const getScore = (v: StreamRef) => {
      const inp = inputs[v.inputIndex];
      const text = `${inp?.label || ''} ${inp?.file || ''}`;
      let score = 0;
      if (/slide|screen|presentation|content|secondary|type\s*1/i.test(text)) score += 100;
      if (/camera|presenter|primary|type\s*0/i.test(text)) score -= 100;
      return score;
    };

    if (layout === 'pip') {
      if (videoStreams.length > 2) {
        const sorted = [...videoStreams].sort((a, b) => getScore(b) - getScore(a));
        v0 = sorted[0]!;
        v1 = sorted[1]!;
      } else if (getScore(v0) < getScore(v1)) {
        const tmp = v0;
        v0 = v1;
        v1 = tmp;
      }
    } else if (layout === 'side-by-side' && videoStreams.length > 2) {
      const sorted = [...videoStreams].sort((a, b) => getScore(b) - getScore(a));
      // sorted[0] is slides/screen (highest score), sorted[sorted.length - 1] is camera (lowest score)
      v0 = sorted[sorted.length - 1]!;
      v1 = sorted[0]!;
    }

    const v0Ref = `${v0.inputIndex}:v:${v0.videoIndex}`;
    const v1Ref = `${v1.inputIndex}:v:${v1.videoIndex}`;
    if (layout === 'side-by-side') {
      const filter =
        `[${v0Ref}]setpts=PTS-STARTPTS,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1[left];` +
        `[${v1Ref}]setpts=PTS-STARTPTS,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1[right];` +
        `[left][right]hstack=inputs=2[v]`;
      args.push('-filter_complex', filter);
    } else {
      const filter =
        `[${v1Ref}]setpts=PTS-STARTPTS,scale=iw/3.5:-2,setsar=1[pip];` +
        `[${v0Ref}]setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[main];` +
        `[main][pip]overlay=W-w-24:H-h-24[v]`;
      args.push('-filter_complex', filter);
    }
    args.push('-map', '[v]');
    if (audioStreams.length > 0) {
      const primaryAudioIndex = audioStreams.findIndex((a) => {
        const inp = inputs[a.inputIndex];
        const text = `${inp?.label || ''} ${inp?.file || ''}`;
        return inp?.kind === 'audio' || /audio|mic|sound/i.test(text);
      });
      const primaryAudio = primaryAudioIndex >= 0 ? audioStreams[primaryAudioIndex]! : audioStreams[0]!;
      const secondaryAudio = audioStreams.filter((_, idx) => idx !== (primaryAudioIndex >= 0 ? primaryAudioIndex : 0));
      const orderedAudio = [primaryAudio, ...secondaryAudio];

      orderedAudio.forEach((a, k) => {
        const inputAudioCount = audioStreams.filter((x) => x.inputIndex === a.inputIndex).length;
        const ref = inputAudioCount > 1 ? `${a.inputIndex}:a:${a.audioIndex ?? 0}` : `${a.inputIndex}:a`;
        args.push('-map', ref);
        const defaultTitle = k === 0 ? 'Primary' : k === 1 ? 'Secondary' : `Track ${k + 1}`;
        const inp = inputs[a.inputIndex];
        const title = inp?.label && !/video|type\s*\d/i.test(inp.label) ? inp.label : defaultTitle;
        args.push(`-metadata:s:a:${k}`, `title=${title.replace(/[\r\n]/g, ' ').slice(0, 100)}`);
      });

      args.push('-af', 'aresample=async=1:first_pts=0');
      if (c.ext === 'webm') {
        args.push('-c:a', 'libopus', '-b:a', '128k');
      } else {
        args.push('-c:a', 'aac', '-b:a', '192k');
      }
    }
    if (c.ext === 'webm') {
      args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-pix_fmt', 'yuv420p');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p');
    }
  } else {
    inputs.forEach((_i, idx) => {
      args.push('-map', `${idx}:v?`, '-map', `${idx}:a?`);
    });
    args.push('-c', 'copy');
  }

  subtitles.forEach((_s, k) => args.push('-map', `${inputs.length + k}:0`));
  if (subtitles.length > 0) {
    args.push('-c:s', c.ext === 'mp4' ? 'mov_text' : c.ext === 'webm' ? 'webvtt' : 'srt');
    subtitles.forEach((s, k) => {
      const lang = safeLang(s.language);
      if (lang) args.push(`-metadata:s:s:${k}`, `language=${lang}`);
      if (s.label) args.push(`-metadata:s:s:${k}`, `title=${s.label.replace(/[\r\n]/g, ' ').slice(0, 100)}`);
    });
  }
  const hevc = inputs.some((i) => i.probe.streams.some((s) => s.codec_name === 'hevc'));
  if (c.ext === 'mp4' || c.ext === 'm4a') args.push('-movflags', '+faststart');
  if (c.ext === 'mp4' && hevc && !isDualStream) args.push('-tag:v', 'hvc1');
  args.push('-avoid_negative_ts', 'make_zero');
  args.push('-metadata', `title=${opts.title.replace(/[\r\n]/g, ' ').slice(0, 200)}`);
  args.push('-f', c.format, output);
  return args;
}
