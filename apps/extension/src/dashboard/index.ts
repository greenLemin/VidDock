import type { BgResponse, DownloadTask, PopupState } from '@viddock/shared';
import { isActive } from '@viddock/shared';
import { formatBytes, formatDate, formatEta, formatSpeed } from '../ui/formatters.ts';

function initColorTheme(): void {
  try {
    const saved = localStorage.getItem('viddock_theme');
    const meta = document.querySelector('meta[name="color-scheme"]') as HTMLMetaElement | null;
    if (meta && (saved === 'light' || saved === 'dark')) {
      meta.content = saved;
    }
  } catch {}
}
initColorTheme();

export function getHumanReadableErrorMessage(errorCode?: string, fallbackError?: string): string {
  switch (errorCode) {
    case 'NO_FFMPEG':
      return fallbackError || 'FFmpeg is required for muxing but was not found.';
    case 'HTTP_401':
      return fallbackError || 'Authentication required (HTTP 401). Session may have expired.';
    case 'HTTP_403':
      return fallbackError || 'Access forbidden (HTTP 403). Session may have expired.';
    case 'SEGMENT_MISSING':
      return fallbackError || 'Stream segment(s) could not be retrieved.';
    case 'DISK_FULL':
      return fallbackError || 'Disk space is full.';
    default:
      return fallbackError || errorCode || 'An error occurred.';
  }
}

export class DashboardController {
  private tasks: DownloadTask[] = [];
  private currentFilter: 'all' | 'active' | 'queued' | 'completed' | 'failed' = 'all';
  private searchQuery = '';
  private currentSort: 'newest' | 'oldest' | 'name' | 'size' = 'newest';
  private uiPort: chrome.runtime.Port | null = null;

  async init(): Promise<void> {
    this.bindEvents();
    await this.fetchInitialState();
    this.connectStreamingPort();
  }

  private bindEvents(): void {
    // Filter Tabs
    document.querySelectorAll('#filter-tabs .segment-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const filter = target.getAttribute('data-filter') as typeof this.currentFilter;
        if (!filter) return;
        this.currentFilter = filter;

        document.querySelectorAll('#filter-tabs .segment-btn').forEach((b) => b.classList.remove('active'));
        target.classList.add('active');
        this.renderTasks();
      });
    });

    // Search Input
    const searchInput = document.getElementById('search-input') as HTMLInputElement;
    searchInput?.addEventListener('input', () => {
      this.searchQuery = searchInput.value.trim().toLowerCase();
      this.renderTasks();
    });

    // Sort Dropdown
    const sortSelect = document.getElementById('sort-select') as HTMLSelectElement;
    sortSelect?.addEventListener('change', () => {
      this.currentSort = sortSelect.value as typeof this.currentSort;
      this.renderTasks();
    });

    // Clear Completed Button
    document.getElementById('btn-clear-completed')?.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'clearCompleted' });
        this.tasks = this.tasks.filter(
          (t) => t.state !== 'completed' && t.state !== 'cancelled' && t.state !== 'failed',
        );
        this.render();
      } catch {}
    });

    // Settings Button
    document.getElementById('btn-open-settings')?.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('settings/index.html') });
    });
  }

  private connectStreamingPort(): void {
    try {
      this.uiPort = chrome.runtime.connect({ name: 'viddock-ui' });
      this.uiPort.onMessage.addListener(
        (msg: { type: string; tasks?: DownloadTask[]; task?: DownloadTask; taskId?: string }) => {
          if (msg.type === 'snapshot' && Array.isArray(msg.tasks)) {
            this.tasks = msg.tasks;
            this.render();
          } else if (msg.type === 'task.update' && msg.task) {
            const idx = this.tasks.findIndex((t) => t.id === msg.task!.id);
            if (idx >= 0) {
              this.tasks[idx] = msg.task;
            } else {
              this.tasks.push(msg.task);
            }
            this.render();
          } else if (msg.type === 'task.remove' && msg.taskId) {
            this.tasks = this.tasks.filter((t) => t.id !== msg.taskId);
            this.render();
          }
        },
      );
    } catch {}
  }

  private async fetchInitialState(): Promise<void> {
    try {
      const res = await chrome.runtime.sendMessage<unknown, BgResponse<PopupState>>({
        type: 'getState',
      });
      if (res && res.ok) {
        this.tasks = res.data.tasks || [];
        this.render();
      }
    } catch {}
  }

  private render(): void {
    this.renderStats();
    this.renderTasks();
  }

  private renderStats(): void {
    const activeTasks = this.tasks.filter((t) => isActive(t.state));
    const totalSpeed = activeTasks.reduce((sum, t) => sum + (t.progress?.bytesPerSec || 0), 0);

    const activeEl = document.getElementById('stat-active');
    const speedEl = document.getElementById('stat-speed');
    const totalEl = document.getElementById('stat-total');

    if (activeEl) activeEl.textContent = String(activeTasks.length);
    if (speedEl) speedEl.textContent = formatSpeed(totalSpeed);
    if (totalEl) totalEl.textContent = String(this.tasks.length);
  }

  private renderTasks(): void {
    const container = document.getElementById('tasks-container');
    const emptyState = document.getElementById('dashboard-empty-state');
    if (!container || !emptyState) return;

    // Filter
    let filtered = this.tasks.filter((task) => {
      if (this.currentFilter === 'active') return isActive(task.state);
      if (this.currentFilter === 'queued') return task.state === 'queued';
      if (this.currentFilter === 'completed') return task.state === 'completed';
      if (this.currentFilter === 'failed') return task.state === 'failed';
      return true;
    });

    // Search query
    if (this.searchQuery) {
      filtered = filtered.filter(
        (t) =>
          t.title.toLowerCase().includes(this.searchQuery) ||
          t.outputPath?.toLowerCase().includes(this.searchQuery) ||
          t.id.toLowerCase().includes(this.searchQuery),
      );
    }

    // Sort
    filtered.sort((a, b) => {
      switch (this.currentSort) {
        case 'newest':
          return b.createdAt - a.createdAt;
        case 'oldest':
          return a.createdAt - b.createdAt;
        case 'name':
          return a.title.localeCompare(b.title);
        case 'size':
          return (b.outputBytes || b.progress?.totalBytes || 0) - (a.outputBytes || a.progress?.totalBytes || 0);
        default:
          return 0;
      }
    });

    if (filtered.length === 0) {
      container.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    container.innerHTML = '';

    for (const task of filtered) {
      container.appendChild(this.createTaskCard(task));
    }
  }

  private createTaskCard(task: DownloadTask): HTMLElement {
    const card = document.createElement('div');
    card.className = 'task-card';

    // Header
    const header = document.createElement('div');
    header.className = 'task-header';

    const info = document.createElement('div');
    info.className = 'task-info';

    const title = document.createElement('h3');
    title.className = 'task-title';
    title.textContent = task.title;
    info.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'task-meta';

    const statusBadge = document.createElement('span');
    statusBadge.className = `task-status-badge status-badge-${task.state}`;
    statusBadge.textContent = task.state;
    meta.appendChild(statusBadge);

    if (task.qualityLabel) {
      const q = document.createElement('span');
      q.textContent = `• Quality: ${task.qualityLabel}`;
      meta.appendChild(q);
    }

    const created = document.createElement('span');
    created.textContent = `• ${formatDate(task.createdAt)}`;
    meta.appendChild(created);

    if (task.outputPath) {
      const pathEl = document.createElement('span');
      pathEl.textContent = `• Saved to disk`;
      pathEl.title = task.outputPath;
      meta.appendChild(pathEl);
    }

    info.appendChild(meta);
    header.appendChild(info);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'task-actions';

    if (isActive(task.state)) {
      const btnPause = document.createElement('button');
      btnPause.className = 'btn-secondary btn-sm';
      btnPause.textContent = 'Pause';
      btnPause.addEventListener('click', () => this.executeAction(task.id, 'pause'));
      actions.appendChild(btnPause);

      const btnCancel = document.createElement('button');
      btnCancel.className = 'btn-danger btn-sm';
      btnCancel.textContent = 'Cancel';
      btnCancel.addEventListener('click', () => this.executeAction(task.id, 'cancel'));
      actions.appendChild(btnCancel);
    } else if (task.state === 'paused') {
      const btnResume = document.createElement('button');
      btnResume.className = 'btn-primary btn-sm';
      btnResume.textContent = 'Resume';
      btnResume.addEventListener('click', () => this.executeAction(task.id, 'resume'));
      actions.appendChild(btnResume);

      const btnCancel = document.createElement('button');
      btnCancel.className = 'btn-danger btn-sm';
      btnCancel.textContent = 'Cancel';
      btnCancel.addEventListener('click', () => this.executeAction(task.id, 'cancel'));
      actions.appendChild(btnCancel);
    } else if (task.state === 'completed') {
      if (task.outputPath) {
        const btnOpen = document.createElement('button');
        btnOpen.className = 'btn-secondary btn-sm';
        btnOpen.textContent = 'Open';
        btnOpen.addEventListener('click', () => this.executeAction(task.id, 'open'));
        actions.appendChild(btnOpen);

        const btnReveal = document.createElement('button');
        btnReveal.className = 'btn-secondary btn-sm';
        btnReveal.textContent = 'Reveal';
        btnReveal.addEventListener('click', () => this.executeAction(task.id, 'reveal'));
        actions.appendChild(btnReveal);
      }

      const btnRemove = document.createElement('button');
      btnRemove.className = 'icon-button btn-remove';
      btnRemove.title = 'Remove from list';
      btnRemove.setAttribute('aria-label', 'Remove from list');
      btnRemove.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
      btnRemove.addEventListener('click', () => this.executeAction(task.id, 'remove'));
      actions.appendChild(btnRemove);
    } else if (task.state === 'queued') {
      const btnStart = document.createElement('button');
      btnStart.className = 'btn-primary btn-sm btn-start';
      btnStart.textContent = 'Force Start';
      btnStart.addEventListener('click', () => this.executeAction(task.id, 'force-start'));
      actions.appendChild(btnStart);

      const btnCancel = document.createElement('button');
      btnCancel.className = 'btn-secondary btn-sm btn-cancel';
      btnCancel.textContent = 'Cancel';
      btnCancel.addEventListener('click', () => this.executeAction(task.id, 'cancel'));
      actions.appendChild(btnCancel);

      const btnRemove = document.createElement('button');
      btnRemove.className = 'icon-button btn-remove';
      btnRemove.title = 'Remove';
      btnRemove.setAttribute('aria-label', 'Remove');
      btnRemove.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
      btnRemove.addEventListener('click', () => this.executeAction(task.id, 'remove'));
      actions.appendChild(btnRemove);
    } else if (task.state === 'failed' || task.state === 'cancelled') {
      const btnRetry = document.createElement('button');
      btnRetry.className = 'btn-secondary btn-sm btn-retry';
      btnRetry.textContent = 'Retry';
      btnRetry.addEventListener('click', () => this.executeAction(task.id, 'retry'));
      actions.appendChild(btnRetry);

      const btnRemove = document.createElement('button');
      btnRemove.className = 'icon-button btn-remove';
      btnRemove.title = 'Remove';
      btnRemove.setAttribute('aria-label', 'Remove');
      btnRemove.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
      btnRemove.addEventListener('click', () => this.executeAction(task.id, 'remove'));
      actions.appendChild(btnRemove);
    }

    header.appendChild(actions);
    card.appendChild(header);

    // Error banner if any
    if (task.error || task.errorCode) {
      const errBanner = document.createElement('div');
      errBanner.className = 'task-error-banner';

      const errText = document.createElement('div');
      errText.className = 'task-error-text';
      errText.textContent = `Error: ${getHumanReadableErrorMessage(task.errorCode, task.error)}`;
      errBanner.appendChild(errText);

      const code = task.errorCode;
      if (code === 'NO_FFMPEG') {
        const btnFfmpeg = document.createElement('button');
        btnFfmpeg.className = 'btn-secondary btn-sm btn-error-action';
        btnFfmpeg.textContent = 'Install FFmpeg';
        btnFfmpeg.addEventListener('click', () => {
          chrome.tabs.create({ url: chrome.runtime.getURL('settings/index.html#companion-help-box') });
        });
        errBanner.appendChild(btnFfmpeg);
      } else if (code === 'HTTP_401' || code === 'HTTP_403') {
        const btnReopen = document.createElement('button');
        btnReopen.className = 'btn-secondary btn-sm btn-error-action';
        btnReopen.textContent = 'Reopen Page to Refresh Session';
        btnReopen.addEventListener('click', () => {
          if (task.pageUrl) {
            chrome.tabs.create({ url: task.pageUrl });
          }
        });
        errBanner.appendChild(btnReopen);
      } else if (code === 'SEGMENT_MISSING') {
        const btnRetry = document.createElement('button');
        btnRetry.className = 'btn-secondary btn-sm btn-error-action';
        btnRetry.textContent = 'Retry Download';
        btnRetry.addEventListener('click', () => {
          this.executeAction(task.id, 'retry');
        });
        errBanner.appendChild(btnRetry);
      } else if (code === 'DISK_FULL') {
        const btnClean = document.createElement('button');
        btnClean.className = 'btn-secondary btn-sm btn-error-action';
        btnClean.textContent = 'Clean Work Cache';
        btnClean.addEventListener('click', async () => {
          try {
            await chrome.runtime.sendMessage({ type: 'cacheClear' });
          } catch {}
          chrome.tabs.create({ url: chrome.runtime.getURL('settings/index.html#diagnostic-section') });
        });
        errBanner.appendChild(btnClean);
      }

      card.appendChild(errBanner);
    }

    // Progress Section
    const progressSection = document.createElement('div');
    progressSection.className = 'task-progress-section';

    const track = document.createElement('div');
    track.className = 'progress-track';

    const fill = document.createElement('div');
    fill.className = `progress-fill ${task.state === 'completed' ? 'success' : task.state === 'failed' ? 'failed' : ''}`;
    fill.style.width = `${Math.min(100, Math.max(0, task.progress?.percent || 0))}%`;
    track.appendChild(fill);
    progressSection.appendChild(track);

    const metaRow = document.createElement('div');
    metaRow.className = 'task-progress-meta';

    const percentText = `${Math.round(task.progress?.percent || 0)}%`;
    const bytesText = `${formatBytes(task.progress?.bytesDownloaded)} of ${formatBytes(task.outputBytes || task.progress?.totalBytes)}`;
    const speedText = isActive(task.state) && task.progress?.bytesPerSec ? formatSpeed(task.progress.bytesPerSec) : '';
    const etaText = isActive(task.state) && task.progress?.etaMs ? formatEta(task.progress.etaMs) : '';

    const leftMeta = document.createElement('span');
    leftMeta.textContent = `${percentText} • ${bytesText}`;
    metaRow.appendChild(leftMeta);

    const rightMeta = document.createElement('span');
    rightMeta.textContent = [speedText, etaText].filter(Boolean).join(' • ');
    metaRow.appendChild(rightMeta);

    progressSection.appendChild(metaRow);
    card.appendChild(progressSection);

    return card;
  }

  private async executeAction(
    taskId: string,
    action: 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'open' | 'reveal' | 'force-start' | 'start',
  ): Promise<void> {
    try {
      await chrome.runtime.sendMessage({
        type: 'taskAction',
        taskId,
        action,
      });
    } catch {}
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const controller = new DashboardController();
    controller.init();
  });
}
