import type {
  DownloadTask,
  DualStreamLayout,
  MediaItem,
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
    this.client.onTaskUpdate?.((taskInfo) => this.handleNativeTaskUpdate(taskInfo));
    this.client.onStatusChange?.((status) => {
      if (!status.connected) {
        let changed = false;
        for (const task of this.tasks.values()) {
          if (task.engine === 'native' && isActive(task.state)) {
            task.state = 'queued';
            task.interrupted = true;
            if (task.progress) {
              task.progress.bytesPerSec = 0;
              task.progress.etaMs = undefined;
            }
            task.updatedAt = Date.now();
            this.broadcastTaskUpdate(task);
            changed = true;
          }
        }
        if (changed) {
          this.persistTasks().catch(() => {});
          this.syncActiveBadges();
        }
      } else {
        this.resumeQueuedTasks().catch(() => {});
      }
    });
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
        let changed = false;
        const taskEntries = Array.isArray(stored.tasks)
          ? stored.tasks.filter(Boolean).map((t: DownloadTask) => [t.id, t] as const)
          : Object.entries(stored.tasks);
        for (const [id, t] of taskEntries) {
          if (!t) continue;
          const task = t as DownloadTask;
          const taskId = task.id || id;
          if (!task.id) task.id = taskId;
          if (isActive(task.state)) {
            task.state = 'queued';
            task.interrupted = true;
            if (task.progress) {
              task.progress.bytesPerSec = 0;
              task.progress.etaMs = undefined;
            }
            task.updatedAt = Date.now();
            changed = true;
          }
          this.tasks.set(taskId, task);
        }
        if (changed) {
          await this.persistTasks();
        }
      }
    } catch {}

    // Hook Chrome downloads if available
    if (typeof chrome !== 'undefined' && chrome.downloads?.onChanged) {
      chrome.downloads.onChanged.addListener((delta) => this.handleChromeDownloadDelta(delta));
    }
    this.syncActiveBadges();
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

    const layout = params.layout || item.layout || this.settings.dualStreamLayout || 'side-by-side';

    if (item.groupId) {
      const tabMedia = await mediaStore.getTabMedia(item.tabId);
      const groupItems = tabMedia.filter((m) => m.groupId === item.groupId);

      if (groupItems.length > 1) {
        if (layout === 'separate') {
          let firstTaskId = '';
          for (const feedItem of groupItems) {
            const { taskId } = await this.startSingleStreamDownload(
              feedItem,
              {
                ...params,
                itemId: feedItem.id,
                qualityId: feedItem.id === item.id ? params.qualityId : undefined,
                layout: 'separate',
              },
              'separate',
            );
            if (!firstTaskId) firstTaskId = taskId;
          }
          return { taskId: firstTaskId };
        } else {
          return this.startBundledMediasiteDownload(item, groupItems, params, layout);
        }
      }
    }

    return this.startSingleStreamDownload(item, params, layout);
  }

  private async startBundledMediasiteDownload(
    primaryItem: MediaItem,
    groupItems: MediaItem[],
    params: StartDownloadParams,
    layout: DualStreamLayout,
  ): Promise<{ taskId: string }> {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const selectedQuality = primaryItem.qualities.find((q) => q.id === params.qualityId) ?? primaryItem.qualities[0];
    const qualityLabel = selectedQuality?.label || 'Default';

    const presentationTitle =
      primaryItem.title.replace(/ - (Primary video|Secondary video|Slides|Audio|Presentation video).*$/i, '').trim() ||
      primaryItem.title;

    const safeBaseName = applyFilenameTemplate(this.settings.filenameTemplate, {
      title: presentationTitle,
      quality: qualityLabel,
      id: taskId,
      site: new URL(primaryItem.pageUrl).hostname,
    });

    let cookieHeader = '';
    try {
      if (typeof chrome !== 'undefined' && chrome.cookies) {
        const cookies = await chrome.cookies.getAll({ url: primaryItem.url });
        cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      }
    } catch {}

    const videoItems = groupItems.filter((m) => m.hasVideo);
    const audioItems = groupItems.filter((m) => !m.hasVideo && m.hasAudio);

    const getScore = (m: MediaItem) => {
      const text = `${m.trackLabel || ''} ${m.title || ''}`;
      let score = 0;
      if (/slide|presentation|screen|content|secondary|type\s*1/i.test(text)) score += 100;
      if (/camera|presenter|primary|type\s*0/i.test(text)) score -= 100;
      return score;
    };

    if (layout === 'pip' && videoItems.length >= 2) {
      videoItems.sort((a, b) => getScore(b) - getScore(a));
    } else if (layout === 'side-by-side' && videoItems.length > 2) {
      const sorted = [...videoItems].sort((a, b) => getScore(b) - getScore(a));
      const slidesItem = sorted[0]!;
      const cameraItem = sorted[sorted.length - 1]!;
      const rest = sorted.slice(1, -1);
      videoItems.length = 0;
      videoItems.push(cameraItem, slidesItem, ...rest);
    }

    const tracks: NativeTrack[] = [];
    for (const vItem of videoItems) {
      const q =
        vItem.id === primaryItem.id
          ? (vItem.qualities.find((x) => x.id === params.qualityId) ?? vItem.qualities[0])
          : vItem.qualities[0];

      if (vItem.kind === 'hls') {
        tracks.push({
          type: 'hls',
          url: vItem.url,
          variantUrl: q?.ref,
          audioUrl: vItem.audioTracks.find((a) => a.id === params.audioId)?.ref,
          label: vItem.trackLabel || vItem.title,
        });
      } else if (vItem.kind === 'dash') {
        tracks.push({
          type: 'dash',
          url: vItem.url,
          videoRepId: q?.ref,
          audioRepId: vItem.audioTracks.find((a) => a.id === params.audioId)?.ref,
          label: vItem.trackLabel || vItem.title,
        });
      } else {
        tracks.push({
          type: 'direct',
          url: vItem.url,
          label: vItem.trackLabel || vItem.title,
        });
      }
    }

    for (const aItem of audioItems) {
      if (aItem.kind === 'hls') {
        tracks.push({
          type: 'hls',
          url: aItem.url,
          label: aItem.trackLabel || 'Audio',
        });
      } else if (aItem.kind === 'dash') {
        tracks.push({
          type: 'dash',
          url: aItem.url,
          label: aItem.trackLabel || 'Audio',
        });
      } else {
        tracks.push({
          type: 'direct',
          url: aItem.url,
          label: aItem.trackLabel || 'Audio',
        });
      }
    }

    const subtitlesMap = new Map<string, NativeSubtitle>();
    for (const gi of groupItems) {
      for (const s of gi.subtitles) {
        if (!subtitlesMap.has(s.url)) {
          subtitlesMap.set(s.url, { url: s.url, language: s.language, label: s.label });
        }
      }
    }
    const subtitles = Array.from(subtitlesMap.values());

    const maxDuration = Math.max(...groupItems.map((g) => g.durationSec || 0), primaryItem.durationSec || 0);

    const nativeRequest: NativeDownloadRequest = {
      taskId,
      title: presentationTitle,
      fileName: safeBaseName,
      outputDir: this.settings.outputDir || undefined,
      container: params.container || this.settings.container,
      tracks,
      subtitles,
      subtitleMode: this.settings.subtitleMode,
      headers: {
        cookie: cookieHeader || undefined,
        referer: primaryItem.pageUrl,
      },
      options: {
        segmentConcurrency: this.settings.segmentConcurrency,
        maxRetries: this.settings.maxRetries,
        retryBaseMs: this.settings.retryBaseMs,
      },
      expectedDurationSec: maxDuration > 0 ? maxDuration : undefined,
      layout,
    };

    const task: DownloadTask = {
      id: taskId,
      engine: 'native',
      kind: primaryItem.kind,
      title: presentationTitle,
      sourceUrl: primaryItem.url,
      pageUrl: primaryItem.pageUrl,
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

  private async startSingleStreamDownload(
    item: MediaItem,
    params: StartDownloadParams,
    layout?: DualStreamLayout,
  ): Promise<{ taskId: string }> {
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
      const urlExtMatch = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(new URL(item.url, 'http://localhost').pathname);
      if (urlExtMatch?.[1]) {
        const parsedExt = urlExtMatch[1].toLowerCase();
        if (/^(mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|oga|opus|flac|wav)$/.test(parsedExt)) {
          ext = parsedExt;
        }
      } else if (item.mimeType) {
        if (item.mimeType.includes('webm')) ext = 'webm';
        else if (item.mimeType.includes('mp3') || item.mimeType.includes('mpeg')) ext = 'mp3';
        else if (item.mimeType.includes('aac')) ext = 'aac';
        else if (item.mimeType.includes('ogg')) ext = 'ogg';
        else if (item.mimeType.includes('wav')) ext = 'wav';
        else if (item.mimeType.includes('flac')) ext = 'flac';
      }
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
        liveMode: params.liveMode ?? (item.isLive ? 'dvr' : undefined),
        liveDurationSeconds: params.liveDurationSeconds,
      },
      expectedDurationSec: item.durationSec,
      layout: layout || params.layout || item.layout || 'multi-track',
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
      isLive: item.isLive,
      liveMode: params.liveMode ?? (item.isLive ? 'dvr' : undefined),
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
    action: 'pause' | 'resume' | 'cancel' | 'stop' | 'retry' | 'remove' | 'open' | 'reveal' | 'start' | 'force-start',
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

    if (action === 'start' || action === 'force-start' || action === 'retry') {
      if (task.engine === 'chrome' && typeof chrome !== 'undefined' && chrome.downloads) {
        task.state = 'downloading';
        task.error = undefined;
        task.errorCode = undefined;
        if (task.progress) {
          task.progress.bytesPerSec = 0;
          task.progress.etaMs = undefined;
        }
        task.updatedAt = Date.now();
        await this.persistTasks();
        this.broadcastTaskUpdate(task);
        this.syncActiveBadges();
        try {
          const downloadId = await chrome.downloads.download({
            url: task.sourceUrl,
            filename: sanitizeFilename(task.title),
            saveAs: false,
          });
          task.chromeDownloadId = downloadId;
          await this.persistTasks();
          this.broadcastTaskUpdate(task);
        } catch (err: unknown) {
          task.state = 'failed';
          task.error = err instanceof Error ? err.message : String(err);
          task.updatedAt = Date.now();
          await this.persistTasks();
          this.broadcastTaskUpdate(task);
          this.syncActiveBadges();
        }
        return;
      }

      if (task.engine === 'native') {
        if (!task.request) {
          task.request = {
            taskId: task.id,
            title: task.title,
            fileName: sanitizeFilename(task.title),
            container: this.settings.container,
            tracks: [
              {
                type: task.kind === 'dash' ? 'dash' : task.kind === 'hls' ? 'hls' : 'direct',
                url: task.sourceUrl,
              },
            ],
            subtitles: [],
            subtitleMode: this.settings.subtitleMode,
            headers: { referer: task.pageUrl },
            options: {
              segmentConcurrency: this.settings.segmentConcurrency,
              maxRetries: this.settings.maxRetries,
              retryBaseMs: this.settings.retryBaseMs,
            },
            layout: this.settings.dualStreamLayout || 'side-by-side',
          };
        }

        task.state = 'queued';
        task.error = undefined;
        task.errorCode = undefined;
        if (task.progress) {
          task.progress.bytesPerSec = 0;
          task.progress.etaMs = undefined;
        }
        task.updatedAt = Date.now();
        await this.persistTasks();
        this.broadcastTaskUpdate(task);
        this.client
          .sendRequest({
            type: 'download.start',
            request: task.request,
          })
          .catch((err: unknown) => {
            task.state = 'failed';
            task.error = err instanceof Error ? err.message : String(err);
            task.updatedAt = Date.now();
            this.persistTasks().catch(() => {});
            this.broadcastTaskUpdate(task);
            this.syncActiveBadges();
          });
      }
      return;
    }

    if (action === 'stop') {
      if (task.engine === 'native') {
        this.client.sendRequest({ type: 'download.stop', taskId }).catch((err: unknown) => {
          console.warn('[TaskCoordinator] Failed to send download.stop:', err);
        });
      }
      return;
    }

    if (action === 'cancel') {
      if (task.engine === 'native') {
        this.client.sendRequest({ type: 'download.cancel', taskId }).catch(() => {});
      } else if (task.chromeDownloadId && typeof chrome !== 'undefined' && chrome.downloads) {
        chrome.downloads.cancel(task.chromeDownloadId).catch(() => {});
      }
      task.state = 'cancelled';
      if (task.progress) {
        task.progress.bytesPerSec = 0;
        task.progress.etaMs = undefined;
      }
      task.updatedAt = Date.now();
      await this.persistTasks();
      this.broadcastTaskUpdate(task);
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
      }
    } else if (task.chromeDownloadId && typeof chrome !== 'undefined' && chrome.downloads) {
      switch (action) {
        case 'pause':
          await chrome.downloads.pause(task.chromeDownloadId);
          break;
        case 'resume':
          await chrome.downloads.resume(task.chromeDownloadId);
          break;
        case 'open':
          chrome.downloads.open(task.chromeDownloadId);
          break;
        case 'reveal':
          chrome.downloads.show(task.chromeDownloadId);
          break;
      }
    }
  }

  async clearCompleted(): Promise<void> {
    await this.init();
    let changed = false;
    for (const [id, task] of this.tasks.entries()) {
      if (task.state === 'completed' || task.state === 'cancelled' || task.state === 'failed') {
        if (task.engine === 'native') {
          this.client.sendRequest({ type: 'download.remove', taskId: id }).catch(() => {});
        } else if (task.chromeDownloadId && typeof chrome !== 'undefined' && chrome.downloads) {
          chrome.downloads.erase({ id: task.chromeDownloadId }).catch(() => {});
        }
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

  async resumeQueuedTasks(): Promise<void> {
    await this.init();
    if (!this.client.getStatus().connected) return;

    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.engine === 'native' && task.state === 'queued' && (task.interrupted || task.request)) {
        task.interrupted = false;
        task.updatedAt = Date.now();
        changed = true;
        this.broadcastTaskUpdate(task);

        if (task.request) {
          this.client
            .sendRequest({
              type: 'download.start',
              request: task.request,
            })
            .catch((err: unknown) => {
              task.state = 'failed';
              task.error = err instanceof Error ? err.message : String(err);
              task.updatedAt = Date.now();
              this.persistTasks().catch(() => {});
              this.broadcastTaskUpdate(task);
              this.syncActiveBadges();
            });
        }
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
      if (isActive(info.state)) {
        existing.interrupted = false;
      }

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
