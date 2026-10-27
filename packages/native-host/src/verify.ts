import fs from 'node:fs';
import { runFfmpeg, probe } from './ffmpeg.ts';
import type { ProbeResult } from './ffmpeg.ts';
import { UserFacingError } from './plans.ts';

export interface VerifyExpectations {
  video: boolean;
  audio: boolean;
  durationSec?: number;
  skippedSegments?: number;
}

export function mediaDuration(p: ProbeResult): number | undefined {
  const f = Number(p.format.duration);
  if (Number.isFinite(f) && f > 0) return f;
  const ds = p.streams.map((s) => Number(s.duration)).filter((n) => Number.isFinite(n) && n > 0);
  return ds.length ? Math.max(...ds) : undefined;
}

export function durationTolerance(expected: number): number {
  return Math.max(2, expected * 0.03);
}

/** Pure analysis of a probe result against expectations; returns failures and warnings. */
export function analyzeProbe(p: ProbeResult, expect: VerifyExpectations): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const videos = p.streams.filter((s) => s.codec_type === 'video');
  const audios = p.streams.filter((s) => s.codec_type === 'audio');
  if (expect.video && videos.length === 0) errors.push('Output has no video stream');
  if (expect.audio && audios.length === 0) errors.push('Output has no audio stream');
  const dur = mediaDuration(p);
  if (dur === undefined) errors.push('Output has no readable duration');
  else if (expect.durationSec && expect.durationSec > 0) {
    const diff = Math.abs(dur - expect.durationSec);
    if (diff > durationTolerance(expect.durationSec)) {
      if (expect.skippedSegments && expect.skippedSegments > 0) {
        warnings.push(
          `Duration mismatch: expected about ${expect.durationSec.toFixed(1)}s but file is ${dur.toFixed(1)}s (${expect.skippedSegments} skipped segment(s))`,
        );
      } else {
        errors.push(
          `Duration mismatch: expected about ${expect.durationSec.toFixed(1)}s but file is ${dur.toFixed(1)}s`,
        );
      }
    }
  }
  const v0 = videos[0];
  const a0 = audios[0];
  if (v0 && a0) {
    const vs = Number(v0.start_time ?? 0);
    const as = Number(a0.start_time ?? 0);
    if (Number.isFinite(vs) && Number.isFinite(as) && Math.abs(vs - as) > 0.5) {
      warnings.push(`Audio/video start offset is ${Math.abs(vs - as).toFixed(2)}s`);
    }
    const vd = Number(v0.duration);
    const ad = Number(a0.duration);
    if (Number.isFinite(vd) && Number.isFinite(ad) && Math.abs(vd - ad) > 2) {
      warnings.push(`Audio and video lengths differ by ${Math.abs(vd - ad).toFixed(1)}s`);
    }
  }
  return { errors, warnings };
}

export async function verifyOutput(
  bins: { ffmpeg: string; ffprobe: string },
  file: string,
  expect: VerifyExpectations,
  signal: AbortSignal,
): Promise<{ warnings: string[]; probe: ProbeResult }> {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    throw new UserFacingError('Output file is missing', 'VERIFY_FAILED');
  }
  if (size === 0) throw new UserFacingError('Output file is empty', 'VERIFY_FAILED');
  let p: ProbeResult;
  try {
    p = await probe(bins.ffprobe, file, signal);
  } catch (e) {
    if (signal.aborted) throw e;
    throw new UserFacingError('Output is not a valid media file (ffprobe failed)', 'VERIFY_FAILED');
  }
  const { errors, warnings } = analyzeProbe(p, expect);
  if (errors.length > 0) throw new UserFacingError(`Verification failed: ${errors.join('; ')}`, 'VERIFY_FAILED');

  // Representative decode: start and middle of the file must decode without errors.
  const dur = mediaDuration(p) ?? 0;
  const seeks = dur > 8 ? [0, Math.max(0, dur / 2 - 1)] : [0];
  for (const ss of seeks) {
    const r = await runFfmpeg(
      bins.ffmpeg,
      ['-hide_banner', '-nostdin', '-v', 'error', '-ss', String(ss), '-t', '3', '-i', file, '-f', 'null', '-'],
      signal,
    );
    if (r.code !== 0 || r.stderr.trim().length > 0) {
      throw new UserFacingError(
        `Decode test failed at ${ss.toFixed(0)}s: ${r.stderr.trim().split('\n')[0] ?? 'unknown error'}`,
        'VERIFY_FAILED',
      );
    }
  }
  return { warnings, probe: p };
}
