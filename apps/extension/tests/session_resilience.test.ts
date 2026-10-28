import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadTask, NativeDownloadRequest } from '@viddock/shared';
import { lifecycle } from '../src/background/lifecycle.ts';
import { NativeClient, nativeClient } from '../src/background/native_client.ts';
import { TaskCoordinator } from '../src/background/task_coordinator.ts';
import { setupChromeMock } from './mocks/chrome.ts';

describe('TASK-P1-03: Session Resilience & Orphan Task Recovery', () => {
  let mockEnv: ReturnType<typeof setupChromeMock>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockEnv = setupChromeMock();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const mockDownloadRequest: NativeDownloadRequest = {
    taskId: 'resilience_task_1',
    title: 'Distributed Systems Lecture',
    fileName: 'lecture_01',
    container: 'mp4',
    tracks: [{ type: 'direct', url: 'https://example.com/video.mp4' }],
    subtitles: [],
    subtitleMode: 'none',
    headers: {},
    options: { segmentConcurrency: 4, maxRetries: 3, retryBaseMs: 1000 },
  };

  const sampleActiveTask: DownloadTask = {
    id: 'resilience_task_1',
    title: 'Distributed Systems Lecture',
    state: 'downloading',
    engine: 'native',
    kind: 'direct',
    sourceUrl: 'https://example.com/video.mp4',
    pageUrl: 'https://example.com/course',
    request: mockDownloadRequest,
    progress: {
      bytesDownloaded: 5000000,
      bytesPerSec: 250000,
      segmentsDone: 10,
      segmentsTotal: 20,
      percent: 50,
      elapsedMs: 20000,
    },
    createdAt: Date.now() - 30000,
    updatedAt: Date.now() - 10000,
  };

  it('restores active native tasks as queued with interrupted: true on SW init', async () => {
    // Populate storage before coordinator.init()
    await chrome.storage.local.set({
      tasks: {
        [sampleActiveTask.id]: sampleActiveTask,
      },
    });

    const client = new NativeClient();
    const coordinator = new TaskCoordinator(client);
    await coordinator.init();

    const restored = coordinator.getTask('resilience_task_1');
    expect(restored).toBeDefined();
    expect(restored?.state).toBe('queued');
    expect(restored?.interrupted).toBe(true);
    expect(restored?.progress?.bytesPerSec).toBe(0);
    expect(restored?.progress?.etaMs).toBeUndefined();

    client.disconnect();
  });

  it('automatically resumes interrupted tasks when native companion connects', async () => {
    await chrome.storage.local.set({
      tasks: {
        [sampleActiveTask.id]: sampleActiveTask,
      },
    });

    const client = new NativeClient();
    const port = mockEnv.getNativePort()!;
    const coordinator = new TaskCoordinator(client);
    await coordinator.init();

    // Verify task is queued with interrupted: true
    expect(coordinator.getTask('resilience_task_1')?.interrupted).toBe(true);

    // Complete companion connection handshake
    port.simulateReceive({
      type: 'reply',
      id: port.messagesSent[0]?.id || '',
      ok: true,
      data: { version: '1.0.0' },
    });
    await Promise.resolve();
    await Promise.resolve();

    // Reconnection triggers resumeQueuedTasks() -> download.start is sent
    const startMsg = port.messagesSent.find(
      (m) =>
        m.type === 'download.start' && (m as { request?: { taskId: string } }).request?.taskId === 'resilience_task_1',
    );
    expect(startMsg).toBeDefined();

    // When companion updates task state to downloading, interrupted is cleared
    coordinator.handleNativeTaskUpdate({
      id: 'resilience_task_1',
      title: 'Distributed Systems Lecture',
      state: 'downloading',
      progress: {
        bytesDownloaded: 5200000,
        bytesPerSec: 200000,
        segmentsDone: 11,
        segmentsTotal: 20,
        percent: 52,
        elapsedMs: 21000,
      },
      createdAt: Date.now() - 30000,
      updatedAt: Date.now(),
    });

    const activeTask = coordinator.getTask('resilience_task_1');
    expect(activeTask?.state).toBe('downloading');
    expect(activeTask?.interrupted).toBe(false);

    client.disconnect();
  });

  it('marks active tasks with interrupted: true when native companion disconnects', async () => {
    await chrome.storage.local.set({
      tasks: {
        [sampleActiveTask.id]: sampleActiveTask,
      },
    });

    const client = new NativeClient();
    const port = mockEnv.getNativePort()!;
    const coordinator = new TaskCoordinator(client);
    await coordinator.init();

    // Complete handshake
    port.simulateReceive({
      type: 'reply',
      id: port.messagesSent[0]?.id || '',
      ok: true,
      data: { version: '1.0.0' },
    });
    await Promise.resolve();

    // Host updates task to downloading
    coordinator.handleNativeTaskUpdate({
      id: sampleActiveTask.id,
      title: sampleActiveTask.title,
      state: 'downloading',
      progress: {
        bytesDownloaded: 1000,
        bytesPerSec: 500,
        segmentsDone: 1,
        segmentsTotal: 10,
        percent: 10,
        elapsedMs: 2000,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(coordinator.getTask(sampleActiveTask.id)?.state).toBe('downloading');
    expect(coordinator.getTask(sampleActiveTask.id)?.interrupted).toBe(false);

    // Simulate host disconnection
    port.simulateDisconnect('Native host crashed');
    await Promise.resolve();

    const interruptedTask = coordinator.getTask(sampleActiveTask.id);
    expect(interruptedTask?.state).toBe('queued');
    expect(interruptedTask?.interrupted).toBe(true);

    client.disconnect();
  });

  it('watchdog alarm triggers nativeClient.connect() when interrupted tasks exist', async () => {
    // Populate storage with an interrupted task
    await chrome.storage.local.set({
      tasks: {
        [sampleActiveTask.id]: {
          ...sampleActiveTask,
          state: 'queued',
          interrupted: true,
        },
      },
    });

    // Disconnect default nativeClient
    nativeClient.disconnect();
    expect(nativeClient.getStatus().connected).toBe(false);

    const connectSpy = vi.spyOn(nativeClient, 'connect');

    // Trigger watchdog alarm
    await lifecycle.onAlarm({
      name: 'viddock-watchdog',
      scheduledTime: Date.now(),
      periodInMinutes: 0.5,
    });

    expect(connectSpy).toHaveBeenCalled();
    connectSpy.mockRestore();
    nativeClient.disconnect();
  });
});
