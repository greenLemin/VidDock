import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaItem, NativeStatus, PopupState } from '@viddock/shared';
import { PopupController } from '../src/popup/index.ts';
import { setupChromeMock } from './mocks/chrome.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface MockElement {
  id?: string;
  tagName: string;
  className: string;
  textContent: string;
  title: string;
  disabled?: boolean;
  value?: string;
  selected?: boolean;
  style: Record<string, string>;
  children: MockElement[];
  attributes: Map<string, string>;
  listeners: Map<string, ((e?: unknown) => void)[]>;
  classList: {
    add: (...tokens: string[]) => void;
    remove: (...tokens: string[]) => void;
    toggle: (token: string, force?: boolean) => boolean;
    contains: (token: string) => boolean;
  };
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  hasAttribute: (name: string) => boolean;
  removeAttribute: (name: string) => void;
  appendChild: (child: MockElement) => MockElement;
  removeChild: (child: MockElement) => MockElement;
  querySelector: (sel: string) => MockElement | null;
  querySelectorAll: (sel: string) => MockElement[];
  addEventListener: (event: string, fn: (e?: unknown) => void) => void;
  dispatchEvent: (event: { type: string; preventDefault?: () => void; [key: string]: unknown }) => void;
  innerHTML: string;
  click?: () => void;
  focus?: () => void;
}

function matchesSelector(el: MockElement, sel: string): boolean {
  if (sel === '*') return true;
  if (sel.includes(':not(')) {
    const m = /^(.*?):not\((.*?)\)$/.exec(sel);
    if (m) {
      const baseSel = m[1]?.trim();
      const notSel = m[2]?.trim();
      if (baseSel && !matchesSelector(el, baseSel)) return false;
      if (notSel && matchesSelector(el, notSel)) return false;
      return true;
    }
  }
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.includes('.')) {
    const [tag, ...classes] = sel.split('.');
    if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    return classes.every((c) => el.classList.contains(c));
  }
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const attrExp = sel.slice(1, -1);
    if (attrExp.includes('=')) {
      const [attrName, rawVal] = attrExp.split('=');
      const val = (rawVal ?? '').replace(/^["']|["']$/g, '');
      return el.getAttribute(attrName ?? '') === val;
    }
    return el.getAttribute(attrExp) !== null;
  }
  return el.tagName.toLowerCase() === sel.toLowerCase();
}

function createMockElement(id = '', tagName = 'div'): MockElement {
  let classes = new Set<string>();
  const attributes = new Map<string, string>();
  const listeners = new Map<string, ((e?: unknown) => void)[]>();
  const children: MockElement[] = [];
  const style: Record<string, string> = {};
  let innerHtml = '';

  const el: MockElement = {
    id,
    tagName,
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(val: string) {
      classes = new Set(val.split(/\s+/).filter(Boolean));
    },
    textContent: '',
    title: '',
    style,
    children,
    attributes,
    listeners,
    classList: {
      add: (...tokens: string[]) => tokens.forEach((t) => classes.add(t)),
      remove: (...tokens: string[]) => tokens.forEach((t) => classes.delete(t)),
      toggle: (token: string, force?: boolean) => {
        if (force === true) {
          classes.add(token);
          return true;
        }
        if (force === false) {
          classes.delete(token);
          return false;
        }
        if (classes.has(token)) {
          classes.delete(token);
          return false;
        }
        classes.add(token);
        return true;
      },
      contains: (token: string) => classes.has(token),
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    hasAttribute: (name: string) => attributes.has(name),
    removeAttribute: (name: string) => {
      attributes.delete(name);
    },
    appendChild: (child: MockElement) => {
      children.push(child);
      return child;
    },
    removeChild: (child: MockElement) => {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
      return child;
    },
    querySelector: (sel: string): MockElement | null => {
      for (const child of children) {
        if (matchesSelector(child, sel)) return child;
        const nested = child.querySelector(sel);
        if (nested) return nested;
      }
      return null;
    },
    querySelectorAll: (sel: string): MockElement[] => {
      const matches: MockElement[] = [];
      for (const child of children) {
        if (matchesSelector(child, sel)) matches.push(child);
        matches.push(...child.querySelectorAll(sel));
      }
      return matches;
    },
    addEventListener: (event: string, fn: (e?: unknown) => void) => {
      const list = listeners.get(event) || [];
      list.push(fn);
      listeners.set(event, list);
    },
    dispatchEvent: (event: { type: string; preventDefault?: () => void; [key: string]: unknown }) => {
      const list = listeners.get(event.type) || [];
      for (const fn of list) fn(event);
    },
    get innerHTML() {
      return innerHtml;
    },
    set innerHTML(val: string) {
      innerHtml = val;
      if (val === '') {
        children.length = 0;
      }
    },
    click: () => {
      el.dispatchEvent({ type: 'click' });
    },
    focus: () => {},
  };

  return el;
}

describe('Popup Controller & Host Warning Tests', () => {
  const elements = new Map<string, MockElement>();
  const docListeners = new Map<string, ((e?: unknown) => void)[]>();

  beforeEach(() => {
    elements.clear();
    docListeners.clear();

    const ids = [
      'popup-root',
      'host-status-pill',
      'host-status-text',
      'ffmpeg-warning-banner',
      'link-setup-ffmpeg',
      'btn-open-dashboard',
      'btn-open-settings',
      'btn-refresh-media',
      'btn-empty-rescan',
      'btn-download-all',
      'dock-view-all',
      'media-count',
      'media-list',
      'empty-state',
      'tasks-summary-dock',
      'dock-task-count',
      'dock-task-speed',
      'dock-progress-fill',
      'onboarding-modal',
      'btn-onboarding-dismiss',
    ];

    for (const id of ids) {
      const el = createMockElement(id);
      if (id === 'btn-download-all' || id === 'ffmpeg-warning-banner' || id === 'empty-state') {
        el.classList.add('hidden');
      }
      if (id === 'onboarding-modal') {
        el.classList.add('hidden');
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
      }
      elements.set(id, el);
    }

    const mockDocument = {
      getElementById: (id: string) => elements.get(id) || null,
      querySelectorAll: (sel: string) => {
        const matches: MockElement[] = [];
        for (const el of elements.values()) {
          if (matchesSelector(el, sel)) matches.push(el);
          matches.push(...el.querySelectorAll(sel));
        }
        return matches;
      },
      querySelector: (sel: string) => {
        for (const el of elements.values()) {
          if (matchesSelector(el, sel)) return el;
          const found = el.querySelector(sel);
          if (found) return found;
        }
        return null;
      },
      createElement: (tag: string) => createMockElement('', tag),
      addEventListener: (event: string, fn: (e?: unknown) => void) => {
        const list = docListeners.get(event) || [];
        list.push(fn);
        docListeners.set(event, list);
      },
      dispatchEvent: (event: { type: string; preventDefault?: () => void; [key: string]: unknown }) => {
        const list = docListeners.get(event.type) || [];
        for (const fn of list) fn(event);
      },
    };

    (globalThis as unknown as { document: unknown }).document = mockDocument;
    setupChromeMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders FFmpeg Missing warning pill and displays warning banner when host is connected without FFmpeg', () => {
    const controller = new PopupController();
    const statusWithoutFfmpeg: NativeStatus = {
      connected: true,
      version: '1.0.0',
      platform: 'darwin',
      ffmpeg: undefined,
      ffprobe: undefined,
    };

    controller.renderHostStatus(statusWithoutFfmpeg);

    const pill = elements.get('host-status-pill')!;
    const label = elements.get('host-status-text')!;
    const warningBanner = elements.get('ffmpeg-warning-banner')!;

    expect(pill.classList.contains('status-warning')).toBe(true);
    expect(label.textContent).toBe('FFmpeg Missing');
    expect(warningBanner.classList.contains('hidden')).toBe(false);
    expect(pill.title).toContain('FFmpeg is not installed');
  });

  it('renders Host version connected pill and hides warning banner when FFmpeg is present', () => {
    const controller = new PopupController();
    const statusWithFfmpeg: NativeStatus = {
      connected: true,
      version: '1.0.0',
      platform: 'darwin',
      ffmpeg: '/opt/homebrew/bin/ffmpeg',
      ffprobe: '/opt/homebrew/bin/ffprobe',
    };

    controller.renderHostStatus(statusWithFfmpeg);

    const pill = elements.get('host-status-pill')!;
    const label = elements.get('host-status-text')!;
    const warningBanner = elements.get('ffmpeg-warning-banner')!;

    expect(pill.classList.contains('status-connected')).toBe(true);
    expect(label.textContent).toBe('Host v1.0.0');
    expect(warningBanner.classList.contains('hidden')).toBe(true);
  });

  it('verifies apps/extension/src/popup/index.html includes required warning banner and setup link', () => {
    const htmlPath = path.resolve(__dirname, '../src/popup/index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    expect(htmlContent).toContain('id="ffmpeg-warning-banner"');
    expect(htmlContent).toContain('id="link-setup-ffmpeg"');
    expect(htmlContent).toContain('FFmpeg not found');
  });

  it('shows #btn-download-all when 2+ media streams are present and queues downloads on click', async () => {
    const controller = new PopupController();
    const btnDownloadAll = elements.get('btn-download-all')!;

    // 1 item: button remains hidden
    const singleItemState: Partial<PopupState> = {
      items: [
        {
          id: 'item-1',
          url: 'https://example.com/stream1.m3u8',
          pageUrl: 'https://example.com',
          tabId: 1,
          title: 'Video 1',
          kind: 'hls',
          source: 'network',
          hasVideo: true,
          hasAudio: true,
          qualities: [],
          audioTracks: [],
          subtitles: [],
          detectedAt: Date.now(),
        },
      ],
      tasks: [],
    };
    (controller as unknown as { state: PopupState }).state = singleItemState as PopupState;
    (controller as unknown as { renderMediaList: () => void })['renderMediaList']();

    expect(btnDownloadAll.classList.contains('hidden')).toBe(true);

    // 2 items: button becomes visible
    const multiItemState: Partial<PopupState> = {
      items: [
        {
          id: 'item-1',
          url: 'https://example.com/stream1.m3u8',
          pageUrl: 'https://example.com',
          tabId: 1,
          title: 'Video 1',
          kind: 'hls',
          source: 'network',
          hasVideo: true,
          hasAudio: true,
          qualities: [],
          audioTracks: [],
          subtitles: [],
          detectedAt: Date.now(),
        },
        {
          id: 'item-2',
          url: 'https://example.com/stream2.mp4',
          pageUrl: 'https://example.com',
          tabId: 1,
          title: 'Video 2',
          kind: 'direct',
          source: 'network',
          hasVideo: true,
          hasAudio: true,
          qualities: [],
          audioTracks: [],
          subtitles: [],
          detectedAt: Date.now(),
        },
      ],
      tasks: [],
    };
    (controller as unknown as { state: PopupState }).state = multiItemState as PopupState;
    (controller as unknown as { renderMediaList: () => void })['renderMediaList']();

    expect(btnDownloadAll.classList.contains('hidden')).toBe(false);

    // Click triggers queueing downloads
    const sendSpy = vi.spyOn(chrome.runtime, 'sendMessage');
    btnDownloadAll.dispatchEvent({ type: 'click' });

    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'startDownload',
          params: expect.objectContaining({ itemId: 'item-1' }),
        }),
      );
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'startDownload',
          params: expect.objectContaining({ itemId: 'item-2' }),
        }),
      );
    });
  });

  it('includes Audio Only (M4A) option in quality selector for video streams', () => {
    const controller = new PopupController();
    const videoItem: MediaItem = {
      id: 'video-stream',
      url: 'https://example.com/video.mp4',
      pageUrl: 'https://example.com',
      tabId: 1,
      title: 'Sample Video Track',
      kind: 'direct',
      source: 'network',
      hasVideo: true,
      hasAudio: true,
      qualities: [
        { id: '1080p', label: '1080p', ref: 'https://example.com/1080p.mp4' },
        { id: '720p', label: '720p', ref: 'https://example.com/720p.mp4' },
      ],
      audioTracks: [],
      subtitles: [],
      detectedAt: Date.now(),
    };

    const card = (controller as unknown as { createMediaCard: (item: MediaItem) => MockElement })['createMediaCard'](
      videoItem,
    );

    const select = card.querySelector('select.select-apple');
    expect(select).not.toBeNull();

    const options = select!.querySelectorAll('option');
    const audioOnlyOpt = options.find((opt) => opt.value === 'audio-only');

    expect(audioOnlyOpt).toBeDefined();
    expect(audioOnlyOpt?.textContent).toBe('Audio Only (M4A)');
  });

  it('verifies #onboarding-modal has role="dialog" and aria-modal="true", and Escape dismisses it', async () => {
    const htmlPath = path.resolve(__dirname, '../src/popup/index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    expect(htmlContent).toMatch(/<div[^>]*id="onboarding-modal"[^>]*role="dialog"/);
    expect(htmlContent).toMatch(/<div[^>]*id="onboarding-modal"[^>]*aria-modal="true"/);

    const modal = elements.get('onboarding-modal')!;
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');

    const controller = new PopupController();
    (controller as unknown as { bindStaticEvents: () => void })['bindStaticEvents']();

    // Modal is initially shown
    modal.classList.remove('hidden');
    expect(modal.classList.contains('hidden')).toBe(false);

    // Escape dismisses modal
    let defaultPrevented = false;
    (globalThis as unknown as { document: { dispatchEvent: (e: unknown) => void } }).document.dispatchEvent({
      type: 'keydown',
      key: 'Escape',
      preventDefault: () => {
        defaultPrevented = true;
      },
    });

    await vi.waitFor(() => {
      expect(modal.classList.contains('hidden')).toBe(true);
    });
    expect(defaultPrevented).toBe(true);

    const stored = await chrome.storage.local.get('hasSeenOnboarding');
    expect(stored.hasSeenOnboarding).toBe(true);
  });
});
