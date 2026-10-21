import type {
  DownloadTask,
  NativeDownloadRequest,
  NativeSubtitle,
  NativeTrack,
  Settings,
  StartDownloadParams,
  TaskInfo,
} from '@viddock/shared';
import {
  DEFAULT_SETTINGS,
  applyFilenameTemplate,
  canTransition,
  emptyProgress,
  isActive,
  sanitizeFilename,
} from '@viddock/shared';
import { mediaStore } from './media_store.ts';
import { type NativeClient, nativeClient } from './native_client.ts';

export class TaskCoordinator {
  private tasks = new Map<string, DownloadTask>();
  private uiPorts = new Set<chrome.runtime.Port>();
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private initialized = false;

  constructor(private client: NativeClient = nativeClient) {
    this.client.onTaskUpdate((taskInfo) => this.handleNativeTaskUpdate(taskInfo));
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Load settings
    try {
      const stored = await chrome.storage.local.get(['settings', 'tasks']);
      if (stored.settings) {
        this.settings = { ...DEFAULT_SETTINGS, ...stored.settings };
      }
      if (stored.tasks && typeof stored.tasks === 'object') {
        for (const [id, t] of Object.entries(stored.tasks)) {
          this.tasks.set(id, t as DownloadTask);
        }
      }
    } catch {}

    // Hook Chrome downloads if available
    if (typeof chrome !== 'undefined' && chrome.downloads?.onChanged) {
      chrome.downloads.onChanged.addListener((delta) => this.handleChromeDownloadDelta(delta));
    }
  }

  registerUiPort(port: chrome.runtime.Port): void {
    this.uiPorts.add(port);
    port.onDisconnect.addListener(() => {
      this.uiPorts.delete(port);
    });

    // Send initial snapshot
    port.postMessage({
      type: 'snapshot',
      tasks: Array.from(this.tasks.values()),
    });
  }

  getTasks(): DownloadTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getTask(id: string): DownloadTask | undefined {
    return this.tasks.get(id);
  }

  async getSettings(): Promise<Settings> {
    await this.init();
    return { ...this.settings };
  }

  async setSettings(partial: Partial<Settings>): Promise<Settings> {
    await this.init();
    this.settings = { ...this.settings, ...partial };
    try {
      await chrome.storage.local.set({ settings: this.settings });
    } catch {}

    // If maxSimultaneous changed, notify native host
    if (partial.maxSimultaneous !== undefined) {
      this.client
        .sendRequest({
          type: 'config',
          maxSimultaneous: partial.maxSimultaneous,
        })
        .catch(() => {});
    }

    return { ...this.settings };
  }

  async startDownload(params: StartDownloadParams): Promise<{ taskId: string }> {
    await this.init();
    const item = await mediaStore.getItemById(params.itemId);
    if (!item) {
      throw new Error(`Media item ${params.itemId} not found`);
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const selectedQuality = item.qualities.find((q) => q.id === params.qualityId) ?? item.qualities[0];
    const qualityLabel = selectedQuality?.label || 'Default';
    const safeBaseName = applyFilenameTemplate(this.settings.filenameTemplate, {
      title: item.title,
      quality: qualityLabel,
      id: taskId,
      site: new URL(item.pageUrl).hostname,
    });

    // Determine engine
    const isDirect = item.kind === 'direct';
    const engine: 'chrome' | 'native' = isDirect && this.settings.directViaChrome ? 'chrome' : 'native';

    if (engine === 'chrome' && typeof chrome !== 'undefined' && chrome.downloads) {
      let ext = 'mp4';
      if (item.url.includes('.webm')) ext = 'webm';
      const fileName = `${safeBaseName}.${ext}`;

      const downloadId = await chrome.downloads.download({
        url: item.url,
        filename: fileName,
        saveAs: false,
      });

      const task: DownloadTask = {
        id: taskId,
        engine: 'chrome',
        kind: item.kind,
        title: item.title,
        sourceUrl: item.url,
        pageUrl: item.pageUrl,
        qualityLabel,
        state: 'downloading',
        progress: emptyProgress(),
        chromeDownloadId: downloadId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      this.tasks.set(taskId, task);
      await this.persistTasks();
      this.broadcastTaskUpdate(task);
      this.syncActiveBadges();
      return { taskId };
    }

    // Engine: native companion
    // Gather cookies for authentication
    let cookieHeader = '';
    try {
      if (typeof chrome !== 'undefined' && chrome.cookies) {
        const cookies = await chrome.cookies.getAll({ url: item.url });
        cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      }
    } catch {}

    const tracks: NativeTrack[] = [];
    if (item.kind === 'hls') {
      tracks.push({
        type: 'hls',
        url: item.url,
        variantUrl: selectedQuality?.ref,
        audioUrl: item.audioTracks.find((a) => a.id === params.audioId)?.ref,
        label: item.trackLabel,
      });
    } else if (item.kind === 'dash') {
      tracks.push({
        type: 'dash',
        url: item.url,
        videoRepId: selectedQuality?.ref,
        audioRepId: item.audioTracks.find((a) => a.id === params.audioId)?.ref,
        label: item.trackLabel,
      });
    } else {
      tracks.push({
        type: 'direct',
        url: item.url,
        label: item.trackLabel,
      });
    }

    const subtitles: NativeSubtitle[] = item.subtitles.map((s) => ({
      url: s.url,
      language: s.language,
      label: s.label,
    }));

    const nativeRequest: NativeDownloadRequest = {
      taskId,
      title: item.title,
      fileName: safeBaseName,
      outputDir: this.settings.outputDir || undefined,
      container: params.container || this.settings.container,
      tracks,
      subtitles,
      subtitleMode: this.settings.subtitleMode,
      headers: {
        cookie: cookieHeader || undefined,
        referer: item.pageUrl,
      },
      options: {
        segmentConcurrency: this.settings.segmentConcurrency,
        maxRetries: this.settings.maxRetries,
        retryBaseMs: this.settings.retryBaseMs,
      },
      expectedDurationSec: item.durationSec,
      layout: params.layout || item.layout || 'multi-track',
    };

    const task: DownloadTask = {
      id: taskId,
      engine: 'native',
      kind: item.kind,
      title: item.title,
      sourceUrl: item.url,
      pageUrl: item.pageUrl,
      qualityLabel,
      state: 'queued',
      progress: emptyProgress(),
      request: nativeRequest,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.tasks.set(taskId, task);
    await this.persistTasks();
    this.broadcastTaskUpdate(task);
    this.syncActiveBadges();

    // Send to native client
    this.client
      .sendRequest({
        type: 'download.start',
        request: nativeRequest,
      })
      .catch((err: unknown) => {
        task.state = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
        task.updatedAt = Date.now();
        this.persistTasks();
        this.broadcastTaskUpdate(task);
      });

    return { taskId };
  }

  async handleTaskAction(
    taskId: string,
    action: 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'open' | 'reveal',
  ): Promise<void> {
    await this.init();
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    if (action === 'remove') {
      if (task.engine === 'native') {
        this.client.sendRequest({ type: 'download.remove', taskId }).catch(() => {});
      } else if (task.chromeDownloadId && typeof chrome !== 'undefined' && chrome.downloads) {
        chrome.downloads.erase({ id: task.chromeDownloadId }).catch(() => {});
      }
      this.tasks.delete(taskId);
      await this.persistTasks();
      this.broadcastTaskRemoval(taskId);
      this.syncActiveBadges();
      return;
    }

    if (task.engine === 'native') {
      switch (action) {
        case 'pause':
          await this.client.sendRequest({ type: 'download.pause', taskId });
          break;
        case 'resume':
          await this.client.sendRequest({ type: 'download.resume', taskId });
          break;
        case 'cancel':
          await this.client.sendRequest({ type: 'download.cancel', taskId });
          break;
        case 'open':
          if (task.outputPath) {
            await this.client.sendRequest({ type: 'file.open', path: task.outputPath });
          }
          break;
        case 'reveal':
          if (task.outputPath) {
            await this.client.sendRequest({ type: 'file.reveal', path: task.outputPath });
          }
          break;
        case 'retry':
          if (task.request) {
            task.state = 'queued';
            task.error = undefined;
            task.updatedAt = Date.now();
            await this.persistTasks();
            this.broadcastTaskUpdate(task);
            await this.client.sendRequest({ type: 'download.start', request: task.request });
          }
          break;
      }
    } else if (task.chromeDownloadId && typeof chrome !== 'undefined' && chrome.downloads) {
      switch (action) {
        case 'pause':
          await chrome.downloads.pause(task.chromeDownloadId);
          break;
        case 'resume':
          await chrome.downloads.resume(task.chromeDownloadId);
          break;
        case 'cancel':
          await chrome.downloads.cancel(task.chromeDownloadId);
          task.state = 'cancelled';
          task.updatedAt = Date.now();
          await this.persistTasks();
          this.broadcastTaskUpdate(task);
          break;
        case 'open':
          chrome.downloads.open(task.chromeDownloadId);
          break;
        case 'reveal':
          chrome.downloads.show(task.chromeDownloadId);
          break;
        case 'retry':
          if (task.sourceUrl) {
            const newId = await chrome.downloads.download({
              url: task.sourceUrl,
              filename: sanitizeFilename(task.title),
              saveAs: false,
            });
            task.chromeDownloadId = newId;
            task.state = 'downloading';
            task.error = undefined;
            task.updatedAt = Date.now();
            await this.persistTasks();
            this.broadcastTaskUpdate(task);
          }
          break;
      }
    }
  }

  async clearCompleted(): Promise<void> {
    await this.init();
    let changed = false;
    for (const [id, task] of this.tasks.entries()) {
      if (task.state === 'completed' || task.state === 'cancelled' || task.state === 'failed') {
        this.tasks.delete(id);
        this.broadcastTaskRemoval(id);
        changed = true;
      }
    }
    if (changed) {
      await this.persistTasks();
      this.syncActiveBadges();
    }
  }

  handleNativeTaskUpdate(info: TaskInfo): void {
    const existing = this.tasks.get(info.id);
    if (!existing) return;

    if (canTransition(existing.state, info.state)) {
      const prevState = existing.state;
      existing.state = info.state;
      existing.progress = info.progress;
      existing.outputPath = info.outputPath ?? existing.outputPath;
      existing.outputBytes = info.outputBytes ?? existing.outputBytes;
      existing.error = info.error;
      existing.errorCode = info.errorCode;
      existing.updatedAt = Date.now();

      this.persistTasks();
      this.broadcastTaskUpdate(existing);

      if (prevState !== info.state) {
        this.syncActiveBadges();
        if (info.state === 'completed' || info.state === 'failed') {
          this.notifyUser(existing);
        }
      }
    }
  }

  private handleChromeDownloadDelta(delta: chrome.downloads.DownloadDelta): void {
    let task: DownloadTask | undefined;
    for (const t of this.tasks.values()) {
      if (t.chromeDownloadId === delta.id) {
        task = t;
        break;
      }
    }
    if (!task) return;

    if (delta.state) {
      if (delta.state.current === 'complete') {
        task.state = 'completed';
        task.progress.percent = 100;
        this.notifyUser(task);
      } else if (delta.state.current === 'interrupted') {
        task.state = 'failed';
        task.error = delta.error?.current || 'Download interrupted';
        this.notifyUser(task);
      }
    }

    if (delta.filename) {
      task.outputPath = delta.filename.current;
    }

    task.updatedAt = Date.now();
    this.persistTasks();
    this.broadcastTaskUpdate(task);
    this.syncActiveBadges();
  }

  private broadcastTaskUpdate(task: DownloadTask): void {
    for (const port of this.uiPorts) {
      try {
        port.postMessage({ type: 'task.update', task });
      } catch {}
    }
  }

  private broadcastTaskRemoval(taskId: string): void {
    for (const port of this.uiPorts) {
      try {
        port.postMessage({ type: 'task.remove', taskId });
      } catch {}
    }
  }

  private async notifyUser(task: DownloadTask): Promise<void> {
    if (!this.settings.notifications) return;
    try {
      if (typeof chrome !== 'undefined' && chrome.notifications) {
        const isSuccess = task.state === 'completed';
        chrome.notifications.create(`viddock_${task.id}`, {
          type: 'basic',
          iconUrl: 'icons/icon-128.png',
          title: isSuccess ? 'VidDock Download Complete' : 'VidDock Download Failed',
          message: isSuccess
            ? `Successfully downloaded: ${task.title}`
            : `Failed downloading: ${task.title} (${task.error || 'Unknown error'})`,
        });
      }
    } catch {}
  }

  private async syncActiveBadges(): Promise<void> {
    const activeCount = Array.from(this.tasks.values()).filter((t) => isActive(t.state)).length;
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id) {
          await mediaStore.updateTabBadge(activeTab.id, activeCount);
        }
      }
    } catch {}
  }

  private async persistTasks(): Promise<void> {
    try {
      const serialized: Record<string, DownloadTask> = {};
      for (const [id, t] of this.tasks.entries()) {
        serialized[id] = t;
      }
      await chrome.storage.local.set({ tasks: serialized });
    } catch {}
  }
}

export const taskCoordinator = new TaskCoordinator();
