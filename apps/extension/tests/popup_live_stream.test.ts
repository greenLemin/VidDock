import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaItem, StartDownloadParams } from '@viddock/shared';
import { PopupController } from '../src/popup/index.ts';
import { setupChromeMock } from './mocks/chrome.ts';

interface MockElement {
  id?: string;
  tagName: string;
  className: string;
  textContent: string;
  title: string;
  value: string;
  disabled: boolean;
  selected?: boolean;
  type?: string;
  innerHTML: string;
  style: Record<string, string>;
  children: MockElement[];
  parentElement: MockElement | null;
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
  appendChild: (child: MockElement) => MockElement;
  insertBefore: (newChild: MockElement, refChild: MockElement | null) => MockElement;
  remove: () => void;
  querySelector: (sel: string) => MockElement | null;
  querySelectorAll: (sel: string) => MockElement[];
  addEventListener: (event: string, fn: (e?: unknown) => void) => void;
  dispatchEvent: (event: { type: string; preventDefault?: () => void }) => void;
  click: () => void;
}

function matchesSimple(el: MockElement, sel: string): boolean {
  if (sel.startsWith('.')) {
    return el.classList.contains(sel.slice(1));
  }
  if (sel.startsWith('#')) {
    return el.id === sel.slice(1);
  }
  const attrMatch = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel);
  if (attrMatch) {
    const attrName = attrMatch[1]!;
    const attrVal = attrMatch[2];
    if (attrVal !== undefined) {
      return el.getAttribute(attrName) === attrVal;
    }
    return el.getAttribute(attrName) !== null;
  }
  return el.tagName.toLowerCase() === sel.toLowerCase();
}

function matchesSelector(el: MockElement, selector: string): boolean {
  const parts = selector.match(/(\.[a-zA-Z0-9_-]+|#[a-zA-Z0-9_-]+|\[[^\]]+\]|[a-zA-Z0-9_-]+)/g);
  if (!parts || parts.length === 0) return false;
  return parts.every((p) => matchesSimple(el, p));
}

function findQuerySelector(root: MockElement, selector: string): MockElement | null {
  const segments = selector.trim().split(/\s+/);
  const head = segments[0];
  if (!head) return null;
  if (segments.length === 1) {
    for (const child of root.children) {
      if (matchesSelector(child, head)) return child;
      const found = findQuerySelector(child, selector);
      if (found) return found;
    }
    return null;
  }
  const first = findQuerySelector(root, head);
  if (!first) return null;
  return findQuerySelector(first, segments.slice(1).join(' '));
}

function findQuerySelectorAll(root: MockElement, selector: string): MockElement[] {
  const segments = selector.trim().split(/\s+/);
  const head = segments[0];
  if (!head) return [];
  if (segments.length === 1) {
    const matches: MockElement[] = [];
    for (const child of root.children) {
      if (matchesSelector(child, head)) matches.push(child);
      matches.push(...findQuerySelectorAll(child, selector));
    }
    return matches;
  }
  const firsts = findQuerySelectorAll(root, head);
  const rest = segments.slice(1).join(' ');
  const results: MockElement[] = [];
  for (const f of firsts) {
    results.push(...findQuerySelectorAll(f, rest));
  }
  return results;
}

function createMockElement(id = '', tagName = 'div'): MockElement {
  let classes = new Set<string>();
  const attributes = new Map<string, string>();
  const listeners = new Map<string, ((e?: unknown) => void)[]>();
  const children: MockElement[] = [];
  const style: Record<string, string> = {};
  let _textContent = '';
  let _innerHTML = '';
  let _value = '';

  const el: MockElement = {
    id,
    tagName,
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(val: string) {
      classes = new Set(val.split(/\s+/).filter(Boolean));
    },
    get textContent() {
      if (_textContent) return _textContent;
      const childText = children.map((c) => c.textContent).join('');
      return childText || _innerHTML.replace(/<[^>]+>/g, '');
    },
    set textContent(val: string) {
      _textContent = val;
    },
    get innerHTML() {
      return _innerHTML;
    },
    set innerHTML(val: string) {
      _innerHTML = val;
    },
    get value() {
      return _value;
    },
    set value(val: string) {
      _value = val;
      for (const child of children) {
        if (child.tagName.toLowerCase() === 'option') {
          child.selected = child.value === val;
        }
      }
    },
    disabled: false,
    title: '',
    style,
    children,
    parentElement: null,
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
    appendChild: (child: MockElement) => {
      child.parentElement = el;
      children.push(child);
      return child;
    },
    insertBefore: (newChild: MockElement, refChild: MockElement | null) => {
      newChild.parentElement = el;
      const idx = refChild ? children.indexOf(refChild) : -1;
      if (idx >= 0) {
        children.splice(idx, 0, newChild);
      } else {
        children.push(newChild);
      }
      return newChild;
    },
    remove: () => {
      if (el.parentElement) {
        const idx = el.parentElement.children.indexOf(el);
        if (idx >= 0) el.parentElement.children.splice(idx, 1);
        el.parentElement = null;
      }
    },
    querySelector: (sel: string) => findQuerySelector(el, sel),
    querySelectorAll: (sel: string) => findQuerySelectorAll(el, sel),
    addEventListener: (event: string, fn: (e?: unknown) => void) => {
      const list = listeners.get(event) || [];
      list.push(fn);
      listeners.set(event, list);
    },
    dispatchEvent: (event: { type: string; preventDefault?: () => void }) => {
      const list = listeners.get(event.type) || [];
      for (const fn of list) fn(event);
    },
    click: () => {
      el.dispatchEvent({ type: 'click' });
    },
  };

  return el;
}

describe('LIVE-UI: Popup Live Stream Controls', () => {
  const elements = new Map<string, MockElement>();

  beforeEach(() => {
    elements.clear();

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
      'dock-view-all',
      'media-count',
      'media-list',
      'empty-state',
      'tasks-summary-dock',
      'dock-task-count',
      'dock-task-speed',
      'dock-progress-fill',
    ];

    for (const id of ids) {
      elements.set(id, createMockElement(id));
    }

    const dock = elements.get('tasks-summary-dock')!;
    const dockHeader = createMockElement('', 'div');
    dockHeader.className = 'dock-header';
    dock.appendChild(dockHeader);
    const viewAll = elements.get('dock-view-all')!;
    dockHeader.appendChild(viewAll);

    const mockDocument = {
      getElementById: (id: string) => elements.get(id) || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: (tag: string) => createMockElement('', tag),
      addEventListener: () => {},
    };

    (globalThis as unknown as { document: unknown }).document = mockDocument;
    setupChromeMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders live stream badge and interactive mode segmented control with DVR Window default', () => {
    const controller = new PopupController();
    const liveItem: MediaItem = {
      id: 'live_hls_test_1',
      tabId: 10,
      kind: 'hls',
      url: 'https://example.com/live/index.m3u8',
      title: 'Breaking News Live Broadcast',
      pageUrl: 'https://example.com/news',
      qualities: [{ id: 'q0', label: '1080p', ref: 'https://example.com/live/1080.m3u8' }],
      audioTracks: [],
      subtitles: [],
      source: 'network',
      hasVideo: true,
      hasAudio: true,
      isLive: true,
      detectedAt: Date.now(),
    };

    const card = (controller as unknown as { createMediaCard: (item: MediaItem) => HTMLElement }).createMediaCard(
      liveItem,
    );

    // Verify LIVE badge
    expect(card.querySelector('.badge-live')).not.toBeNull();
    expect(card.querySelector('.badge-live')?.textContent).toContain('LIVE');

    // Verify segmented mode control
    const modeControl = card.querySelector('.live-mode-control');
    expect(modeControl).not.toBeNull();
    const modeButtons = modeControl!.querySelectorAll('.segment-btn');
    expect(modeButtons.length).toBe(3);

    const dvrBtn = Array.from(modeButtons).find((b) => b.getAttribute('data-mode') === 'dvr');
    const durBtn = Array.from(modeButtons).find((b) => b.getAttribute('data-mode') === 'duration');
    const untilBtn = Array.from(modeButtons).find((b) => b.getAttribute('data-mode') === 'until_stopped');

    expect(dvrBtn?.classList.contains('active')).toBe(true);

    // Verify duration picker visibility toggling
    const durPicker = card.querySelector('.live-duration-picker');
    expect(durPicker?.classList.contains('hidden')).toBe(true);

    durBtn?.dispatchEvent({ type: 'click' } as unknown as Event);
    expect(durBtn?.classList.contains('active')).toBe(true);
    expect(dvrBtn?.classList.contains('active')).toBe(false);
    expect(durPicker?.classList.contains('hidden')).toBe(false);

    untilBtn?.dispatchEvent({ type: 'click' } as unknown as Event);
    expect(untilBtn?.classList.contains('active')).toBe(true);
    expect(durPicker?.classList.contains('hidden')).toBe(true);
  });

  it('dispatches StartDownloadParams with selected liveMode and duration when user clicks record', async () => {
    const controller = new PopupController();
    const liveItem: MediaItem = {
      id: 'live_hls_test_2',
      tabId: 10,
      kind: 'hls',
      url: 'https://example.com/live/index.m3u8',
      title: 'Space Launch Live',
      pageUrl: 'https://example.com/launch',
      qualities: [{ id: 'q0', label: '720p', ref: 'https://example.com/live/720.m3u8' }],
      audioTracks: [],
      subtitles: [],
      source: 'network',
      hasVideo: true,
      hasAudio: true,
      isLive: true,
      detectedAt: Date.now(),
    };

    let sentMessage: { type: string; params: StartDownloadParams } | undefined;
    vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation(async (msg: unknown) => {
      const typed = msg as { type: string; params: StartDownloadParams };
      if (typed.type === 'startDownload') {
        sentMessage = typed;
        return { ok: true, data: { taskId: 'task_live_123' } };
      }
      return { ok: true };
    });

    const card = (controller as unknown as { createMediaCard: (item: MediaItem) => HTMLElement }).createMediaCard(
      liveItem,
    );

    // Select fixed duration mode and pick 30 minutes (1800s)
    const durBtn = card.querySelector('.live-mode-control [data-mode="duration"]') as unknown as MockElement;
    durBtn.click();

    const selectDuration = card.querySelector('.select-duration') as unknown as MockElement;
    selectDuration.value = '1800';
    selectDuration.dispatchEvent({ type: 'change' } as unknown as Event);

    // Click Record button
    const btnDownload = card.querySelector('.btn-primary') as unknown as MockElement;
    expect(btnDownload.textContent).toContain('Record Live Stream');
    btnDownload.click();

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sentMessage).toBeDefined();
    expect(sentMessage?.type).toBe('startDownload');
    expect(sentMessage?.params.itemId).toBe('live_hls_test_2');
    expect(sentMessage?.params.liveMode).toBe('duration');
    expect(sentMessage?.params.liveDurationSeconds).toBe(1800);
  });

  it('renders Stop & Save button for an active live task in card and dispatches stop action', async () => {
    const controller = new PopupController();
    const liveItem: MediaItem = {
      id: 'live_stream_running_1',
      tabId: 10,
      kind: 'hls',
      url: 'https://example.com/live/game.m3u8',
      title: 'Championship Live Match',
      pageUrl: 'https://example.com/sports',
      qualities: [{ id: 'q0', label: '1080p', ref: 'https://example.com/live/1080.m3u8' }],
      audioTracks: [],
      subtitles: [],
      source: 'network',
      hasVideo: true,
      hasAudio: true,
      isLive: true,
      detectedAt: Date.now(),
    };

    // Set active live task in controller state
    (controller as unknown as { state: unknown }).state = {
      tabId: 10,
      tabTitle: 'Sports',
      tabUrl: 'https://example.com/sports',
      items: [liveItem],
      tasks: [
        {
          id: 'task_active_live_99',
          title: 'Championship Live Match',
          state: 'downloading',
          engine: 'native',
          kind: 'hls',
          sourceUrl: 'https://example.com/live/game.m3u8',
          pageUrl: 'https://example.com/sports',
          isLive: true,
          liveMode: 'until_stopped',
          progress: {
            percent: 45,
            bytesDownloaded: 50000000,
            bytesPerSec: 2000000,
            segmentsDone: 50,
            segmentsTotal: 0,
            elapsedMs: 30000,
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      settings: {},
      native: { connected: true },
      scanning: false,
    };

    let sentAction: { type: string; taskId: string; action: string } | undefined;
    vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation(async (msg: unknown) => {
      const typed = msg as { type: string; taskId: string; action: string };
      if (typed.type === 'taskAction') {
        sentAction = typed;
        return { ok: true };
      }
      return { ok: true };
    });

    const card = (controller as unknown as { createMediaCard: (item: MediaItem) => HTMLElement }).createMediaCard(
      liveItem,
    );

    // Verify Stop & Save button is rendered
    const btnStop = card.querySelector('.btn-stop') as unknown as MockElement;
    expect(btnStop).not.toBeNull();
    expect(btnStop.textContent).toBe('Stop & Save');

    // Click Stop & Save button
    btnStop.click();

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sentAction).toBeDefined();
    expect(sentAction?.type).toBe('taskAction');
    expect(sentAction?.taskId).toBe('task_active_live_99');
    expect(sentAction?.action).toBe('stop');
  });

  it('renders Stop & Save button in tasks summary dock for active live task and dispatches stop', async () => {
    const controller = new PopupController();
    (controller as unknown as { state: unknown }).state = {
      tabId: 10,
      tabTitle: 'Concert',
      tabUrl: 'https://example.com/live',
      items: [],
      tasks: [
        {
          id: 'task_live_dock_1',
          title: 'Live Concert',
          state: 'downloading',
          engine: 'native',
          kind: 'hls',
          sourceUrl: 'https://example.com/live/concert.m3u8',
          pageUrl: 'https://example.com/live',
          isLive: true,
          liveMode: 'dvr',
          progress: {
            percent: 20,
            bytesDownloaded: 20000000,
            bytesPerSec: 1500000,
            segmentsDone: 20,
            segmentsTotal: 0,
            elapsedMs: 15000,
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      settings: {},
      native: { connected: true },
      scanning: false,
    };

    let sentAction: { type: string; taskId: string; action: string } | undefined;
    vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation(async (msg: unknown) => {
      const typed = msg as { type: string; taskId: string; action: string };
      if (typed.type === 'taskAction') {
        sentAction = typed;
        return { ok: true };
      }
      return { ok: true };
    });

    (controller as unknown as { renderTasksDock: () => void }).renderTasksDock();

    const dock = elements.get('tasks-summary-dock')!;
    const dockStopBtn = dock.querySelector('.dock-stop-btn') as unknown as MockElement;
    expect(dockStopBtn).not.toBeNull();
    expect(dockStopBtn.textContent).toBe('Stop & Save');

    dockStopBtn.click();

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sentAction).toBeDefined();
    expect(sentAction?.type).toBe('taskAction');
    expect(sentAction?.taskId).toBe('task_live_dock_1');
    expect(sentAction?.action).toBe('stop');
  });
});
