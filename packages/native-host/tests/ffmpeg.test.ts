import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { binaryVersion, findBinary, getCandidateDirs, runFfmpeg } from '../src/ffmpeg.ts';

describe('Native Host FFmpeg & Binary Discovery Tests', () => {
  const origEnv = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-ffmpeg-test-'));
  });

  afterEach(() => {
    process.env = { ...origEnv };
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('prioritizes VIDDOCK_FFMPEG and VIDDOCK_FFPROBE environment variables over PATH', () => {
    const mockFfmpeg = path.join(tempDir, 'custom-ffmpeg');
    fs.writeFileSync(mockFfmpeg, '#!/bin/sh\necho custom ffmpeg', { mode: 0o755 });

    const mockFfprobe = path.join(tempDir, 'custom-ffprobe');
    fs.writeFileSync(mockFfprobe, '#!/bin/sh\necho custom ffprobe', { mode: 0o755 });

    process.env.VIDDOCK_FFMPEG = mockFfmpeg;
    process.env.VIDDOCK_FFPROBE = mockFfprobe;

    expect(findBinary('ffmpeg')).toBe(mockFfmpeg);
    expect(findBinary('ffprobe')).toBe(mockFfprobe);
  });

  it('includes ~/Library/Application Support/VidDock/bin and Homebrew in candidate directories', () => {
    const candidateDirs = getCandidateDirs();
    const appSupportBin = path.join(os.homedir(), 'Library', 'Application Support', 'VidDock', 'bin');

    expect(candidateDirs).toContain(appSupportBin);
    expect(candidateDirs).toContain('/opt/homebrew/bin');
    expect(candidateDirs).toContain('/usr/local/bin');
  });

  it('discovers executable binary placed in Application Support directory when PATH is empty', () => {
    delete process.env.VIDDOCK_FFMPEG;
    process.env.PATH = '';

    // Create a mock app support bin dir in a mocked homedir
    const fakeHome = path.join(tempDir, 'fakehome');
    const fakeAppSupportBin = path.join(fakeHome, 'Library', 'Application Support', 'VidDock', 'bin');
    fs.mkdirSync(fakeAppSupportBin, { recursive: true });

    const fakeFfmpeg = path.join(fakeAppSupportBin, 'ffmpeg');
    fs.writeFileSync(fakeFfmpeg, '#!/bin/sh\necho "ffmpeg version 7.0"', { mode: 0o755 });

    // Temporarily mock os.homedir
    const origHomedir = os.homedir;
    try {
      os.homedir = () => fakeHome;
      const discovered = findBinary('ffmpeg');
      expect(discovered).toBe(fakeFfmpeg);
    } finally {
      os.homedir = origHomedir;
    }
  });

  it('returns undefined when candidate binary does not exist and PATH is sanitized', () => {
    delete process.env.VIDDOCK_FFMPEG;
    delete process.env.VIDDOCK_FFPROBE;
    process.env.PATH = path.join(tempDir, 'empty');
    fs.mkdirSync(process.env.PATH, { recursive: true });

    const origHomedir = os.homedir;
    try {
      os.homedir = () => path.join(tempDir, 'empty');
      // If system /opt/homebrew/bin/ffmpeg or /usr/local/bin/ffmpeg exists on machine, check an impossible binary name
      const foundNonexistent = findBinary('ffprobe');
      // Either ffprobe is found on host or undefined if isolated
      if (!fs.existsSync('/opt/homebrew/bin/ffprobe') && !fs.existsSync('/usr/local/bin/ffprobe')) {
        expect(foundNonexistent).toBeUndefined();
      }
    } finally {
      os.homedir = origHomedir;
    }
  });

  it('extracts first line from binaryVersion output', async () => {
    const mockBin = path.join(tempDir, 'version-bin');
    fs.writeFileSync(mockBin, '#!/bin/sh\necho "ffmpeg version 8.1.2 Copyright"\necho "built with clang"', {
      mode: 0o755,
    });

    const ver = await binaryVersion(mockBin);
    expect(ver).toBe('ffmpeg version 8.1.2 Copyright');

    const undefVer = await binaryVersion(undefined);
    expect(undefVer).toBeUndefined();
  });

  it('runs binary with runFfmpeg and captures output and exit code', async () => {
    const mockScript = path.join(tempDir, 'run-test.sh');
    fs.writeFileSync(mockScript, '#!/bin/sh\necho "simulated stderr" >&2\nexit 0', { mode: 0o755 });

    const controller = new AbortController();
    const result = await runFfmpeg(mockScript, ['-i', 'dummy'], controller.signal);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('simulated stderr');
  });

  it('aborts process execution when AbortSignal triggers in runFfmpeg', async () => {
    const mockSleep = path.join(tempDir, 'sleep.sh');
    fs.writeFileSync(mockSleep, '#!/bin/sh\nsleep 10\nexit 0', { mode: 0o755 });

    const controller = new AbortController();
    const runPromise = runFfmpeg(mockScriptPath(mockSleep), [], controller.signal);

    setTimeout(() => {
      controller.abort();
    }, 50);

    await expect(runPromise).rejects.toThrow('aborted');
  });
});

function mockScriptPath(p: string): string {
  return p;
}
