import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadTask, HostRequest, MediaItem, TaskInfo, TaskState } from '@viddock/shared';
import {
  applyFilenameTemplate,
  canTransition,
  emptyProgress,
  isActive,
  isTerminal,
  occupiesSlot,
  sanitizeFilename,
} from '@viddock/shared';
import { mediaStore } from '../src/background/media_store.ts';
import { NativeClient } from '../src/background/native_client.ts';
import { TaskCoordinator } from '../src/background/task_coordinator.ts';
import { setupChromeMock } from './mocks/chrome.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MockNativeClient {
  private taskListeners = new Set<(task: TaskInfo) => void>();
  private statusListeners = new Set<(status: { connected: boolean; error?: string }) => void>();
  public sentRequests: (HostRequest & { id?: string })[] = [];

  onTaskUpdate(listener: (task: TaskInfo) => void): () => void {
    this.taskListeners.add(listener);
    return () => this.taskListeners.delete(listener);
  }

  onStatusChange(listener: (status: { connected: boolean; error?: string }) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  simulateStatusChange(status: { connected: boolean; error?: string }) {
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  async sendRequest<T = unknown>(req: HostRequest & { id?: string }): Promise<T> {
    this.sentRequests.push(req);
    return { ok: true } as T;
  }

  simulateTaskUpdate(task: Partial<TaskInfo> & { id: string; state: TaskState }) {
    const fullTask: TaskInfo = {
      title: 'Test Task',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      progress: emptyProgress(),
      ...task,
    };
    for (const listener of this.taskListeners) {
      listener(fullTask);
    }
  }
}

function createTestMediaItem(
  partial: Partial<MediaItem> & { id: string; url: string; kind: MediaItem['kind'] },
): MediaItem {
  return {
    tabId: 1,
    title: 'Test Video',
    pageUrl: 'https://example.com/watch',
    qualities: [{ id: 'q1', label: '1080p', ref: partial.url }],
    audioTracks: [],
    subtitles: [],
    source: 'network',
    hasVideo: true,
    hasAudio: true,
    detectedAt: Date.now(),
    ...partial,
  };
}

describe('CHALLENGER Milestone 2: Empirical Stress Harness', () => {
  beforeEach(async () => {
    setupChromeMock();
    await mediaStore.clearTabMedia(1);
  });

  // =========================================================================
  // 1. Task Coordinator State Machine Transitions
  // =========================================================================
  describe('1. Task Coordinator State Machine Transitions', () => {
    it('enforces terminal state immutability (completed cannot transition to any active or terminal state)', () => {
      const allStates: TaskState[] = [
        'queued',
        'preparing',
        'downloading',
        'processing',
        'verifying',
        'completed',
        'paused',
        'failed',
        'cancelled',
      ];

      for (const targetState of allStates) {
        if (targetState === 'completed') {
          expect(canTransition('completed', targetState)).toBe(true); // reflexive
        } else {
          expect(canTransition('completed', targetState), `Expected completed -> ${targetState} to be forbidden`).toBe(
            false,
          );
        }
      }
    });

    it('enforces failure state transition constraints (failed can only transition to queued on retry)', () => {
      const disallowedFromFailed: TaskState[] = [
        'preparing',
        'downloading',
        'processing',
        'verifying',
        'completed',
        'paused',
        'cancelled',
      ];

      for (const target of disallowedFromFailed) {
        expect(canTransition('failed', target), `Expected failed -> ${target} to be forbidden`).toBe(false);
      }
      expect(canTransition('failed', 'queued')).toBe(true);
      expect(canTransition('failed', 'failed')).toBe(true);
    });

    it('enforces cancelled state transition constraints (cancelled can only transition to queued on retry)', () => {
      const disallowedFromCancelled: TaskState[] = [
        'preparing',
        'downloading',
        'processing',
        'verifying',
        'completed',
        'paused',
        'failed',
      ];

      for (const target of disallowedFromCancelled) {
        expect(canTransition('cancelled', target), `Expected cancelled -> ${target} to be forbidden`).toBe(false);
      }
      expect(canTransition('cancelled', 'queued')).toBe(true);
      expect(canTransition('cancelled', 'cancelled')).toBe(true);
    });

    it('validates entire happy path pipeline: queued -> preparing -> downloading -> processing -> verifying -> completed', () => {
      const sequence: TaskState[] = ['queued', 'preparing', 'downloading', 'processing', 'verifying', 'completed'];
      for (let i = 0; i < sequence.length - 1; i++) {
        const from = sequence[i]!;
        const to = sequence[i + 1]!;
        expect(canTransition(from, to), `Expected transition ${from} -> ${to} to be valid`).toBe(true);
      }
    });

    it('validates pause and resume cycles', () => {
      expect(canTransition('downloading', 'paused')).toBe(true);
      expect(canTransition('paused', 'downloading')).toBe(true);
      expect(canTransition('preparing', 'paused')).toBe(true);
      expect(canTransition('paused', 'preparing')).toBe(true);
      expect(canTransition('paused', 'queued')).toBe(true);
      expect(canTransition('paused', 'cancelled')).toBe(true);
    });

    it('empirically drops invalid state transitions inside TaskCoordinator without mutating task state', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const mediaItem = createTestMediaItem({
        id: 'item-stream-1',
        tabId: 1,
        url: 'https://example.com/master.m3u8',
        pageUrl: 'https://example.com/watch?v=1',
        kind: 'hls',
        title: 'State Transition Test',
        qualities: [{ id: 'q1', label: '1080p', ref: 'https://example.com/1080.m3u8' }],
      });
      await mediaStore.addMediaItem(mediaItem);

      const { taskId } = await coordinator.startDownload({ itemId: 'item-stream-1' });
      const task = coordinator.getTask(taskId);
      expect(task).toBeDefined();
      expect(task!.state).toBe('queued');

      // Valid: queued -> downloading
      mockClient.simulateTaskUpdate({
        id: taskId,
        state: 'downloading',
        progress: { ...emptyProgress(), percent: 25 },
      });
      expect(coordinator.getTask(taskId)!.state).toBe('downloading');

      // Valid: downloading -> completed
      mockClient.simulateTaskUpdate({
        id: taskId,
        state: 'completed',
        progress: { ...emptyProgress(), percent: 100 },
        outputPath: '/path/to/video.mp4',
        outputBytes: 1048576,
      });
      expect(coordinator.getTask(taskId)!.state).toBe('completed');
      expect(coordinator.getTask(taskId)!.outputPath).toBe('/path/to/video.mp4');

      // INVALID: Late-arriving downloading update after completion MUST BE DROPPED
      mockClient.simulateTaskUpdate({
        id: taskId,
        state: 'downloading',
        progress: { ...emptyProgress(), percent: 50 },
      });
      expect(coordinator.getTask(taskId)!.state).toBe('completed');
      expect(coordinator.getTask(taskId)!.progress.percent).toBe(100);

      // INVALID: Late-arriving failed update after completion MUST BE DROPPED
      mockClient.simulateTaskUpdate({
        id: taskId,
        state: 'failed',
        error: 'Network connection severed',
        progress: { ...emptyProgress(), percent: 50 },
      });
      expect(coordinator.getTask(taskId)!.state).toBe('completed');
      expect(coordinator.getTask(taskId)!.error).toBeUndefined();
    });

    it('correctly tracks slot occupancy and active state properties', () => {
      expect(isActive('queued')).toBe(false);
      expect(occupiesSlot('queued')).toBe(false);
      expect(isTerminal('queued')).toBe(false);

      expect(isActive('preparing')).toBe(true);
      expect(occupiesSlot('preparing')).toBe(true);

      expect(isActive('downloading')).toBe(true);
      expect(occupiesSlot('downloading')).toBe(true);

      expect(isActive('processing')).toBe(true);
      expect(occupiesSlot('processing')).toBe(true);

      expect(isActive('verifying')).toBe(true);
      expect(occupiesSlot('verifying')).toBe(true);

      expect(isActive('completed')).toBe(false);
      expect(occupiesSlot('completed')).toBe(false);
      expect(isTerminal('completed')).toBe(true);

      expect(isActive('failed')).toBe(false);
      expect(occupiesSlot('failed')).toBe(false);
      expect(isTerminal('failed')).toBe(true);

      expect(isActive('cancelled')).toBe(false);
      expect(occupiesSlot('cancelled')).toBe(false);
      expect(isTerminal('cancelled')).toBe(true);
    });
  });

  // =========================================================================
  // 2. Concurrent Task Additions & Queue Management
  // =========================================================================
  describe('2. Concurrent Task Operations & Queue Management', () => {
    it('handles 20 concurrent task additions simultaneously with zero ID collisions', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const items: MediaItem[] = [];
      for (let i = 0; i < 20; i++) {
        const item = createTestMediaItem({
          id: `item-concurrent-${i}`,
          tabId: 1,
          url: `https://example.com/video_${i}.mp4`,
          pageUrl: `https://example.com/page_${i}`,
          kind: 'direct',
          title: `Concurrent Video ${i}`,
          qualities: [{ id: `q${i}`, label: '720p', ref: `https://example.com/video_${i}.mp4` }],
        });
        items.push(item);
        await mediaStore.addMediaItem(item);
      }

      // Concurrently start all 20 downloads
      const startPromises = items.map((item) => coordinator.startDownload({ itemId: item.id }));
      const results = await Promise.all(startPromises);

      // Verify all IDs are unique
      const taskIds = results.map((r) => r.taskId);
      const uniqueIds = new Set(taskIds);
      expect(uniqueIds.size).toBe(20);

      // Verify coordinator has all 20 tasks
      const allTasks = coordinator.getTasks();
      expect(allTasks.length).toBe(20);

      // Verify tasks are sorted descending by createdAt
      for (let i = 0; i < allTasks.length - 1; i++) {
        expect(allTasks[i]!.createdAt).toBeGreaterThanOrEqual(allTasks[i + 1]!.createdAt);
      }
    });

    it('empirically clears completed, cancelled, and failed tasks while preserving active/queued tasks', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const statesToTest: TaskState[] = ['queued', 'downloading', 'completed', 'failed', 'cancelled'];
      const taskIds: string[] = [];

      for (let i = 0; i < statesToTest.length; i++) {
        const state = statesToTest[i]!;
        const item = createTestMediaItem({
          id: `item-clear-${i}`,
          tabId: 1,
          url: `https://example.com/clear_${i}.m3u8`,
          pageUrl: 'https://example.com/clear',
          kind: 'hls',
          title: `Clear Task ${state}`,
          qualities: [{ id: 'q', label: '1080p', ref: 'https://example.com/clear.m3u8' }],
        });
        await mediaStore.addMediaItem(item);
        const { taskId } = await coordinator.startDownload({ itemId: item.id });
        taskIds.push(taskId);

        if (state !== 'queued') {
          if (state === 'downloading') {
            mockClient.simulateTaskUpdate({ id: taskId, state: 'downloading', progress: emptyProgress() });
          } else if (state === 'completed') {
            mockClient.simulateTaskUpdate({ id: taskId, state: 'downloading', progress: emptyProgress() });
            mockClient.simulateTaskUpdate({ id: taskId, state: 'completed', progress: emptyProgress() });
          } else if (state === 'failed') {
            mockClient.simulateTaskUpdate({ id: taskId, state: 'failed', progress: emptyProgress() });
          } else if (state === 'cancelled') {
            mockClient.simulateTaskUpdate({ id: taskId, state: 'cancelled', progress: emptyProgress() });
          }
        }
      }

      expect(coordinator.getTasks().length).toBe(5);

      // Clear completed
      await coordinator.clearCompleted();

      const remaining = coordinator.getTasks();
      expect(remaining.length).toBe(2);
      const remainingStates = remaining.map((t) => t.state);
      expect(remainingStates).toContain('queued');
      expect(remainingStates).toContain('downloading');
      expect(remainingStates).not.toContain('completed');
      expect(remainingStates).not.toContain('failed');
      expect(remainingStates).not.toContain('cancelled');
    });

    it('reconciles interrupted tasks across service worker restarts into queued state', async () => {
      // Simulate stored active task in storage
      const interruptedTask = {
        id: 'interrupted-task-1',
        engine: 'native',
        kind: 'hls',
        title: 'Interrupted Video',
        sourceUrl: 'https://example.com/stream.m3u8',
        pageUrl: 'https://example.com/watch',
        state: 'downloading',
        progress: emptyProgress(),
        request: {
          taskId: 'interrupted-task-1',
          title: 'Interrupted Video',
          fileName: 'interrupted_video',
          container: 'mp4',
          tracks: [{ type: 'hls', url: 'https://example.com/stream.m3u8' }],
          subtitles: [],
          subtitleMode: 'none',
          headers: {},
          options: { segmentConcurrency: 6, maxRetries: 5, retryBaseMs: 1000 },
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await chrome.storage.local.set({ tasks: { 'interrupted-task-1': interruptedTask } });

      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const task = coordinator.getTask('interrupted-task-1');
      expect(task).toBeDefined();
      // Must be reconciled from downloading to queued
      expect(task?.state).toBe('queued');

      // Can be started
      await coordinator.handleTaskAction('interrupted-task-1', 'force-start');
      expect(mockClient.sentRequests.some((r) => r.type === 'download.start')).toBe(true);

      // Or can be removed
      await coordinator.handleTaskAction('interrupted-task-1', 'remove');
      expect(coordinator.getTask('interrupted-task-1')).toBeUndefined();
    });

    it('provides actionable controls for queued tasks: force-start, cancel, and remove', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const item = createTestMediaItem({
        id: 'item-queue-test',
        tabId: 1,
        url: 'https://example.com/queue.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Queue Test Video',
        qualities: [{ id: 'q', label: '1080p', ref: 'https://example.com/queue.m3u8' }],
      });
      await mediaStore.addMediaItem(item);

      const { taskId } = await coordinator.startDownload({ itemId: item.id });
      const task = coordinator.getTask(taskId);
      expect(task?.state).toBe('queued');

      // Test cancel
      await coordinator.handleTaskAction(taskId, 'cancel');
      expect(coordinator.getTask(taskId)?.state).toBe('cancelled');

      // Test force-start (re-queue and submit)
      mockClient.sentRequests = [];
      await coordinator.handleTaskAction(taskId, 'force-start');
      expect(coordinator.getTask(taskId)?.state).toBe('queued');
      expect(mockClient.sentRequests.some((r) => r.type === 'download.start')).toBe(true);

      // Test remove
      await coordinator.handleTaskAction(taskId, 'remove');
      expect(coordinator.getTask(taskId)).toBeUndefined();
    });

    it('reconciles active tasks to queued on companion disconnect', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const item = createTestMediaItem({
        id: 'item-active-test',
        tabId: 1,
        url: 'https://example.com/stream.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Active Stream',
      });
      await mediaStore.addMediaItem(item);

      const { taskId } = await coordinator.startDownload({ itemId: item.id });
      // Simulate task moving to downloading
      mockClient.simulateTaskUpdate({
        id: taskId,
        state: 'downloading',
        progress: {
          bytesDownloaded: 1000,
          bytesPerSec: 500,
          segmentsDone: 1,
          segmentsTotal: 10,
          percent: 10,
          elapsedMs: 2000,
          etaMs: 18000,
        },
      });
      expect(coordinator.getTask(taskId)?.state).toBe('downloading');

      // Simulate native companion disconnection
      mockClient.simulateStatusChange({ connected: false });

      const reconciledTask = coordinator.getTask(taskId);
      expect(reconciledTask?.state).toBe('queued');
      expect(reconciledTask?.progress.bytesPerSec).toBe(0);
      expect(reconciledTask?.progress.etaMs).toBeUndefined();
    });

    it('reconciles active native tasks when production NativeClient disconnects', async () => {
      const mockEnv = setupChromeMock();
      const realClient = new NativeClient();
      const port = mockEnv.getNativePort()!;
      expect(port).toBeDefined();

      const coordinator = new TaskCoordinator(realClient);
      await coordinator.init();

      const item = createTestMediaItem({
        id: 'ms_real_disconnect_1',
        title: 'Production Disconnect Test',
        source: 'mediasite',
        kind: 'hls',
        url: 'https://example.com/master.m3u8',
      });
      await mediaStore.addMediaItem(item);

      const { taskId } = await coordinator.startDownload({ itemId: item.id });
      coordinator.handleNativeTaskUpdate({
        id: taskId,
        title: item.title,
        state: 'downloading',
        progress: {
          bytesDownloaded: 5000,
          bytesPerSec: 1000,
          segmentsDone: 2,
          segmentsTotal: 10,
          percent: 20,
          elapsedMs: 5000,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(coordinator.getTask(taskId)?.state).toBe('downloading');

      // Simulate genuine native host port disconnect
      port.simulateDisconnect('Native companion host process died');

      const reconciledTask = coordinator.getTask(taskId);
      expect(reconciledTask?.state).toBe('queued');
      expect(reconciledTask?.progress.bytesPerSec).toBe(0);
      expect(reconciledTask?.progress.etaMs).toBeUndefined();
    });

    it('reconstructs missing request and starts task on force-start', async () => {
      const legacyTask: DownloadTask = {
        id: 'legacy-task-1',
        title: 'Legacy Video',
        engine: 'native',
        kind: 'hls',
        sourceUrl: 'https://example.com/legacy.m3u8',
        pageUrl: 'https://example.com/watch',
        state: 'queued',
        progress: emptyProgress(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await chrome.storage.local.set({ tasks: { 'legacy-task-1': legacyTask } });

      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      mockClient.sentRequests = [];
      await coordinator.handleTaskAction('legacy-task-1', 'force-start');
      expect(coordinator.getTask('legacy-task-1')?.state).toBe('queued');
      expect(coordinator.getTask('legacy-task-1')?.request).toBeDefined();
      expect(mockClient.sentRequests.some((r) => r.type === 'download.start')).toBe(true);
    });

    it('reconstructs request and retries legacy failed task on retry action', async () => {
      const legacyFailedTask: DownloadTask = {
        id: 'legacy-failed-1',
        title: 'Old Failed Lecture',
        sourceUrl: 'https://example.com/failed.m3u8',
        pageUrl: 'https://example.com/watch',
        state: 'failed',
        engine: 'native',
        kind: 'hls',
        progress: emptyProgress(),
        createdAt: Date.now() - 100000,
        updatedAt: Date.now() - 50000,
      };
      await chrome.storage.local.set({ tasks: { 'legacy-failed-1': legacyFailedTask } });

      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      mockClient.sentRequests = [];
      await coordinator.handleTaskAction('legacy-failed-1', 'retry');
      expect(coordinator.getTask('legacy-failed-1')?.state).toBe('queued');
      expect(coordinator.getTask('legacy-failed-1')?.request).toBeDefined();
      expect(mockClient.sentRequests.some((r) => r.type === 'download.start')).toBe(true);
    });

    it('reconciles tasks correctly when stored.tasks is an Array', async () => {
      const activeTaskInArray: DownloadTask = {
        id: 'array-task-1',
        title: 'Array Task',
        sourceUrl: 'https://example.com/array.m3u8',
        pageUrl: 'https://example.com/watch',
        state: 'downloading',
        engine: 'native',
        kind: 'hls',
        progress: emptyProgress(),
        createdAt: Date.now() - 20000,
        updatedAt: Date.now() - 10000,
      };
      await chrome.storage.local.set({ tasks: [activeTaskInArray] as unknown as Record<string, DownloadTask> });

      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const task = coordinator.getTask('array-task-1');
      expect(task).toBeDefined();
      expect(task?.state).toBe('queued');
    });

    it('persists and updates dualStreamLayout in settings', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      expect((await coordinator.getSettings()).dualStreamLayout).toBe('side-by-side');

      await coordinator.setSettings({ dualStreamLayout: 'pip' });
      expect((await coordinator.getSettings()).dualStreamLayout).toBe('pip');

      await coordinator.setSettings({ dualStreamLayout: 'separate' });
      expect((await coordinator.getSettings()).dualStreamLayout).toBe('separate');
    });

    it('bundles multi-feed Mediasite presentation into single composite request in side-by-side layout', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const groupId = 'group_lecture_123';
      const camItem = createTestMediaItem({
        id: `ms_${groupId}_0`,
        tabId: 1,
        url: 'https://example.com/cam.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Algorithms 101 - Primary video',
        source: 'mediasite',
        groupId,
        trackLabel: 'Primary video',
        hasVideo: true,
        hasAudio: false,
      });

      const slideItem = createTestMediaItem({
        id: `ms_${groupId}_1`,
        tabId: 1,
        url: 'https://example.com/slides.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Algorithms 101 - Secondary video',
        source: 'mediasite',
        groupId,
        trackLabel: 'Secondary video',
        hasVideo: true,
        hasAudio: false,
      });

      const audioItem = createTestMediaItem({
        id: `ms_${groupId}_2`,
        tabId: 1,
        url: 'https://example.com/mic.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Algorithms 101 - Audio',
        source: 'mediasite',
        groupId,
        trackLabel: 'Audio',
        hasVideo: false,
        hasAudio: true,
      });

      await mediaStore.addMediaItem(camItem);
      await mediaStore.addMediaItem(slideItem);
      await mediaStore.addMediaItem(audioItem);

      const { taskId } = await coordinator.startDownload({
        itemId: camItem.id,
        layout: 'side-by-side',
      });

      const task = coordinator.getTask(taskId);
      expect(task).toBeDefined();
      const req = task?.request;
      expect(req).toBeDefined();
      expect(req?.layout).toBe('side-by-side');
      expect(req?.title).toBe('Algorithms 101');
      // Should bundle camera, slides, and audio into tracks
      expect(req?.tracks.length).toBe(3);
      expect(req?.tracks[0]?.url).toBe('https://example.com/cam.m3u8');
      expect(req?.tracks[1]?.url).toBe('https://example.com/slides.m3u8');
      expect(req?.tracks[2]?.url).toBe('https://example.com/mic.m3u8');
    });

    it('ensures slides feed is primary canvas and camera is overlay inset in pip layout', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const groupId = 'group_pip_test';
      const camItem = createTestMediaItem({
        id: `ms_${groupId}_0`,
        tabId: 1,
        url: 'https://example.com/cam.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Physics 200 - Presenter Camera',
        source: 'mediasite',
        groupId,
        trackLabel: 'Presenter Camera',
        hasVideo: true,
        hasAudio: false,
      });

      const slideItem = createTestMediaItem({
        id: `ms_${groupId}_1`,
        tabId: 1,
        url: 'https://example.com/slides.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Physics 200 - Presentation Slides',
        source: 'mediasite',
        groupId,
        trackLabel: 'Presentation Slides',
        hasVideo: true,
        hasAudio: false,
      });

      await mediaStore.addMediaItem(camItem);
      await mediaStore.addMediaItem(slideItem);

      const { taskId } = await coordinator.startDownload({
        itemId: camItem.id,
        layout: 'pip',
      });

      const task = coordinator.getTask(taskId);
      const req = task?.request;
      expect(req).toBeDefined();
      expect(req?.layout).toBe('pip');
      // Slides feed should be primary canvas (track 0), camera should be overlay inset (track 1)
      expect(req?.tracks[0]?.url).toBe('https://example.com/slides.m3u8');
      expect(req?.tracks[1]?.url).toBe('https://example.com/cam.m3u8');
    });

    it('ensures slides feed is primary canvas and camera is overlay inset in pip layout with default Mediasite labels', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const groupId = 'group_pip_default_labels';
      // Default Mediasite labels produced by streamLabel()
      const camItem = createTestMediaItem({
        id: `ms_${groupId}_0`,
        tabId: 1,
        url: 'https://example.com/cam.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Algorithms 101 - Primary video',
        source: 'mediasite',
        groupId,
        trackLabel: 'Primary video',
        hasVideo: true,
        hasAudio: false,
      });

      const slideItem = createTestMediaItem({
        id: `ms_${groupId}_1`,
        tabId: 1,
        url: 'https://example.com/slides.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Algorithms 101 - Secondary video (stream 2, type 1)',
        source: 'mediasite',
        groupId,
        trackLabel: 'Secondary video (stream 2, type 1)',
        hasVideo: true,
        hasAudio: false,
      });

      await mediaStore.addMediaItem(camItem);
      await mediaStore.addMediaItem(slideItem);

      const { taskId } = await coordinator.startDownload({
        itemId: camItem.id,
        layout: 'pip',
      });

      const task = coordinator.getTask(taskId);
      const req = task?.request;
      expect(req).toBeDefined();
      expect(req?.layout).toBe('pip');
      // Secondary video (slides, type 1) should be primary canvas (track 0), Primary video (camera) should be inset (track 1)
      expect(req?.tracks[0]?.url).toBe('https://example.com/slides.m3u8');
      expect(req?.tracks[1]?.url).toBe('https://example.com/cam.m3u8');
    });

    it('bundles 3 video feeds in PiP layout ensuring slides feed is selected for track 0 (primary canvas) over camera feeds', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const groupId = 'group_pip_3feeds';
      const cam1 = createTestMediaItem({
        id: `ms_${groupId}_0`,
        tabId: 1,
        url: 'https://example.com/cam1.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Algorithms 101 - Primary video',
        source: 'mediasite',
        groupId,
        trackLabel: 'Primary video',
        hasVideo: true,
        hasAudio: false,
      });

      const cam2 = createTestMediaItem({
        id: `ms_${groupId}_1`,
        tabId: 1,
        url: 'https://example.com/cam2.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Algorithms 101 - Secondary video (stream 2, type 0)',
        source: 'mediasite',
        groupId,
        trackLabel: 'Secondary video (stream 2, type 0)',
        hasVideo: true,
        hasAudio: false,
      });

      const slides = createTestMediaItem({
        id: `ms_${groupId}_2`,
        tabId: 1,
        url: 'https://example.com/slides3.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Algorithms 101 - Secondary video (stream 3, type 1)',
        source: 'mediasite',
        groupId,
        trackLabel: 'Secondary video (stream 3, type 1)',
        hasVideo: true,
        hasAudio: false,
      });

      await mediaStore.addMediaItem(cam1);
      await mediaStore.addMediaItem(cam2);
      await mediaStore.addMediaItem(slides);

      const { taskId } = await coordinator.startDownload({
        itemId: cam1.id,
        layout: 'pip',
      });

      const task = coordinator.getTask(taskId);
      const req = task?.request;
      expect(req).toBeDefined();
      expect(req?.layout).toBe('pip');
      // Secondary video stream 3 (slides, type 1) must be track 0 (main canvas)
      expect(req?.tracks[0]?.url).toBe('https://example.com/slides3.m3u8');
    });

    it('downloads separate streams as independent files when layout is separate', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const groupId = 'group_sep_test';
      const camItem = createTestMediaItem({
        id: `ms_${groupId}_0`,
        tabId: 1,
        url: 'https://example.com/cam.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Biology 101 - Primary video',
        source: 'mediasite',
        groupId,
        trackLabel: 'Primary video',
        hasVideo: true,
        hasAudio: true,
      });

      const slideItem = createTestMediaItem({
        id: `ms_${groupId}_1`,
        tabId: 1,
        url: 'https://example.com/slides.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Biology 101 - Secondary video',
        source: 'mediasite',
        groupId,
        trackLabel: 'Secondary video',
        hasVideo: true,
        hasAudio: false,
      });

      await mediaStore.addMediaItem(camItem);
      await mediaStore.addMediaItem(slideItem);

      mockClient.sentRequests = [];
      await coordinator.startDownload({
        itemId: camItem.id,
        layout: 'separate',
      });

      // Should have queued 2 separate download tasks
      const allTasks = coordinator.getTasks();
      const groupTasks = allTasks.filter((t) => t.title.includes('Biology 101'));
      expect(groupTasks.length).toBe(2);

      const downloadStartRequests = mockClient.sentRequests.filter((r) => r.type === 'download.start');
      expect(downloadStartRequests.length).toBe(2);
    });

    it('bundles 3 video feeds in Side-by-Side layout prioritizing camera and slides feeds over duplicate camera', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const groupId = 'group_sbs_3feeds';
      const cam1 = createTestMediaItem({
        id: `ms_${groupId}_0`,
        tabId: 1,
        url: 'https://example.com/cam1.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Algorithms 101 - Primary video',
        source: 'mediasite',
        groupId,
        trackLabel: 'Primary video',
        hasVideo: true,
        hasAudio: false,
      });

      const cam2 = createTestMediaItem({
        id: `ms_${groupId}_1`,
        tabId: 1,
        url: 'https://example.com/cam2.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Algorithms 101 - Secondary video (stream 2, type 0)',
        source: 'mediasite',
        groupId,
        trackLabel: 'Secondary video (stream 2, type 0)',
        hasVideo: true,
        hasAudio: false,
      });

      const slides = createTestMediaItem({
        id: `ms_${groupId}_2`,
        tabId: 1,
        url: 'https://example.com/slides3.m3u8',
        pageUrl: 'https://example.com/watch',
        kind: 'hls',
        title: 'Algorithms 101 - Secondary video (stream 3, type 1)',
        source: 'mediasite',
        groupId,
        trackLabel: 'Secondary video (stream 3, type 1)',
        hasVideo: true,
        hasAudio: false,
      });

      await mediaStore.addMediaItem(cam1);
      await mediaStore.addMediaItem(cam2);
      await mediaStore.addMediaItem(slides);

      const { taskId } = await coordinator.startDownload({
        itemId: cam1.id,
        layout: 'side-by-side',
      });

      const task = coordinator.getTask(taskId);
      const req = task?.request;
      expect(req).toBeDefined();
      expect(req?.layout).toBe('side-by-side');
      // Secondary video stream 3 (slides) must be present in tracks alongside camera
      const trackUrls = req?.tracks.map((t) => t.url);
      expect(trackUrls).toContain('https://example.com/slides3.m3u8');
      expect(trackUrls).toContain('https://example.com/cam1.m3u8');
    });
  });

  // =========================================================================
  // 3. Fallback Engine Routing
  // =========================================================================
  describe('3. Fallback Engine Routing', () => {
    it('routes direct video to Chrome downloads when directViaChrome is true', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();
      await coordinator.setSettings({ directViaChrome: true });

      const item = createTestMediaItem({
        id: 'direct-chrome-item',
        tabId: 1,
        url: 'https://example.com/video.mp4',
        pageUrl: 'https://example.com/page',
        kind: 'direct',
        title: 'Direct Video MP4',
        qualities: [{ id: 'q1', label: '1080p', ref: 'https://example.com/video.mp4' }],
      });
      await mediaStore.addMediaItem(item);

      const { taskId } = await coordinator.startDownload({ itemId: 'direct-chrome-item' });
      const task = coordinator.getTask(taskId);

      expect(task).toBeDefined();
      expect(task!.engine).toBe('chrome');
      expect(task!.state).toBe('downloading');
      expect(task!.chromeDownloadId).toBeDefined();
      expect(mockClient.sentRequests.filter((r) => r.type === 'download.start').length).toBe(0);
    });

    it('routes direct video to native companion when directViaChrome is false', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();
      await coordinator.setSettings({ directViaChrome: false });

      const item = createTestMediaItem({
        id: 'direct-native-item',
        tabId: 1,
        url: 'https://example.com/video_native.mp4',
        pageUrl: 'https://example.com/page_native',
        kind: 'direct',
        title: 'Direct Video via Host',
        qualities: [{ id: 'q1', label: '1080p', ref: 'https://example.com/video_native.mp4' }],
      });
      await mediaStore.addMediaItem(item);

      const { taskId } = await coordinator.startDownload({ itemId: 'direct-native-item' });
      const task = coordinator.getTask(taskId);

      expect(task).toBeDefined();
      expect(task!.engine).toBe('native');
      expect(task!.state).toBe('queued');
      expect(mockClient.sentRequests.some((r) => r.type === 'download.start')).toBe(true);
    });

    it('always routes HLS streams to native companion even if directViaChrome is true', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();
      await coordinator.setSettings({ directViaChrome: true });

      const item = createTestMediaItem({
        id: 'hls-item-1',
        tabId: 1,
        url: 'https://example.com/stream.m3u8',
        pageUrl: 'https://example.com/page',
        kind: 'hls',
        title: 'HLS Live Stream',
        qualities: [{ id: 'q1', label: '1080p', ref: 'https://example.com/1080p.m3u8' }],
      });
      await mediaStore.addMediaItem(item);

      const { taskId } = await coordinator.startDownload({ itemId: 'hls-item-1' });
      const task = coordinator.getTask(taskId);

      expect(task).toBeDefined();
      expect(task!.engine).toBe('native');
      expect(task!.state).toBe('queued');

      const downloadReq = mockClient.sentRequests.find((r) => r.type === 'download.start');
      expect(downloadReq).toBeDefined();
      expect((downloadReq as { request?: { tracks?: { type: string }[] } }).request?.tracks?.[0]?.type).toBe('hls');
    });

    it('always routes DASH streams to native companion even if directViaChrome is true', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();
      await coordinator.setSettings({ directViaChrome: true });

      const item = createTestMediaItem({
        id: 'dash-item-1',
        tabId: 1,
        url: 'https://example.com/manifest.mpd',
        pageUrl: 'https://example.com/page',
        kind: 'dash',
        title: 'DASH VOD Stream',
        qualities: [{ id: 'q1', label: '1080p', ref: 'rep_video_1080' }],
      });
      await mediaStore.addMediaItem(item);

      const { taskId } = await coordinator.startDownload({ itemId: 'dash-item-1' });
      const task = coordinator.getTask(taskId);

      expect(task).toBeDefined();
      expect(task!.engine).toBe('native');

      const downloadReq = mockClient.sentRequests.find((r) => r.type === 'download.start');
      expect(downloadReq).toBeDefined();
      expect((downloadReq as { request?: { tracks?: { type: string }[] } }).request?.tracks?.[0]?.type).toBe('dash');
    });

    it('seamlessly falls back to native companion if chrome.downloads is unavailable', async () => {
      const originalDownloads = (globalThis as unknown as { chrome: { downloads?: unknown } }).chrome.downloads;
      try {
        // Simulate missing chrome.downloads API
        (globalThis as unknown as { chrome: { downloads?: unknown } }).chrome.downloads = undefined;

        const mockClient = new MockNativeClient();
        const coordinator = new TaskCoordinator(
          mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
        );
        await coordinator.init();
        await coordinator.setSettings({ directViaChrome: true });

        const item = createTestMediaItem({
          id: 'direct-fallback-item',
          tabId: 1,
          url: 'https://example.com/direct_fallback.mp4',
          pageUrl: 'https://example.com/page',
          kind: 'direct',
          title: 'Direct Fallback Video',
          qualities: [{ id: 'q1', label: '720p', ref: 'https://example.com/direct_fallback.mp4' }],
        });
        await mediaStore.addMediaItem(item);

        const { taskId } = await coordinator.startDownload({ itemId: 'direct-fallback-item' });
        const task = coordinator.getTask(taskId);

        expect(task).toBeDefined();
        expect(task!.engine).toBe('native');
        expect(task!.state).toBe('queued');
        expect(mockClient.sentRequests.some((r) => r.type === 'download.start')).toBe(true);
      } finally {
        (globalThis as unknown as { chrome: { downloads?: unknown } }).chrome.downloads = originalDownloads;
      }
    });

    it('preserves genuine audio extension (.mp3) for direct audio downloads via Chrome engine instead of hardcoding .mp4', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();
      await coordinator.setSettings({ directViaChrome: true });

      const downloadSpy = vi.spyOn(chrome.downloads, 'download');

      const item = createTestMediaItem({
        id: 'direct-audio-mp3',
        tabId: 1,
        url: 'https://example.com/podcast_interview.mp3',
        pageUrl: 'https://example.com/page',
        kind: 'direct',
        title: 'Podcast Episode 42',
        mimeType: 'audio/mp3',
        qualities: [{ id: 'q1', label: 'Original', ref: 'https://example.com/podcast_interview.mp3' }],
      });
      await mediaStore.addMediaItem(item);

      await coordinator.startDownload({ itemId: 'direct-audio-mp3' });
      expect(downloadSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: expect.stringMatching(/\.mp3$/),
        }),
      );
      downloadSpy.mockRestore();
    });

    it('sends download.remove to native companion when clearCompleted removes finished/failed/cancelled tasks', async () => {
      const mockClient = new MockNativeClient();
      const coordinator = new TaskCoordinator(
        mockClient as unknown as import('../src/background/native_client.ts').NativeClient,
      );
      await coordinator.init();

      const item = createTestMediaItem({
        id: 'item-to-clear',
        tabId: 1,
        url: 'https://example.com/video.m3u8',
        pageUrl: 'https://example.com/page',
        kind: 'hls',
        title: 'Finished Task',
      });
      await mediaStore.addMediaItem(item);
      const { taskId } = await coordinator.startDownload({ itemId: 'item-to-clear' });

      mockClient.simulateTaskUpdate({ id: taskId, state: 'downloading', progress: emptyProgress() });
      mockClient.simulateTaskUpdate({ id: taskId, state: 'completed', progress: emptyProgress() });

      mockClient.sentRequests = [];
      await coordinator.clearCompleted();

      const removeReq = mockClient.sentRequests.find(
        (r) => r.type === 'download.remove' && (r as { taskId?: string }).taskId === taskId,
      );
      expect(removeReq).toBeDefined();
    });
  });

  // =========================================================================
  // 4. Filename Template Builder & Sanitization Stress Tests
  // =========================================================================
  describe('4. Filename Template Builder & Sanitization Stress Tests', () => {
    it('neutralizes malicious path traversal payloads in input title', () => {
      const maliciousTitles = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32\\cmd.exe',
        '../../../../../../var/log/syslog',
        '....//....//....//sensitive_file.mp4',
        '/root/secret.mp4',
        'C:\\secret\\bank_records.pdf',
        '..\\..\\..\\boot.ini',
        'foo/bar/baz/qux.mp4',
      ];

      for (const title of maliciousTitles) {
        const sanitized = sanitizeFilename(title);
        expect(sanitized).not.toContain('/');
        expect(sanitized).not.toContain('\\');
        expect(sanitized).not.toMatch(/^\.\./);
        expect(sanitized).not.toContain('..');
        expect(sanitized.length).toBeGreaterThan(0);
      }
    });

    it('neutralizes malicious path traversal in filename templates and template tokens', () => {
      const template = '../../../{title}/../{quality}';
      const result = applyFilenameTemplate(template, {
        title: '../../secret',
        quality: '1080p',
      });

      expect(result).not.toContain('/');
      expect(result).not.toContain('\\');
      expect(result).not.toContain('..');
      expect(result).not.toMatch(/^[.\s_-]+/);
      expect(result).toBe('secret_._1080p');
    });

    it('prefixes or sanitizes Windows and POSIX reserved device names', () => {
      const reservedNames = [
        'CON',
        'con',
        'PRN',
        'prn',
        'AUX',
        'aux',
        'NUL',
        'nul',
        'COM1',
        'com1',
        'COM9',
        'com9',
        'LPT1',
        'lpt1',
        'LPT9',
        'lpt9',
        'con.mp4',
        'NUL.tar.gz',
        'aux.txt',
        'PRN.mkv',
      ];

      for (const res of reservedNames) {
        const sanitized = sanitizeFilename(res);
        expect(sanitized).toMatch(/^_[a-zA-Z0-9]/);
      }
    });

    it('strips Unicode bidirectional override characters (RLO extension spoofing defense)', () => {
      // \u202E is Right-to-Left Override, commonly used to disguise .exe as .mp4
      const rloAttack = 'Lecture_Recording_\u202Egpj.exe';
      const sanitized = sanitizeFilename(rloAttack);
      expect(sanitized).not.toContain('\u202E');
      expect(sanitized).toBe('Lecture_Recording_gpj.exe');

      // Check all bidi and zero-width codes
      const dangerousUnicode =
        'video\u200Bzero\u200Cwidth\u200Djoiner\u202Arle\u202Bpdf\u202C\u202D\u202E\u2066\u2067\u2068\u2069\uFEFFbom';
      const cleanUnicode = sanitizeFilename(dangerousUnicode);
      expect(cleanUnicode).toBe('videozerowidthjoinerrlepdfbom');
      expect(cleanUnicode).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/);
    });

    it('strips ASCII control codes (0x00 - 0x1F and 0x7F - 0x9F)', () => {
      const controlString = 'hello\x00world\x07bell\x1Besc\r\ntest\x7Fdel.mp4';
      const sanitized = sanitizeFilename(controlString);
      // eslint-disable-next-line no-control-regex
      expect(sanitized).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
      expect(sanitized).toBe('helloworldbellesctestdel.mp4');
    });

    it('strips trailing dots and spaces from filenames (Windows filesystem safety)', () => {
      const trailingTests = [
        { in: 'Lecture Video . . .', out: 'Lecture Video' },
        { in: 'Presentation   ', out: 'Presentation' },
        { in: 'Math101....', out: 'Math101' },
        { in: '  ...---...  ', out: 'video' },
      ];

      for (const t of trailingTests) {
        expect(sanitizeFilename(t.in)).toBe(t.out);
      }
    });

    it('preserves multi-byte UTF-8 emojis without code point corruption', () => {
      const emojiName = '🚀 Advanced Algorithms 🔥 1080p 🌟';
      const sanitized = sanitizeFilename(emojiName);
      expect(sanitized).toBe('🚀 Advanced Algorithms 🔥 1080p 🌟');
    });

    it('strictly caps filename byte length to 180 bytes without splitting surrogate pairs', () => {
      const hugeEmojiString = '🔥'.repeat(100); // 400 UTF-8 bytes
      const sanitized = sanitizeFilename(hugeEmojiString, 180);
      const byteLen = new TextEncoder().encode(sanitized).length;

      expect(byteLen).toBeLessThanOrEqual(180);
      expect(byteLen % 4).toBe(0); // Each fire emoji is 4 bytes, must not be split!
      expect(sanitized.length).toBeGreaterThan(0);
    });

    it('gracefully handles unrecognized template variables and empty titles', () => {
      // Single unrecognized token should be omitted and extra separators collapsed
      const template = '{title} - {unknown_token} - {quality}';
      const result = applyFilenameTemplate(template, {
        title: 'Algorithms',
        quality: '1080p',
      });
      expect(result).toBe('Algorithms - 1080p');

      // Unrecognized tokens at boundary should collapse cleanly
      expect(applyFilenameTemplate('{unknown} - {title}', { title: 'Algorithms' })).toBe('Algorithms');
      expect(applyFilenameTemplate('{title} - {unknown}', { title: 'Algorithms' })).toBe('Algorithms');

      // Consecutive unrecognized tokens: single-pass regex leaves hyphen pairs, still safe
      const consecutiveUnknown = applyFilenameTemplate('{title} - {foo} - {bar} - {quality}', {
        title: 'Algorithms',
        quality: '1080p',
      });
      expect(consecutiveUnknown).toBe('Algorithms - - 1080p');

      // All unknown tokens should fall back cleanly to title
      const allUnknown = applyFilenameTemplate('{foo}{bar}', {
        title: 'Original Title',
      });
      expect(allUnknown).toBe('Original Title');

      // Empty title and empty template falls back to 'video'
      const emptyResult = applyFilenameTemplate('{foo}', {
        title: '',
      });
      expect(emptyResult).toBe('video');
    });
  });

  // =========================================================================
  // 5. Manifest V3 CSP & Security Boundaries
  // =========================================================================
  describe('5. Manifest V3 CSP & Security Boundaries', () => {
    it('empirically verifies all distribution HTML files contain ZERO inline scripts or event handlers', () => {
      const rootDir = path.resolve(__dirname, '../../..');
      const distDirs = [path.join(rootDir, 'apps', 'extension', 'dist'), path.join(rootDir, 'dist', 'extension')];

      const htmlFiles: string[] = [];
      for (const d of distDirs) {
        if (!fs.existsSync(d)) continue;
        const scan = (dir: string) => {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) scan(p);
            else if (ent.name.endsWith('.html')) htmlFiles.push(p);
          }
        };
        scan(d);
      }

      expect(htmlFiles.length).toBeGreaterThanOrEqual(3);

      for (const file of htmlFiles) {
        const content = fs.readFileSync(file, 'utf8');

        // Check 1: No inline script tags (<script> without src)
        const scriptTags = content.match(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi) || [];
        for (const tag of scriptTags) {
          expect(tag, `File ${file} has a <script> tag without src attribute: ${tag}`).toMatch(/src=/);
          // Body between <script> and </script> must be empty
          const body = tag
            .replace(/<script\b[^>]*>/i, '')
            .replace(/<\/script>/i, '')
            .trim();
          expect(body, `File ${file} has inline script body: ${body}`).toBe('');
        }

        // Check 2: No inline DOM event handlers (onclick=, onload=, onerror=, etc.)
        const inlineEvents = content.match(/\s(on[a-z]+)\s*=\s*["'][^"']*["']/gi);
        expect(inlineEvents, `File ${file} contains inline event handlers: ${inlineEvents?.join(', ')}`).toBeNull();

        // Check 3: No javascript: pseudo-protocols
        const jsPseudo = content.match(/(?:href|src)\s*=\s*["']\s*javascript:[^"']*["']/gi);
        expect(jsPseudo, `File ${file} contains javascript: protocol: ${jsPseudo?.join(', ')}`).toBeNull();

        // Check 4: No remote CDN script or link imports
        const remoteScripts = content.match(/<script\b[^>]*src=["'](?:https?:|\/\/)[^"']*["']/gi);
        expect(remoteScripts, `File ${file} contains remote script reference`).toBeNull();

        // Check 5: Verify all referenced script src files exist on disk
        const srcMatches = content.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi);
        for (const match of srcMatches) {
          const scriptRel = match[1]!;
          const scriptAbs = path.resolve(path.dirname(file), scriptRel);
          expect(fs.existsSync(scriptAbs), `Referenced script ${scriptRel} does not exist at ${scriptAbs}`).toBe(true);
        }

        // Check 6: Verify all referenced stylesheet href files exist on disk
        const cssMatches = content.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi);
        for (const match of cssMatches) {
          const cssRel = match[1]!;
          const cssAbs = path.resolve(path.dirname(file), cssRel);
          expect(fs.existsSync(cssAbs), `Referenced stylesheet ${cssRel} does not exist at ${cssAbs}`).toBe(true);
        }
      }
    });
  });
});
