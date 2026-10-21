import type { BgResponse, DualStreamLayout, NativeStatus, Settings } from '@viddock/shared';
import { DEFAULT_SETTINGS, applyFilenameTemplate } from '@viddock/shared';

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

class SettingsController {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private nativeStatus: NativeStatus = { connected: false };
  private selectedMediasiteLayout: DualStreamLayout = 'side-by-side';

  async init(): Promise<void> {
    this.bindEvents();
    await this.loadSettings();
    await this.loadNativeStatus();
  }

  private bindEvents(): void {
    // Dashboard Button
    document.getElementById('btn-open-dashboard')?.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
    });

    // Theme Mode Segmented Control
    document.querySelectorAll('#theme-segmented .segment-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const theme = target.getAttribute('data-theme') as 'system' | 'light' | 'dark';
        if (!theme) return;

        this.applyTheme(theme);
        this.savePartialSettings({ theme });
      });
    });

    // Preferred Quality
    const qualitySelect = document.getElementById('pref-quality') as HTMLSelectElement;
    qualitySelect?.addEventListener('change', () => {
      const val = qualitySelect.value;
      const preferredQuality = val === 'best' ? 'best' : (parseInt(val, 10) as Settings['preferredQuality']);
      this.savePartialSettings({ preferredQuality });
    });

    // Output Container
    const containerSelect = document.getElementById('pref-container') as HTMLSelectElement;
    containerSelect?.addEventListener('change', () => {
      this.savePartialSettings({ container: containerSelect.value as Settings['container'] });
    });

    // Segment Concurrency Slider
    const concurrencySlider = document.getElementById('pref-concurrency') as HTMLInputElement;
    const concurrencyVal = document.getElementById('concurrency-val');
    concurrencySlider?.addEventListener('input', () => {
      const val = parseInt(concurrencySlider.value, 10);
      if (concurrencyVal) concurrencyVal.textContent = String(val);
    });
    concurrencySlider?.addEventListener('change', () => {
      const val = parseInt(concurrencySlider.value, 10);
      this.savePartialSettings({ segmentConcurrency: val });
    });

    // Direct Downloads via Chrome
    const directChromeCheck = document.getElementById('pref-direct-chrome') as HTMLInputElement;
    directChromeCheck?.addEventListener('change', () => {
      this.savePartialSettings({ directViaChrome: directChromeCheck.checked });
    });

    // Notifications
    const notifCheck = document.getElementById('pref-notifications') as HTMLInputElement;
    notifCheck?.addEventListener('change', () => {
      this.savePartialSettings({ notifications: notifCheck.checked });
    });

    // Mediasite Layout Segmented Control
    document.querySelectorAll('#mediasite-layout-segmented .segment-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const layout = target.getAttribute('data-layout') as DualStreamLayout;
        if (!layout) return;

        this.selectedMediasiteLayout = layout;
        document
          .querySelectorAll('#mediasite-layout-segmented .segment-btn')
          .forEach((b) => b.classList.remove('active'));
        target.classList.add('active');
        // Stored in settings or default layout
      });
    });

    // Filename Template Input
    const templateInput = document.getElementById('filename-template-input') as HTMLInputElement;
    templateInput?.addEventListener('input', () => {
      this.updateTemplatePreview(templateInput.value);
      this.savePartialSettings({ filenameTemplate: templateInput.value });
    });

    // Token Chips Click
    document.querySelectorAll('.token-chip').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const token = target.getAttribute('data-token');
        if (!token || !templateInput) return;

        templateInput.value += ` - ${token}`;
        this.updateTemplatePreview(templateInput.value);
        this.savePartialSettings({ filenameTemplate: templateInput.value });
      });
    });

    // Test Companion Button
    document.getElementById('btn-test-companion')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-test-companion') as HTMLButtonElement;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Testing...';
      }
      try {
        await chrome.runtime.sendMessage({ type: 'diagnostics' });
        await this.loadNativeStatus();
      } catch {
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Test Connection';
        }
      }
    });
  }

  private applyTheme(theme: 'system' | 'light' | 'dark'): void {
    try {
      localStorage.setItem('viddock_theme', theme);
      const meta = document.querySelector('meta[name="color-scheme"]') as HTMLMetaElement;
      if (meta) {
        meta.content = theme === 'system' ? 'light dark' : theme;
      }
    } catch {}

    document.querySelectorAll('#theme-segmented .segment-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-theme') === theme);
    });
  }

  private updateTemplatePreview(template: string): void {
    const previewEl = document.getElementById('template-preview-text');
    if (!previewEl) return;

    const preview = applyFilenameTemplate(template || '{title}', {
      title: 'CS101 Lecture 03',
      quality: '1080p',
      site: 'canvas.edu',
      id: 'task_demo',
      date: new Date(),
    });

    previewEl.textContent = `${preview}.${this.settings.container === 'auto' ? 'mp4' : this.settings.container}`;
  }

  private async loadSettings(): Promise<void> {
    try {
      const res = await chrome.runtime.sendMessage<unknown, BgResponse<Settings>>({
        type: 'getSettings',
      });
      if (res && res.ok) {
        this.settings = res.data;
        this.populateForm();
      }
    } catch {}
  }

  private populateForm(): void {
    // Theme
    this.applyTheme(this.settings.theme || 'system');

    // Quality
    const qualitySelect = document.getElementById('pref-quality') as HTMLSelectElement;
    if (qualitySelect) qualitySelect.value = String(this.settings.preferredQuality);

    // Container
    const containerSelect = document.getElementById('pref-container') as HTMLSelectElement;
    if (containerSelect) containerSelect.value = this.settings.container;

    // Concurrency
    const concurrencySlider = document.getElementById('pref-concurrency') as HTMLInputElement;
    const concurrencyVal = document.getElementById('concurrency-val');
    if (concurrencySlider) concurrencySlider.value = String(this.settings.segmentConcurrency);
    if (concurrencyVal) concurrencyVal.textContent = String(this.settings.segmentConcurrency);

    // Direct Chrome
    const directChromeCheck = document.getElementById('pref-direct-chrome') as HTMLInputElement;
    if (directChromeCheck) directChromeCheck.checked = this.settings.directViaChrome;

    // Notifications
    const notifCheck = document.getElementById('pref-notifications') as HTMLInputElement;
    if (notifCheck) notifCheck.checked = this.settings.notifications;

    // Filename Template
    const templateInput = document.getElementById('filename-template-input') as HTMLInputElement;
    if (templateInput) {
      templateInput.value = this.settings.filenameTemplate || '{title}';
      this.updateTemplatePreview(templateInput.value);
    }
  }

  private async savePartialSettings(partial: Partial<Settings>): Promise<void> {
    this.settings = { ...this.settings, ...partial };
    try {
      await chrome.runtime.sendMessage({
        type: 'setSettings',
        settings: partial,
      });
    } catch {}
  }

  private async loadNativeStatus(): Promise<void> {
    try {
      const res = await chrome.runtime.sendMessage<unknown, BgResponse<NativeStatus>>({
        type: 'nativeStatus',
      });
      if (res && res.ok) {
        this.nativeStatus = res.data;
        this.renderNativeStatus();
      }
    } catch {}
  }

  private renderNativeStatus(): void {
    const badge = document.getElementById('companion-badge');
    const statusText = document.getElementById('companion-status-text');
    const versionEl = document.getElementById('diag-host-version');
    const outputDirEl = document.getElementById('diag-output-dir');
    const ffmpegEl = document.getElementById('diag-ffmpeg');
    const ffprobeEl = document.getElementById('diag-ffprobe');
    const helpBox = document.getElementById('companion-help-box');
    const platformEl = document.getElementById('companion-platform-text');

    if (!badge || !statusText) return;

    badge.className = 'status-pill';
    if (this.nativeStatus.connected) {
      badge.classList.add('status-connected');
      statusText.textContent = 'Connected';
      if (helpBox) helpBox.classList.add('hidden');
    } else if (this.nativeStatus.error) {
      badge.classList.add('status-disconnected');
      statusText.textContent = 'Disconnected';
      if (helpBox) helpBox.classList.remove('hidden');
    } else {
      badge.classList.add('status-connecting');
      statusText.textContent = 'Connecting...';
    }

    if (platformEl) platformEl.textContent = this.nativeStatus.platform || 'macOS';
    if (versionEl) versionEl.textContent = this.nativeStatus.version ? `v${this.nativeStatus.version}` : '--';
    if (outputDirEl) outputDirEl.textContent = this.nativeStatus.defaultOutputDir || '~/Downloads';
    if (ffmpegEl) ffmpegEl.textContent = this.nativeStatus.ffmpeg || 'Not found';
    if (ffprobeEl) ffprobeEl.textContent = this.nativeStatus.ffprobe || 'Not found';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const controller = new SettingsController();
  controller.init();
});
