import type {
  BgResponse,
  DownloadTask,
  DualStreamLayout,
  MediaItem,
  PopupState,
  StartDownloadParams,
} from '@viddock/shared';
import { isActive } from '@viddock/shared';
import { formatDuration, formatSpeed } from '../ui/formatters.ts';

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

export class PopupController {
  private state: PopupState | null = null;
  private selectedQualities = new Map<string, string>();
  private selectedLayouts = new Map<string, DualStreamLayout>();
  private uiPort: chrome.runtime.Port | null = null;

  async init(): Promise<void> {
    this.bindStaticEvents();
    await this.refreshState();
    this.connectStreamingPort();
  }

  private bindStaticEvents(): void {
    document.getElementById('btn-open-dashboard')?.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
    });

    document.getElementById('btn-open-settings')?.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('settings/index.html') });
    });

    document.getElementById('link-setup-ffmpeg')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('settings/index.html') });
    });

    document.getElementById('btn-refresh-media')?.addEventListener('click', () => {
      this.rescanMedia();
    });

    document.getElementById('btn-empty-rescan')?.addEventListener('click', () => {
      this.rescanMedia();
    });

    document.getElementById('dock-view-all')?.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
    });

    document.getElementById('host-status-pill')?.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('settings/index.html') });
    });
  }

  private connectStreamingPort(): void {
    try {
      this.uiPort = chrome.runtime.connect({ name: 'viddock-ui' });
      this.uiPort.onMessage.addListener(
        (msg: { type: string; tasks?: DownloadTask[]; task?: DownloadTask; taskId?: string }) => {
          if (msg.type === 'snapshot' && Array.isArray(msg.tasks) && this.state) {
            this.state.tasks = msg.tasks;
            this.renderTasksDock();
          } else if (msg.type === 'task.update' && msg.task && this.state) {
            const idx = this.state.tasks.findIndex((t) => t.id === msg.task!.id);
            if (idx >= 0) {
              this.state.tasks[idx] = msg.task;
            } else {
              this.state.tasks.push(msg.task);
            }
            this.renderTasksDock();
          } else if (msg.type === 'task.remove' && msg.taskId && this.state) {
            this.state.tasks = this.state.tasks.filter((t) => t.id !== msg.taskId);
            this.renderTasksDock();
          }
        },
      );
      this.uiPort.onDisconnect.addListener(() => {
        this.uiPort = null;
      });
    } catch {}
  }

  private async refreshState(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage<unknown, BgResponse<PopupState>>({
        type: 'getState',
      });
      if (response && response.ok) {
        this.state = response.data;
        this.render();
      }
    } catch {}
  }

  private async rescanMedia(): Promise<void> {
    if (!this.state) return;
    try {
      await chrome.runtime.sendMessage({
        type: 'refresh',
        tabId: this.state.tabId,
      });
      setTimeout(() => {
        this.refreshState();
      }, 300);
    } catch {}
  }

  private render(): void {
    if (!this.state) return;
    this.renderHostStatus();
    this.renderMediaList();
    this.renderTasksDock();
  }

  renderHostStatus(nativeStatus?: import('@viddock/shared').NativeStatus): void {
    const native = nativeStatus || this.state?.native;
    if (!native) return;
    const pill = document.getElementById('host-status-pill');
    const label = document.getElementById('host-status-text');
    const warningBanner = document.getElementById('ffmpeg-warning-banner');
    if (!pill || !label) return;

    pill.className = 'status-pill';

    if (native.connected) {
      if (!native.ffmpeg || !native.ffprobe) {
        pill.classList.add('status-warning');
        label.textContent = 'FFmpeg Missing';
        pill.title =
          'Native Companion Connected, but FFmpeg is not installed.\nStream remuxing is disabled.\nClick to view setup in Settings.';
        if (warningBanner) warningBanner.classList.remove('hidden');
      } else {
        pill.classList.add('status-connected');
        label.textContent = `Host v${native.version || '1.0'}`;
        pill.title = `Native Companion Connected\nFFmpeg: ${native.ffmpeg || 'detected'}\nPlatform: ${native.platform || 'macOS'}`;
        if (warningBanner) warningBanner.classList.add('hidden');
      }
    } else if (native.error) {
      pill.classList.add('status-disconnected');
      label.textContent = 'Host Offline';
      pill.title = `Native Companion Disconnected: ${native.error}\nClick to view setup in Settings.`;
      if (warningBanner) warningBanner.classList.add('hidden');
    } else {
      pill.classList.add('status-connecting');
      label.textContent = 'Connecting...';
      pill.title = 'Searching for local native host...';
      if (warningBanner) warningBanner.classList.add('hidden');
    }
  }

  private renderMediaList(): void {
    if (!this.state) return;
    const mediaList = document.getElementById('media-list');
    const emptyState = document.getElementById('empty-state');
    const countBadge = document.getElementById('media-count');
    if (!mediaList || !emptyState) return;

    const items = this.state.items || [];
    if (items.length === 0) {
      if (countBadge) countBadge.textContent = '0';
      mediaList.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    mediaList.innerHTML = '';

    // Group Mediasite items with groupId into a unified presentation card
    const mediasiteGroups = new Map<string, MediaItem[]>();
    const otherItems: MediaItem[] = [];

    for (const item of items) {
      if (item.source === 'mediasite' && item.groupId) {
        const group = mediasiteGroups.get(item.groupId) || [];
        group.push(item);
        mediasiteGroups.set(item.groupId, group);
      } else {
        otherItems.push(item);
      }
    }

    const totalCards = mediasiteGroups.size + otherItems.length;
    if (countBadge) {
      countBadge.textContent = String(totalCards);
    }

    for (const [groupId, groupItems] of mediasiteGroups.entries()) {
      const card = this.createMediasitePresentationCard(groupId, groupItems);
      mediaList.appendChild(card);
    }

    for (const item of otherItems) {
      const card = this.createMediaCard(item);
      mediaList.appendChild(card);
    }
  }

  private createMediaCard(item: MediaItem): HTMLElement {
    const card = document.createElement('div');
    card.className = 'media-card';

    // Top Row: Stream Badge and Duration
    const topRow = document.createElement('div');
    topRow.className = 'media-card-top';

    const badge = document.createElement('span');
    badge.className = `badge-stream badge-${item.kind === 'hls' ? 'hls' : item.kind === 'dash' ? 'dash' : item.source === 'mediasite' ? 'mediasite' : 'direct'}`;
    badge.textContent = item.source === 'mediasite' ? 'Mediasite' : item.kind.toUpperCase();
    topRow.appendChild(badge);

    if (item.durationSec) {
      const duration = document.createElement('span');
      duration.className = 'media-duration';
      duration.textContent = formatDuration(item.durationSec);
      topRow.appendChild(duration);
    }
    card.appendChild(topRow);

    // Title
    const title = document.createElement('h3');
    title.className = 'media-title';
    title.textContent = item.title;
    title.title = item.title;
    card.appendChild(title);

    // Quality Selector Dropdown
    const controlsRow = document.createElement('div');
    controlsRow.className = 'media-controls-row';

    const selectWrapper = document.createElement('div');
    selectWrapper.className = 'select-wrapper';

    const select = document.createElement('select');
    select.className = 'select-apple';
    select.setAttribute('aria-label', 'Select video quality');

    const qualities = item.qualities && item.qualities.length > 0 ? item.qualities : [{ id: 'q0', label: 'Default' }];

    const selectedQ = this.selectedQualities.get(item.id) || qualities[0]?.id || 'q0';

    for (const q of qualities) {
      const opt = document.createElement('option');
      opt.value = q.id;
      opt.textContent = q.label;
      if (q.id === selectedQ) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      this.selectedQualities.set(item.id, select.value);
    });

    const chevron = document.createElement('span');
    chevron.className = 'select-chevron';
    chevron.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;

    selectWrapper.appendChild(select);
    selectWrapper.appendChild(chevron);
    controlsRow.appendChild(selectWrapper);
    card.appendChild(controlsRow);

    // Mediasite Layout Selector if applicable
    if (item.source === 'mediasite' || item.groupId) {
      const layoutGroup = document.createElement('div');
      layoutGroup.className = 'mediasite-layout-group';

      const layoutLabel = document.createElement('span');
      layoutLabel.className = 'mediasite-layout-label';
      layoutLabel.textContent = 'Dual-Stream Layout:';
      layoutGroup.appendChild(layoutLabel);

      const segmented = document.createElement('div');
      segmented.className = 'segmented-control';

      const layouts: { id: DualStreamLayout; label: string }[] = [
        { id: 'side-by-side', label: 'Side-by-Side' },
        { id: 'pip', label: 'PiP' },
        { id: 'multi-track', label: 'Tracks' },
        { id: 'separate', label: 'Separate' },
      ];

      const layoutKey = item.groupId || item.id;
      const currentLayout =
        this.selectedLayouts.get(layoutKey) || this.state?.settings?.dualStreamLayout || item.layout || 'side-by-side';

      layouts.forEach((l) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `segment-btn ${l.id === currentLayout ? 'active' : ''}`;
        btn.textContent = l.label;
        btn.addEventListener('click', () => {
          this.selectedLayouts.set(layoutKey, l.id);
          segmented.querySelectorAll('.segment-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
        });
        segmented.appendChild(btn);
      });

      layoutGroup.appendChild(segmented);
      card.appendChild(layoutGroup);
    }

    // Download Button
    const btnDownload = document.createElement('button');
    btnDownload.type = 'button';
    btnDownload.className = 'btn-primary';
    btnDownload.style.width = '100%';

    if (item.unsupportedReason) {
      btnDownload.disabled = true;
      btnDownload.style.opacity = '0.6';
      btnDownload.textContent = item.unsupportedReason;
    } else {
      btnDownload.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg> Download Video`;
      btnDownload.addEventListener('click', async () => {
        btnDownload.disabled = true;
        btnDownload.textContent = 'Starting...';

        const params: StartDownloadParams = {
          itemId: item.id,
          qualityId: this.selectedQualities.get(item.id) || qualities[0]?.id,
          layout:
            this.selectedLayouts.get(item.groupId || item.id) ||
            this.state?.settings?.dualStreamLayout ||
            item.layout ||
            'side-by-side',
        };

        try {
          const res = await chrome.runtime.sendMessage<unknown, BgResponse<{ taskId: string }>>({
            type: 'startDownload',
            params,
          });
          if (res && res.ok) {
            btnDownload.textContent = 'Queued in VidDock';
            setTimeout(() => {
              this.refreshState();
            }, 500);
          } else {
            btnDownload.textContent = 'Error starting download';
            btnDownload.disabled = false;
          }
        } catch {
          btnDownload.textContent = 'Download Failed';
          btnDownload.disabled = false;
        }
      });
    }

    card.appendChild(btnDownload);
    return card;
  }

  private createMediasitePresentationCard(groupId: string, items: MediaItem[]): HTMLElement {
    const card = document.createElement('div');
    card.className = 'media-card';

    // Top Row: Stream Badge and Duration
    const topRow = document.createElement('div');
    topRow.className = 'media-card-top';

    const badge = document.createElement('span');
    badge.className = 'badge-stream badge-mediasite';
    badge.textContent = 'Mediasite';
    topRow.appendChild(badge);

    const maxDuration = Math.max(...items.map((i) => i.durationSec || 0));
    if (maxDuration > 0) {
      const duration = document.createElement('span');
      duration.className = 'media-duration';
      duration.textContent = formatDuration(maxDuration);
      topRow.appendChild(duration);
    }
    card.appendChild(topRow);

    // Presentation Title
    const primaryItem = items.find((i) => i.hasVideo) || items[0]!;
    const titleText =
      primaryItem.title.replace(/ - (Primary video|Secondary video|Slides|Audio|Presentation video).*$/i, '').trim() ||
      primaryItem.title;

    const title = document.createElement('h3');
    title.className = 'media-title';
    title.textContent = titleText;
    title.title = titleText;
    card.appendChild(title);

    // Detected Feeds Row
    const feedsRow = document.createElement('div');
    feedsRow.className = 'mediasite-feeds-row';

    const feedsLabel = document.createElement('span');
    feedsLabel.className = 'feeds-label';
    feedsLabel.textContent = 'Detected Feeds:';
    feedsRow.appendChild(feedsLabel);

    const feedsList = document.createElement('div');
    feedsList.className = 'feeds-chips';
    for (const feed of items) {
      const chip = document.createElement('span');
      chip.className = 'feed-chip';
      chip.textContent = feed.trackLabel || (feed.hasVideo ? 'Video' : 'Audio');
      feedsList.appendChild(chip);
    }
    feedsRow.appendChild(feedsList);
    card.appendChild(feedsRow);

    // Quality Selector Dropdown
    const controlsRow = document.createElement('div');
    controlsRow.className = 'media-controls-row';

    const selectWrapper = document.createElement('div');
    selectWrapper.className = 'select-wrapper';

    const select = document.createElement('select');
    select.className = 'select-apple';
    select.setAttribute('aria-label', 'Select video quality');

    const qualities =
      primaryItem.qualities && primaryItem.qualities.length > 0
        ? primaryItem.qualities
        : [{ id: 'q0', label: 'Default' }];

    const selectedQ = this.selectedQualities.get(groupId) || qualities[0]?.id || 'q0';

    for (const q of qualities) {
      const opt = document.createElement('option');
      opt.value = q.id;
      opt.textContent = q.label;
      if (q.id === selectedQ) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      this.selectedQualities.set(groupId, select.value);
    });

    const chevron = document.createElement('span');
    chevron.className = 'select-chevron';
    chevron.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;

    selectWrapper.appendChild(select);
    selectWrapper.appendChild(chevron);
    controlsRow.appendChild(selectWrapper);
    card.appendChild(controlsRow);

    // Segmented Layout Control
    const layoutGroup = document.createElement('div');
    layoutGroup.className = 'mediasite-layout-group';

    const layoutLabel = document.createElement('span');
    layoutLabel.className = 'mediasite-layout-label';
    layoutLabel.textContent = 'Dual-Stream Layout:';
    layoutGroup.appendChild(layoutLabel);

    const segmented = document.createElement('div');
    segmented.className = 'segmented-control';

    const layouts: { id: DualStreamLayout; label: string }[] = [
      { id: 'side-by-side', label: 'Side-by-Side' },
      { id: 'pip', label: 'PiP' },
      { id: 'multi-track', label: 'Tracks' },
      { id: 'separate', label: 'Separate' },
    ];

    const currentLayout =
      this.selectedLayouts.get(groupId) ||
      this.state?.settings?.dualStreamLayout ||
      primaryItem.layout ||
      'side-by-side';

    layouts.forEach((l) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `segment-btn ${l.id === currentLayout ? 'active' : ''}`;
      btn.textContent = l.label;
      btn.addEventListener('click', () => {
        this.selectedLayouts.set(groupId, l.id);
        segmented.querySelectorAll('.segment-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
      segmented.appendChild(btn);
    });

    layoutGroup.appendChild(segmented);
    card.appendChild(layoutGroup);

    // Download Button
    const btnDownload = document.createElement('button');
    btnDownload.type = 'button';
    btnDownload.className = 'btn-primary';
    btnDownload.style.width = '100%';

    const unsupported = items.find((i) => i.unsupportedReason)?.unsupportedReason;
    if (unsupported) {
      btnDownload.disabled = true;
      btnDownload.style.opacity = '0.6';
      btnDownload.textContent = unsupported;
    } else {
      btnDownload.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg> Download Presentation`;
      btnDownload.addEventListener('click', async () => {
        btnDownload.disabled = true;
        btnDownload.textContent = 'Starting...';

        const chosenLayout =
          this.selectedLayouts.get(groupId) ||
          this.state?.settings?.dualStreamLayout ||
          primaryItem.layout ||
          'side-by-side';

        const params: StartDownloadParams = {
          itemId: primaryItem.id,
          qualityId: this.selectedQualities.get(groupId) || qualities[0]?.id,
          layout: chosenLayout,
        };

        try {
          const res = await chrome.runtime.sendMessage<unknown, BgResponse<{ taskId: string }>>({
            type: 'startDownload',
            params,
          });
          if (res && res.ok) {
            btnDownload.textContent = 'Queued in VidDock';
            setTimeout(() => {
              this.refreshState();
            }, 500);
          } else {
            btnDownload.textContent = 'Error starting download';
            btnDownload.disabled = false;
          }
        } catch {
          btnDownload.textContent = 'Download Failed';
          btnDownload.disabled = false;
        }
      });
    }

    card.appendChild(btnDownload);
    return card;
  }

  private renderTasksDock(): void {
    if (!this.state) return;
    const dock = document.getElementById('tasks-summary-dock');
    const taskCountEl = document.getElementById('dock-task-count');
    const speedEl = document.getElementById('dock-task-speed');
    const progressFill = document.getElementById('dock-progress-fill');
    if (!dock || !taskCountEl || !speedEl || !progressFill) return;

    const activeTasks = this.state.tasks.filter((t) => isActive(t.state));
    if (activeTasks.length === 0) {
      dock.classList.add('hidden');
      return;
    }

    dock.classList.remove('hidden');
    taskCountEl.textContent = `${activeTasks.length} Active Download${activeTasks.length > 1 ? 's' : ''}`;

    const totalSpeed = activeTasks.reduce((sum, t) => sum + (t.progress?.bytesPerSec || 0), 0);
    speedEl.textContent = formatSpeed(totalSpeed);

    const avgPercent = activeTasks.reduce((sum, t) => sum + (t.progress?.percent || 0), 0) / activeTasks.length;
    progressFill.style.width = `${Math.min(100, Math.max(0, avgPercent))}%`;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const controller = new PopupController();
    controller.init();
  });
}
