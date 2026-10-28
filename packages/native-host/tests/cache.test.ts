import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeMessage, MessageDecoder } from '../src/framing.ts';
import {
  clearInactiveWorkDirs,
  DEFAULT_WORK_DIR_MAX_AGE_MS,
  getWorkDirCacheBytes,
  getWorkDirCacheInfo,
  pruneWorkDirs,
  TaskManager,
} from '../src/manager.ts';
import { HostServer } from '../src/server.ts';

describe('TASK-P2-02: Work Directory Cache Management & 24h Pruning', () => {
  let tempRoot: string;
  let workRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'viddock-cache-test-'));
    workRoot = path.join(tempRoot, 'work');
    fs.mkdirSync(workRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  });

  it('defines DEFAULT_WORK_DIR_MAX_AGE_MS as exactly 24 hours', () => {
    expect(DEFAULT_WORK_DIR_MAX_AGE_MS).toBe(24 * 3600 * 1000);
  });

  it('pruneWorkDirs removes directories older than 24 hours while preserving active and recent ones', () => {
    const staleDir = path.join(workRoot, 'task_stale');
    const recentDir = path.join(workRoot, 'task_recent');
    const keptDir = path.join(workRoot, 'task_kept');

    fs.mkdirSync(staleDir);
    fs.mkdirSync(recentDir);
    fs.mkdirSync(keptDir);

    const now = Date.now();
    const twentyFiveHoursAgo = (now - 25 * 3600 * 1000) / 1000;
    const twoHoursAgo = (now - 2 * 3600 * 1000) / 1000;
    const fortyEightHoursAgo = (now - 48 * 3600 * 1000) / 1000;

    fs.utimesSync(staleDir, twentyFiveHoursAgo, twentyFiveHoursAgo);
    fs.utimesSync(recentDir, twoHoursAgo, twoHoursAgo);
    fs.utimesSync(keptDir, fortyEightHoursAgo, fortyEightHoursAgo);

    const removed = pruneWorkDirs(workRoot, new Set(['task_kept']));

    expect(removed).toBe(1);
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(recentDir)).toBe(true);
    expect(fs.existsSync(keptDir)).toBe(true);
  });

  it('getWorkDirCacheInfo and getWorkDirCacheBytes accurately measure total directory size', () => {
    const taskDir1 = path.join(workRoot, 'task_1');
    const taskDir2 = path.join(workRoot, 'task_2');
    fs.mkdirSync(taskDir1);
    fs.mkdirSync(taskDir2);

    fs.writeFileSync(path.join(taskDir1, 'part_001.ts'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(taskDir1, 'part_002.ts'), Buffer.alloc(2048));
    fs.writeFileSync(path.join(taskDir2, 'audio.aac'), Buffer.alloc(4096));

    const totalBytes = getWorkDirCacheBytes(workRoot);
    expect(totalBytes).toBe(1024 + 2048 + 4096);

    const info = getWorkDirCacheInfo(workRoot);
    expect(info.bytes).toBe(7168);
    expect(info.dirCount).toBe(2);
  });

  it('clearInactiveWorkDirs purges only inactive task directories and calculates freed bytes', () => {
    const activeDir = path.join(workRoot, 'active_task');
    const staleDir = path.join(workRoot, 'dead_task');
    fs.mkdirSync(activeDir);
    fs.mkdirSync(staleDir);

    fs.writeFileSync(path.join(activeDir, 'active.ts'), Buffer.alloc(3000));
    fs.writeFileSync(path.join(staleDir, 'dead.ts'), Buffer.alloc(5000));

    const result = clearInactiveWorkDirs(workRoot, new Set(['active_task']));

    expect(result.removed).toBe(1);
    expect(result.freedBytes).toBe(5000);
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(activeDir)).toBe(true);
  });

  it('TaskManager getCacheInfo and clearCache preserve in-flight jobs', () => {
    const manager = new TaskManager({
      workRoot,
      onUpdate: () => {},
    });

    const activeFolder = path.join(workRoot, 'job_running');
    const completedFolder = path.join(workRoot, 'job_terminal');
    fs.mkdirSync(activeFolder);
    fs.mkdirSync(completedFolder);
    fs.writeFileSync(path.join(activeFolder, 'seg.ts'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(completedFolder, 'old.ts'), Buffer.alloc(2000));

    // Submit a job that remains non-terminal
    manager.submit({
      taskId: 'job_running',
      title: 'Active Job',
      fileName: 'active',
      container: 'mp4',
      tracks: [{ type: 'direct', url: 'https://example.com/v.mp4' }],
      subtitles: [],
      subtitleMode: 'none',
      headers: {},
      options: { segmentConcurrency: 2, maxRetries: 2, retryBaseMs: 500 },
    });

    const info = manager.getCacheInfo();
    expect(info.bytes).toBe(3000);
    expect(info.dirCount).toBe(2);

    const cleared = manager.clearCache();
    expect(cleared.removed).toBe(1);
    expect(cleared.freedBytes).toBe(2000);
    expect(fs.existsSync(completedFolder)).toBe(false);
    expect(fs.existsSync(activeFolder)).toBe(true);
  });

  it('HostServer replies to cache.info and cache.clear RPC requests via stdio framing', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new HostServer(stdin, stdout, { home: tempRoot });
    void server.start();

    // Populate a test file in server's workRoot
    const testTaskDir = path.join(tempRoot, 'work', 'test_rpc_task');
    fs.mkdirSync(testTaskDir, { recursive: true });
    fs.writeFileSync(path.join(testTaskDir, 'test.chunk'), Buffer.alloc(4096));

    const responses: unknown[] = [];
    const decoder = new MessageDecoder(
      (msg) => {
        responses.push(msg);
      },
      (err) => {
        throw err;
      },
    );
    stdout.on('data', (chunk) => decoder.push(chunk));

    // Send cache.info
    stdin.write(encodeMessage({ id: 'rpc_1', type: 'cache.info' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(responses.length).toBe(1);
    const infoReply = responses[0] as { id: string; ok: boolean; data: { bytes: number; dirCount: number } };
    expect(infoReply.id).toBe('rpc_1');
    expect(infoReply.ok).toBe(true);
    expect(infoReply.data.bytes).toBe(4096);
    expect(infoReply.data.dirCount).toBe(1);

    // Send cache.clear
    stdin.write(encodeMessage({ id: 'rpc_2', type: 'cache.clear' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(responses.length).toBe(2);
    const clearReply = responses[1] as { id: string; ok: boolean; data: { removed: number; freedBytes: number } };
    expect(clearReply.id).toBe('rpc_2');
    expect(clearReply.ok).toBe(true);
    expect(clearReply.data.removed).toBe(1);
    expect(clearReply.data.freedBytes).toBe(4096);

    stdin.end();
  });
});
