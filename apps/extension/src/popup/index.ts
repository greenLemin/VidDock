import type {
  BgResponse,
  DownloadTask,
  DualStreamLayout,
  LiveMode,
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
  private selectedSubtitles = new Map<string, string>();
  private selectedLayouts = new Map<string, DualStreamLayout>();
  private selectedLiveModes = new Map<string, LiveMode>();
  private selectedLiveDurations = new Map<string, number>();
  private uiPort: chrome.runtime.Port | null = null;

  async init(): Promise<void> {
    this.bindStaticEvents();
    await this.checkOnboarding();
    await this.refreshState();
    this.connectStreamingPort();
  }

  async checkOnboarding(): Promise<void> {
    const modal = document.getElementById('onboarding-modal');
    if (!modal) return;
    try {
      const stored = await chrome.storage.local.get('hasSeenOnboarding');
      if (!stored.hasSeenOnboarding) {
        modal.classList.remove('hidden');
        document.getElementById('btn-onboarding-dismiss')?.addEventListener(
          'click',
          async () => {
            await this.dismissOnboarding();
          },
          { once: true },
        );
      } else {
        modal.classList.add('hidden');
      }
    } catch {
      modal.classList.add('hidden');
    }
  }

  async dismissOnboarding(): Promise<void> {
    const modal = document.getElementById('onboarding-modal');
    if (modal) {
      modal.classList.add('hidden');
    }
    try {
      await chrome.storage.local.set({ hasSeenOnboarding: true });
    } catch {}
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

    const btnDownloadAll = document.getElementById('btn-download-all');
    if (
      btnDownloadAll &&
      !(btnDownloadAll as unknown as { _hasDownloadAllListener?: boolean })._hasDownloadAllListener
    ) {
      (btnDownloadAll as unknown as { _hasDownloadAllListener?: boolean })._hasDownloadAllListener = true;
      btnDownloadAll.addEventListener('click', () => {
        this.downloadAll();
      });
    }

    document.addEventListener('keydown', (e: KeyboardEvent) => {
      const modal = document.getElementById('onboarding-modal');
      const isModalOpen = modal && !modal.classList.contains('hidden');

      if (isModalOpen) {
        if (e.key === 'Escape') {
          e.preventDefault?.();
          this.dismissOnboarding();
          return;
        }
        if (e.key === 'Tab') {
          const focusables = typeof modal.querySelectorAll === 'function'
            ? (Array.from(
                modal.querySelectorAll<HTMLElement>(
                  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
                ),
              ).filter((el) => !el.hasAttribute('disabled')) as HTMLElement[])
            : [];
          if (focusables.length > 0) {
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = typeof document !== 'undefined' ? document.activeElement : null;
            if (e.shiftKey) {
              if (active === first || (typeof modal.contains === 'function' && !modal.contains(active as Node))) {
                e.preventDefault?.();
                last?.focus?.();
              }
            } else {
              if (active === last || (typeof modal.contains === 'function' && !modal.contains(active as Node))) {
                e.preventDefault?.();
                first?.focus?.();
              }
            }
          }
        }
        return;
      }

      if (e.key === 'r' || e.key === 'R') {
        const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
        const tag = activeEl?.tagName?.toLowerCase();
        if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
          e.preventDefault?.();
          const refreshBtn = document.getElementById('btn-refresh-media');
          if (typeof refreshBtn?.click === 'function') {
            refreshBtn.click();
          } else {
            this.rescanMedia();
          }
        }
      }
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
    const btnDownloadAll = document.getElementById('btn-download-all') as HTMLButtonElement | null;
    if (!mediaList || !emptyState) return;

    const items = this.state.items || [];
    if (items.length === 0) {
      if (countBadge) countBadge.textContent = '0';
      mediaList.innerHTML = '';
      emptyState.classList.remove('hidden');
      if (btnDownloadAll) btnDownloadAll.classList.add('hidden');
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

    // Count downloadable (non-DRM) streams
    let downloadableCount = 0;
    for (const [, groupItems] of mediasiteGroups.entries()) {
      if (!groupItems.some((i) => i.unsupportedReason)) {
        downloadableCount++;
      }
    }
    for (const item of otherItems) {
      if (!item.unsupportedReason) {
        downloadableCount++;
      }
    }

    if (btnDownloadAll) {
      if (downloadableCount >= 2) {
        btnDownloadAll.classList.remove('hidden');
      } else {
        btnDownloadAll.classList.add('hidden');
      }
      if (!(btnDownloadAll as unknown as { _hasDownloadAllListener?: boolean })._hasDownloadAllListener) {
        (btnDownloadAll as unknown as { _hasDownloadAllListener?: boolean })._hasDownloadAllListener = true;
        btnDownloadAll.addEventListener('click', () => {
          this.downloadAll();
        });
      }
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
    card.setAttribute('data-item-id', item.id);

    // Top Row: Stream Badge and Duration
    const topRow = document.createElement('div');
    topRow.className = 'media-card-top';

    const badge = document.createElement('span');
    badge.className = `badge-stream badge-${item.kind === 'hls' ? 'hls' : item.kind === 'dash' ? 'dash' : item.source === 'mediasite' ? 'mediasite' : 'direct'}`;
    badge.textContent = item.source === 'mediasite' ? 'Mediasite' : item.kind.toUpperCase();
    topRow.appendChild(badge);

    if (item.isLive) {
      const liveBadge = document.createElement('span');
      liveBadge.className = 'badge-live';
      liveBadge.innerHTML = `<span class="live-dot"></span>LIVE`;
      topRow.appendChild(liveBadge);
    }

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

    if (!item.isLive && (item as unknown as { type?: string }).type !== 'audio') {
      const audioOpt = document.createElement('option');
      audioOpt.value = 'audio-only';
      audioOpt.textContent = 'Audio Only (M4A)';
      if (selectedQ === 'audio-only') audioOpt.selected = true;
      select.appendChild(audioOpt);
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

    // Subtitle Track Selection
    if (item.subtitles && item.subtitles.length > 0) {
      const subWrapper = document.createElement('div');
      subWrapper.className = 'select-wrapper subtitle-wrapper';

      const subSelect = document.createElement('select');
      subSelect.className = 'select-apple subtitle-select';
      subSelect.setAttribute('aria-label', 'Subtitles');

      const optAll = document.createElement('option');
      optAll.value = 'all';
      optAll.textContent = 'All Subtitles';
      subSelect.appendChild(optAll);

      const optNone = document.createElement('option');
      optNone.value = 'none';
      optNone.textContent = 'No Subtitles';
      subSelect.appendChild(optNone);

      const currentSub = this.selectedSubtitles.get(item.id) || 'all';

      for (const sub of item.subtitles) {
        const optSub = document.createElement('option');
        optSub.value = sub.id;
        optSub.textContent = sub.label || sub.language || sub.id;
        if (sub.id === currentSub) optSub.selected = true;
        subSelect.appendChild(optSub);
      }

      if (currentSub === 'all') optAll.selected = true;
      else if (currentSub === 'none') optNone.selected = true;

      subSelect.addEventListener('change', () => {
        this.selectedSubtitles.set(item.id, subSelect.value);
      });

      const subChevron = document.createElement('span');
      subChevron.className = 'select-chevron';
      subChevron.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;

      subWrapper.appendChild(subSelect);
      subWrapper.appendChild(subChevron);
      controlsRow.appendChild(subWrapper);
    }

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

    // Live Stream Controls if applicable
    if (item.isLive) {
      const liveGroup = document.createElement('div');
      liveGroup.className = 'live-mode-group';

      const liveLabel = document.createElement('span');
      liveLabel.className = 'live-mode-label';
      liveLabel.textContent = 'Capture Mode:';
      liveGroup.appendChild(liveLabel);

      const segmented = document.createElement('div');
      segmented.className = 'segmented-control live-mode-control';

      const modes: { id: LiveMode; label: string }[] = [
        { id: 'dvr', label: 'DVR Window' },
        { id: 'duration', label: 'Fixed Duration' },
        { id: 'until_stopped', label: 'Until Stopped' },
      ];

      const currentMode = this.selectedLiveModes.get(item.id) || 'dvr';

      const durPicker = document.createElement('div');
      durPicker.className = `live-duration-picker ${currentMode === 'duration' ? '' : 'hidden'}`;

      const durLabel = document.createElement('span');
      durLabel.className = 'live-duration-label';
      durLabel.textContent = 'Duration:';
      durPicker.appendChild(durLabel);

      const durSelectWrapper = document.createElement('div');
      durSelectWrapper.className = 'select-wrapper';

      const durSelect = document.createElement('select');
      durSelect.className = 'select-apple select-duration';
      durSelect.setAttribute('aria-label', 'Select live capture duration');

      const durations = [
        { seconds: 300, label: '5 minutes' },
        { seconds: 900, label: '15 minutes' },
        { seconds: 1800, label: '30 minutes' },
        { seconds: 3600, label: '60 minutes' },
      ];

      const currentDuration = this.selectedLiveDurations.get(item.id) || 900;

      for (const d of durations) {
        const opt = document.createElement('option');
        opt.value = String(d.seconds);
        opt.textContent = d.label;
        if (d.seconds === currentDuration) opt.selected = true;
        durSelect.appendChild(opt);
      }

      durSelect.addEventListener('change', () => {
        this.selectedLiveDurations.set(item.id, Number(durSelect.value));
      });

      const chevron = document.createElement('span');
      chevron.className = 'select-chevron';
      chevron.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;

      durSelectWrapper.appendChild(durSelect);
      durSelectWrapper.appendChild(chevron);
      durPicker.appendChild(durSelectWrapper);

      modes.forEach((m) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `segment-btn ${m.id === currentMode ? 'active' : ''}`;
        btn.textContent = m.label;
        btn.setAttribute('data-mode', m.id);
        btn.addEventListener('click', () => {
          this.selectedLiveModes.set(item.id, m.id);
          segmented.querySelectorAll('.segment-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          if (m.id === 'duration') {
            durPicker.classList.remove('hidden');
          } else {
            durPicker.classList.add('hidden');
          }
        });
        segmented.appendChild(btn);
      });

      liveGroup.appendChild(segmented);
      liveGroup.appendChild(durPicker);
      card.appendChild(liveGroup);
    }

    // Active Live Task: Render Stop & Save button
    const activeLiveTask = item.isLive
      ? this.state?.tasks.find(
          (t) =>
            (t.sourceUrl === item.url || t.request?.tracks?.some((tr) => tr.url === item.url)) && isActive(t.state),
        )
      : undefined;

    if (activeLiveTask) {
      const btnStop = document.createElement('button');
      btnStop.type = 'button';
      btnStop.className = 'btn-primary btn-stop btn-stop-live';
      btnStop.style.width = '100%';
      btnStop.textContent = 'Stop & Save';
      btnStop.setAttribute('aria-label', `Stop and save recording for ${item.title}`);
      btnStop.addEventListener('click', async () => {
        btnStop.disabled = true;
        btnStop.textContent = 'Stopping...';
        await chrome.runtime.sendMessage({
          type: 'taskAction',
          taskId: activeLiveTask.id,
          action: 'stop',
        });
        setTimeout(() => {
          this.refreshState();
        }, 500);
      });
      card.appendChild(btnStop);
      return card;
    }

    // Download / Record Button
    const btnDownload = document.createElement('button');
    btnDownload.type = 'button';
    btnDownload.className = 'btn-primary';
    btnDownload.style.width = '100%';

    if (item.unsupportedReason) {
      btnDownload.disabled = true;
      btnDownload.style.opacity = '0.6';
      btnDownload.textContent = item.unsupportedReason;
    } else {
      btnDownload.innerHTML = item.isLive
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg> Record Live Stream`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg> Download Video`;

      btnDownload.addEventListener('click', async () => {
        await this.downloadMediaItem(item, card);
        setTimeout(() => {
          this.refreshState();
        }, 500);
      });
    }

    card.appendChild(btnDownload);
    return card;
  }

  private createMediasitePresentationCard(groupId: string, items: MediaItem[]): HTMLElement {
    const card = document.createElement('div');
    card.className = 'media-card mediasite-card';
    card.setAttribute('data-item-id', groupId);
    card.setAttribute('data-presentation-id', groupId);

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
        await this.downloadMediasiteGroup(groupId, items, card);
        setTimeout(() => {
          this.refreshState();
        }, 500);
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
    const queuedTasks = this.state.tasks.filter((t) => t.state === 'queued');
    const failedTasks = this.state.tasks.filter((t) => t.state === 'failed');

    if (activeTasks.length === 0 && queuedTasks.length === 0 && failedTasks.length === 0) {
      dock.classList.add('hidden');
      dock.querySelector('.dock-stop-btn')?.remove();
      return;
    }

    dock.classList.remove('hidden');

    const activeLiveTask = activeTasks.find((t) => t.isLive);
    let dockStopBtn = dock.querySelector('.dock-stop-btn') as HTMLButtonElement | null;
    if (activeLiveTask) {
      if (!dockStopBtn) {
        dockStopBtn = document.createElement('button');
        dockStopBtn.className = 'btn-secondary btn-sm dock-stop-btn btn-stop-live';
        dockStopBtn.textContent = 'Stop & Save';
        dockStopBtn.setAttribute('aria-label', `Stop and save live recording: ${activeLiveTask.title}`);
        dockStopBtn.addEventListener('click', async () => {
          dockStopBtn!.disabled = true;
          dockStopBtn!.textContent = 'Stopping...';
          await chrome.runtime.sendMessage({
            type: 'taskAction',
            taskId: activeLiveTask.id,
            action: 'stop',
          });
          setTimeout(() => this.refreshState(), 500);
        });
        const dockHeader = dock.querySelector('.dock-header');
        const viewAll = document.getElementById('dock-view-all');
        if (dockHeader && viewAll) {
          dockHeader.insertBefore(dockStopBtn, viewAll);
        } else {
          dock.appendChild(dockStopBtn);
        }
      }
    } else if (dockStopBtn) {
      dockStopBtn.remove();
    }

    if (activeTasks.length > 0) {
      let label = `${activeTasks.length} Active Download${activeTasks.length > 1 ? 's' : ''}`;
      if (failedTasks.length > 0) label += ` • ${failedTasks.length} Failed`;
      else if (queuedTasks.length > 0) label += ` • ${queuedTasks.length} Queued`;
      taskCountEl.textContent = label;

      const totalSpeed = activeTasks.reduce((sum, t) => sum + (t.progress?.bytesPerSec || 0), 0);
      speedEl.textContent = formatSpeed(totalSpeed);

      const avgPercent = activeTasks.reduce((sum, t) => sum + (t.progress?.percent || 0), 0) / activeTasks.length;
      progressFill.className = 'progress-fill';
      progressFill.style.width = `${Math.min(100, Math.max(0, avgPercent))}%`;
    } else if (failedTasks.length > 0) {
      taskCountEl.textContent = `${failedTasks.length} Failed Download${failedTasks.length > 1 ? 's' : ''}`;
      speedEl.textContent = 'Action Required';
      progressFill.className = 'progress-fill failed';
      progressFill.style.width = '100%';
    } else {
      taskCountEl.textContent = `${queuedTasks.length} Queued Task${queuedTasks.length > 1 ? 's' : ''}`;
      speedEl.textContent = 'Queued';
      progressFill.className = 'progress-fill';
      progressFill.style.width = '0%';
    }
  }

  async downloadAll(): Promise<void> {
    if (!this.state) return;
    const btnDownloadAll = document.getElementById('btn-download-all') as HTMLButtonElement | null;
    if (btnDownloadAll) {
      btnDownloadAll.disabled = true;
      btnDownloadAll.textContent = 'Downloading...';
    }

    const items = this.state.items || [];
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

    for (const [groupId, groupItems] of mediasiteGroups.entries()) {
      if (!groupItems.some((i) => i.unsupportedReason)) {
        await this.downloadMediasiteGroup(groupId, groupItems);
      }
    }

    for (const item of otherItems) {
      if (!item.unsupportedReason) {
        await this.downloadMediaItem(item);
      }
    }

    if (btnDownloadAll) {
      btnDownloadAll.textContent = 'All Queued';
      setTimeout(() => {
        btnDownloadAll.disabled = false;
        btnDownloadAll.textContent = 'Download All';
        this.refreshState();
      }, 1000);
    } else {
      this.refreshState();
    }
  }

  private async downloadMediaItem(item: MediaItem, card?: HTMLElement): Promise<void> {
    const targetCard =
      card ||
      (typeof document.querySelector === 'function'
        ? (document.querySelector(`[data-item-id="${item.id}"]`) as HTMLElement | null)
        : null);
    const btnDownload = targetCard?.querySelector
      ? (targetCard.querySelector('button.btn-primary:not(.btn-stop)') as HTMLButtonElement | null)
      : null;

    if (btnDownload) {
      btnDownload.disabled = true;
      btnDownload.textContent = item.isLive ? 'Starting stream capture...' : 'Starting...';
    }

    const qualities = item.qualities && item.qualities.length > 0 ? item.qualities : [{ id: 'q0', label: 'Default' }];
    const liveMode = item.isLive ? this.selectedLiveModes.get(item.id) || 'dvr' : undefined;
    const liveDurationSeconds =
      liveMode === 'duration' ? this.selectedLiveDurations.get(item.id) || 900 : undefined;

    const selectedSubtitle = this.selectedSubtitles.get(item.id) || 'all';
    const subtitleIds =
      selectedSubtitle === 'none' ? [] : selectedSubtitle === 'all' ? undefined : [selectedSubtitle];

    const chosenQuality = this.selectedQualities.get(item.id) || qualities[0]?.id;
    const activeSegment = targetCard?.querySelector
      ? (targetCard.querySelector('.segment-btn.active') as HTMLElement | null)
      : null;
    const domLayout = (activeSegment?.dataset?.layout ||
      activeSegment?.getAttribute?.('data-layout')) as DualStreamLayout | undefined;

    const chosenLayout =
      domLayout ||
      this.selectedLayouts.get(item.groupId || item.id) ||
      this.state?.settings?.dualStreamLayout ||
      item.layout ||
      'side-by-side';

    const params: StartDownloadParams & { selectedQuality?: string; selectedSubtitles?: string } = {
      itemId: item.id,
      qualityId: chosenQuality,
      selectedQuality: chosenQuality,
      layout: chosenLayout,
      liveMode,
      liveDurationSeconds,
    };
    if (subtitleIds !== undefined) {
      params.subtitleIds = subtitleIds;
    }
    if (this.selectedSubtitles.has(item.id) || (item.subtitles && item.subtitles.length > 0)) {
      params.selectedSubtitles = selectedSubtitle;
    }

    try {
      const res = await chrome.runtime.sendMessage<unknown, BgResponse<{ taskId: string }>>({
        type: 'startDownload',
        params,
      });
      if (res && res.ok) {
        if (btnDownload) {
          btnDownload.textContent = item.isLive ? 'Recording Live Stream...' : 'Queued in VidDock';
        }
        if (item.isLive && res.data?.taskId && targetCard) {
          const liveTaskId = res.data.taskId;
          if (!targetCard.querySelector('.btn-stop')) {
            const btnStop = document.createElement('button');
            btnStop.type = 'button';
            btnStop.className = 'btn-primary btn-stop btn-stop-live';
            btnStop.style.width = '100%';
            btnStop.style.marginTop = '6px';
            btnStop.textContent = 'Stop & Save';
            btnStop.setAttribute('aria-label', `Stop and save recording for ${item.title}`);
            btnStop.addEventListener('click', async () => {
              btnStop.disabled = true;
              btnStop.textContent = 'Stopping...';
              await chrome.runtime.sendMessage({
                type: 'taskAction',
                taskId: liveTaskId,
                action: 'stop',
              });
              setTimeout(() => this.refreshState(), 500);
            });
            targetCard.appendChild(btnStop);
          }
        }
      } else {
        if (btnDownload) {
          btnDownload.textContent = item.isLive ? 'Error starting capture' : 'Error starting download';
          btnDownload.disabled = false;
        }
      }
    } catch {
      if (btnDownload) {
        btnDownload.textContent = item.isLive ? 'Capture Failed' : 'Download Failed';
        btnDownload.disabled = false;
      }
    }
  }

  private async downloadMediasiteGroup(
    presentationId: string,
    items: MediaItem[],
    card?: HTMLElement,
  ): Promise<void> {
    const primaryItem = items.find((i) => i.hasVideo) || items[0]!;
    const targetCard =
      card ||
      (typeof document.querySelector === 'function'
        ? (document.querySelector(
            `.mediasite-card[data-presentation-id="${presentationId}"]`,
          ) as HTMLElement | null) ||
          (document.querySelector(`[data-item-id="${presentationId}"]`) as HTMLElement | null)
        : null);
    const btnDownload = targetCard?.querySelector
      ? (targetCard.querySelector('button.btn-primary') as HTMLButtonElement | null)
      : null;

    if (btnDownload) {
      btnDownload.disabled = true;
      btnDownload.textContent = 'Starting...';
    }

    const qualities =
      primaryItem.qualities && primaryItem.qualities.length > 0
        ? primaryItem.qualities
        : [{ id: 'q0', label: 'Default' }];

    const activeSegment = targetCard?.querySelector
      ? (targetCard.querySelector('.segment-btn.active') as HTMLElement | null)
      : null;
    const domLayout = (activeSegment?.dataset?.layout ||
      activeSegment?.getAttribute?.('data-layout')) as DualStreamLayout | undefined;

    const settingsMediasiteLayout =
      (this.state?.settings as unknown as { mediasiteLayout?: DualStreamLayout })?.mediasiteLayout ??
      this.state?.settings?.dualStreamLayout;

    const chosenLayout: DualStreamLayout =
      domLayout ||
      this.selectedLayouts.get(presentationId) ||
      settingsMediasiteLayout ||
      primaryItem.layout ||
      'side-by-side';

    const chosenQuality = this.selectedQualities.get(presentationId) || qualities[0]?.id;
    const chosenMediasiteSub = this.selectedSubtitles.get(presentationId);

    const params: StartDownloadParams & { selectedQuality?: string; selectedSubtitles?: string } = {
      itemId: primaryItem.id,
      qualityId: chosenQuality,
      selectedQuality: chosenQuality,
      layout: chosenLayout,
      ...(chosenMediasiteSub ? { selectedSubtitles: chosenMediasiteSub } : {}),
    };

    try {
      const res = await chrome.runtime.sendMessage<unknown, BgResponse<{ taskId: string }>>({
        type: 'startDownload',
        params,
      });
      if (res && res.ok) {
        if (btnDownload) btnDownload.textContent = 'Queued in VidDock';
      } else {
        if (btnDownload) {
          btnDownload.textContent = 'Error starting download';
          btnDownload.disabled = false;
        }
      }
    } catch {
      if (btnDownload) {
        btnDownload.textContent = 'Download Failed';
        btnDownload.disabled = false;
      }
    }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const controller = new PopupController();
    controller.init();
  });
}
