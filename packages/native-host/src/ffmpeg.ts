import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export function getCandidateDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.PATH) {
    dirs.push(...process.env.PATH.split(path.delimiter));
  }
  // VidDock Application Support location per Decision 2
  dirs.push(path.join(os.homedir(), 'Library', 'Application Support', 'VidDock', 'bin'));
  dirs.push(
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/opt/local/bin',
    '/snap/bin',
  );
  return dirs;
}

export function findBinary(name: 'ffmpeg' | 'ffprobe'): string | undefined {
  const envKey = name === 'ffmpeg' ? 'VIDDOCK_FFMPEG' : 'VIDDOCK_FFPROBE';
  const fromEnv = process.env[envKey];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const dirs = getCandidateDirs();
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, exe);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

export async function binaryVersion(bin: string | undefined): Promise<string | undefined> {
  if (!bin) return undefined;
  try {
    const { stdout } = await execFileP(bin, ['-version'], { timeout: 10_000 });
    return stdout.split('\n')[0]?.trim();
  } catch {
    return undefined;
  }
}

export interface FfmpegResult {
  code: number | null;
  stderr: string;
}

/** Run ffmpeg with an argv array (never through a shell). */
export function runFfmpeg(bin: string, args: string[], signal: AbortSignal): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    const onAbort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      signal.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(new Error('aborted'));
      else resolve({ code, stderr });
    });
  });
}

export interface ProbeStream {
  index: number;
  codec_type: 'video' | 'audio' | 'subtitle' | 'data' | string;
  codec_name?: string;
  width?: number;
  height?: number;
  start_time?: string;
  duration?: string;
}

export interface ProbeResult {
  format: { duration?: string; format_name?: string; size?: string; start_time?: string };
  streams: ProbeStream[];
}

export async function probe(ffprobe: string, file: string, signal?: AbortSignal): Promise<ProbeResult> {
  const { stdout } = await execFileP(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, signal },
  );
  return JSON.parse(stdout) as ProbeResult;
}
