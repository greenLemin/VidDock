import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const FIXTURE_ROOT = path.resolve(import.meta.dirname, '../../.tmp/fixtures');
export const FIXTURE_DURATION = 6;

async function ff(args: string[]): Promise<void> {
  await execFileP('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 32 * 1024 * 1024 });
}

async function pickH264(): Promise<string[]> {
  for (const enc of ['libx264', 'h264_videotoolbox', 'mpeg4']) {
    try {
      await ff(['-f', 'lavfi', '-i', 'testsrc=duration=0.2:size=64x64:rate=10', '-c:v', enc, '-f', 'null', '-']);
      return enc === 'libx264' ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'] : ['-c:v', enc];
    } catch {
      /* try next */
    }
  }
  throw new Error('No usable video encoder in ffmpeg');
}

function mk(...p: string[]): string {
  const d = path.join(FIXTURE_ROOT, ...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Build deterministic, locally generated media fixtures (no third-party media). Cached under .tmp/fixtures. */
export async function ensureFixtures(): Promise<string> {
  const marker = path.join(FIXTURE_ROOT, '.complete-v2');
  if (fs.existsSync(marker)) return FIXTURE_ROOT;
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mk();
  const enc = await pickH264();
  const gop = ['-g', '25', '-keyint_min', '25', '-sc_threshold', '0'];
  const sample = path.join(FIXTURE_ROOT, 'sample.mp4');
  await ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${FIXTURE_DURATION}:size=320x240:rate=25`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${FIXTURE_DURATION}:sample_rate=44100`,
    ...enc,
    ...gop,
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-shortest',
    sample,
  ]);
  // Same content, lower resolution.
  const small = path.join(FIXTURE_ROOT, 'sample-small.mp4');
  await ff(['-i', sample, '-vf', 'scale=160:120', ...enc, ...gop, '-c:a', 'copy', small]);

  // --- HLS multi-quality, muxed audio+video ---
  mk('hls', 'v240');
  mk('hls', 'v120');
  const hlsArgs = (dir: string) => [
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    path.join(FIXTURE_ROOT, 'hls', dir, 'seg%03d.ts'),
    path.join(FIXTURE_ROOT, 'hls', dir, 'index.m3u8'),
  ];
  await ff(['-i', sample, ...hlsArgs('v240')]);
  await ff(['-i', small, ...hlsArgs('v120')]);
  fs.writeFileSync(
    path.join(FIXTURE_ROOT, 'hls', 'master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=160x120,CODECS="avc1.42c00d,mp4a.40.2"',
      'v120/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x240,CODECS="avc1.42c01e,mp4a.40.2"',
      'v240/index.m3u8',
      '',
    ].join('\n'),
  );

  // --- HLS with separate audio and video renditions ---
  mk('hls-sep', 'video');
  mk('hls-sep', 'audio');
  await ff([
    '-i',
    sample,
    '-map',
    '0:v',
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    path.join(FIXTURE_ROOT, 'hls-sep', 'video', 'seg%03d.ts'),
    path.join(FIXTURE_ROOT, 'hls-sep', 'video', 'index.m3u8'),
  ]);
  await ff([
    '-i',
    sample,
    '-map',
    '0:a',
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    path.join(FIXTURE_ROOT, 'hls-sep', 'audio', 'seg%03d.ts'),
    path.join(FIXTURE_ROOT, 'hls-sep', 'audio', 'index.m3u8'),
  ]);
  fs.writeFileSync(
    path.join(FIXTURE_ROOT, 'hls-sep', 'master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x240,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="aud"',
      'video/index.m3u8',
      '',
    ].join('\n'),
  );

  // --- HLS AES-128 ---
  mk('hls-aes');
  const key = crypto.randomBytes(16);
  fs.writeFileSync(path.join(FIXTURE_ROOT, 'hls-aes', 'key.bin'), key);
  fs.writeFileSync(
    path.join(FIXTURE_ROOT, 'hls-aes', 'keyinfo'),
    ['key.bin', path.join(FIXTURE_ROOT, 'hls-aes', 'key.bin'), crypto.randomBytes(16).toString('hex')].join('\n'),
  );
  await ff([
    '-i',
    sample,
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_playlist_type',
    'vod',
    '-hls_key_info_file',
    path.join(FIXTURE_ROOT, 'hls-aes', 'keyinfo'),
    '-hls_segment_filename',
    path.join(FIXTURE_ROOT, 'hls-aes', 'seg%03d.ts'),
    path.join(FIXTURE_ROOT, 'hls-aes', 'index.m3u8'),
  ]);

  // --- HLS fMP4 (init segment) ---
  mk('hls-fmp4');
  await ff([
    '-i',
    sample,
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    path.join(FIXTURE_ROOT, 'hls-fmp4', 'seg%03d.m4s'),
    path.join(FIXTURE_ROOT, 'hls-fmp4', 'index.m3u8'),
  ]);

  // --- DASH: two video representations + one audio ---
  mk('dash');
  await ff([
    '-i',
    sample,
    '-i',
    small,
    '-map',
    '0:v',
    '-map',
    '1:v',
    '-map',
    '0:a',
    '-c',
    'copy',
    '-f',
    'dash',
    '-seg_duration',
    '2',
    '-use_template',
    '1',
    '-use_timeline',
    '1',
    '-adaptation_sets',
    'id=0,streams=0,1 id=1,streams=2',
    path.join(FIXTURE_ROOT, 'dash', 'manifest.mpd'),
  ]);

  // --- Mediasite-like presentation: two feeds (camera + screen) ---
  mk('mediasite');
  fs.copyFileSync(sample, path.join(FIXTURE_ROOT, 'mediasite', 'camera.mp4'));
  fs.copyFileSync(small, path.join(FIXTURE_ROOT, 'mediasite', 'screen.mp4'));

  fs.writeFileSync(marker, new Date().toISOString());
  return FIXTURE_ROOT;
}

export function makeTmpDir(prefix = 'viddock-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
