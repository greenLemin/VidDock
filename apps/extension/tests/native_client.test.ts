import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskInfo } from '@viddock/shared';
import { NativeClient } from '../src/background/native_client.ts';
import { setupChromeMock } from './mocks/chrome.ts';

describe('NativeClient Protocol & Reconnect Tests', () => {
  let mockEnv: ReturnType<typeof setupChromeMock>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockEnv = setupChromeMock();
  });

  it('performs handshake on connection and updates status', async () => {
    const client = new NativeClient();
    const port = mockEnv.getNativePort()!;
    expect(port).toBeDefined();

    // Port should have received the 'hello' request
    expect(port.messagesSent.length).toBe(1);
    const helloReq = port.messagesSent[0];
    expect(helloReq?.type).toBe('hello');
    expect(typeof helloReq?.id).toBe('string');

    // Simulate native companion reply
    port.simulateReceive({
      type: 'reply',
      id: helloReq?.id || '',
      ok: true,
      data: {
        protocol: 1,
        version: '1.0.0',
        platform: 'darwin',
        ffmpeg: '/opt/homebrew/bin/ffmpeg',
        ffprobe: '/opt/homebrew/bin/ffprobe',
        defaultOutputDir: '/Users/test/Downloads',
      },
    });

    await Promise.resolve();

    const status = client.getStatus();
    expect(status.connected).toBe(true);
    expect(status.version).toBe('1.0.0');
    expect(status.ffmpeg).toBe('/opt/homebrew/bin/ffmpeg');
  });

  it('resolves sendRequest when companion sends successful reply', async () => {
    const client = new NativeClient();
    const port = mockEnv.getNativePort()!;

    // Complete initial handshake
    port.simulateReceive({
      type: 'reply',
      id: port.messagesSent[0]?.id || '',
      ok: true,
      data: { version: '1.0.0' },
    });
    await Promise.resolve();

    // Send custom diagnostics request
    const promise = client.sendRequest({ type: 'diagnostics' });
    expect(port.messagesSent.length).toBe(2);
    const diagReq = port.messagesSent[1];
    expect(diagReq?.type).toBe('diagnostics');

    port.simulateReceive({
      type: 'reply',
      id: diagReq?.id || '',
      ok: true,
      data: { diskFreeBytes: 500000000 },
    });

    const result = await promise;
    expect(result).toEqual({ diskFreeBytes: 500000000 });
  });

  it('rejects sendRequest when companion sends error reply', async () => {
    const client = new NativeClient();
    const port = mockEnv.getNativePort()!;

    const promise = client.sendRequest({ type: 'download.pause', taskId: 'task_1' });
    const req = port.messagesSent.find((m) => m.type === 'download.pause');

    port.simulateReceive({
      type: 'reply',
      id: req?.id || '',
      ok: false,
      error: 'Task task_1 not found in host',
    });

    await expect(promise).rejects.toThrow('Task task_1 not found in host');
  });

  it('rejects sendRequest on timeout', async () => {
    const client = new NativeClient();
    const promise = client.sendRequest({ type: 'tasks.list' }, 3000);

    vi.advanceTimersByTime(3500);

    await expect(promise).rejects.toThrow('Host request timed out after 3000ms');
  });

  it('notifies onTaskUpdate listeners when companion emits task.update', () => {
    const client = new NativeClient();
    const port = mockEnv.getNativePort()!;

    const received: TaskInfo[] = [];
    client.onTaskUpdate((task) => {
      received.push(task);
    });

    const sampleTask: TaskInfo = {
      id: 'task_sample_1',
      title: 'Sample Video',
      state: 'downloading',
      progress: {
        bytesDownloaded: 1048576,
        bytesPerSec: 100000,
        segmentsDone: 5,
        segmentsTotal: 10,
        percent: 50,
        elapsedMs: 5000,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    port.simulateReceive({
      type: 'task.update',
      task: sampleTask,
    });

    expect(received.length).toBe(1);
    expect(received[0]?.id).toBe('task_sample_1');
    expect(received[0]?.progress.percent).toBe(50);
  });
});
