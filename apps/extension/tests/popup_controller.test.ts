import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeStatus } from '@viddock/shared';
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
  addEventListener: (event: string, fn: (e?: unknown) => void) => void;
  dispatchEvent: (event: { type: string; preventDefault?: () => void }) => void;
}

function createMockElement(id = '', tagName = 'div'): MockElement {
  let classes = new Set<string>();
  const attributes = new Map<string, string>();
  const listeners = new Map<string, ((e?: unknown) => void)[]>();

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
    addEventListener: (event: string, fn: (e?: unknown) => void) => {
      const list = listeners.get(event) || [];
      list.push(fn);
      listeners.set(event, list);
    },
    dispatchEvent: (event: { type: string; preventDefault?: () => void }) => {
      const list = listeners.get(event.type) || [];
      for (const fn of list) fn(event);
    },
  };

  return el;
}

describe('Popup Controller & Host Warning Tests', () => {
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
});
