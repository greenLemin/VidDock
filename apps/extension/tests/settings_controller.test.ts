import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeStatus } from '@viddock/shared';
import { SettingsController } from '../src/settings/index.ts';
import { setupChromeMock } from './mocks/chrome.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface MockElement {
  id?: string;
  tagName: string;
  className: string;
  textContent: string;
  value: string;
  checked: boolean;
  disabled: boolean;
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
  addEventListener: (event: string, fn: (e?: unknown) => void) => void;
  dispatchEvent: (event: { type: string }) => void;
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
    value: '',
    checked: false,
    disabled: false,
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
    addEventListener: (event: string, fn: (e?: unknown) => void) => {
      const list = listeners.get(event) || [];
      list.push(fn);
      listeners.set(event, list);
    },
    dispatchEvent: (event: { type: string }) => {
      const list = listeners.get(event.type) || [];
      for (const fn of list) fn(event);
    },
  };

  return el;
}

describe('Settings Controller & Diagnostics Tests', () => {
  const elements = new Map<string, MockElement>();
  let mockClipboardText = '';

  beforeEach(() => {
    elements.clear();
    mockClipboardText = '';

    const ids = [
      'companion-badge',
      'companion-status-text',
      'diag-host-version',
      'diag-output-dir',
      'diag-ffmpeg',
      'diag-ffprobe',
      'companion-help-box',
      'companion-platform-text',
      'ffmpeg-warning-banner',
      'diag-extension-id',
      'companion-help-ext-id',
      'companion-install-cmd',
      'btn-copy-extension-id',
      'btn-open-dashboard',
      'pref-quality',
      'pref-container',
      'pref-concurrency',
      'concurrency-val',
      'pref-direct-chrome',
      'pref-notifications',
      'filename-template-input',
      'btn-test-companion',
      'template-preview-text',
    ];

    for (const id of ids) {
      elements.set(id, createMockElement(id));
    }

    const mockDocument = {
      getElementById: (id: string) => elements.get(id) || null,
      querySelectorAll: (sel: string) => {
        if (sel.includes('segment-btn')) return [];
        if (sel.includes('token-chip')) return [];
        return [];
      },
      querySelector: () => null,
      addEventListener: () => {},
    };

    (globalThis as unknown as { document: unknown }).document = mockDocument;
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          clipboard: {
            writeText: vi.fn(async (text: string) => {
              mockClipboardText = text;
            }),
          },
        },
        configurable: true,
        writable: true,
      });
    } catch {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        value: {
          writeText: vi.fn(async (text: string) => {
            mockClipboardText = text;
          }),
        },
        configurable: true,
        writable: true,
      });
    }

    setupChromeMock();
    (chrome.runtime as unknown as { id: string }).id = 'abcdefghijklmnopabcdefghijklmnop';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders FFmpeg missing warning badge and banner when host is connected without FFmpeg', () => {
    const controller = new SettingsController();
    const statusWithoutFfmpeg: NativeStatus = {
      connected: true,
      version: '1.0.0',
      platform: 'darwin',
      defaultOutputDir: '/Users/test/Downloads',
      ffmpeg: undefined,
      ffprobe: undefined,
    };

    controller.renderNativeStatus(statusWithoutFfmpeg);

    const badge = elements.get('companion-badge')!;
    const statusText = elements.get('companion-status-text')!;
    const ffmpegWarning = elements.get('ffmpeg-warning-banner')!;
    const ffmpegDiag = elements.get('diag-ffmpeg')!;
    const ffprobeDiag = elements.get('diag-ffprobe')!;

    expect(badge.classList.contains('status-warning')).toBe(true);
    expect(statusText.textContent).toBe('FFmpeg Missing - Remuxing Disabled');
    expect(ffmpegWarning.classList.contains('hidden')).toBe(false);
    expect(ffmpegDiag.textContent).toBe('Not found');
    expect(ffprobeDiag.textContent).toBe('Not found');
  });

  it('renders Connected badge and hides warning banner when FFmpeg and ffprobe are present', () => {
    const controller = new SettingsController();
    const statusWithFfmpeg: NativeStatus = {
      connected: true,
      version: '1.0.0',
      platform: 'darwin',
      defaultOutputDir: '/Users/test/Downloads',
      ffmpeg: '/opt/homebrew/bin/ffmpeg (version 8.1)',
      ffprobe: '/opt/homebrew/bin/ffprobe (version 8.1)',
    };

    controller.renderNativeStatus(statusWithFfmpeg);

    const badge = elements.get('companion-badge')!;
    const statusText = elements.get('companion-status-text')!;
    const ffmpegWarning = elements.get('ffmpeg-warning-banner')!;

    expect(badge.classList.contains('status-connected')).toBe(true);
    expect(statusText.textContent).toBe('Connected');
    expect(ffmpegWarning.classList.contains('hidden')).toBe(true);
  });

  it('populates Extension ID in diagnostics and provides 1-click clipboard copy', async () => {
    const controller = new SettingsController();
    controller.renderExtensionId();

    const idEl = elements.get('diag-extension-id')!;
    const helpIdEl = elements.get('companion-help-ext-id')!;
    const cmdEl = elements.get('companion-install-cmd')!;
    const copyBtn = elements.get('btn-copy-extension-id')!;

    expect(idEl.textContent).toBe('abcdefghijklmnopabcdefghijklmnop');
    expect(helpIdEl.textContent).toBe('abcdefghijklmnopabcdefghijklmnop');
    expect(cmdEl.textContent).toBe('./scripts/install-macos.sh abcdefghijklmnopabcdefghijklmnop');

    // Simulate clicking Copy ID button
    copyBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockClipboardText).toBe('abcdefghijklmnopabcdefghijklmnop');
    expect(copyBtn.textContent).toBe('Copied!');
  });

  it('verifies apps/extension/src/settings/index.html contains zero hardcoded developer paths and includes required elements', () => {
    const htmlPath = path.resolve(__dirname, '../src/settings/index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    // TASK-P0-03 check: Zero occurrences of developer path
    expect(htmlContent).not.toContain('/Users/jake');
    expect(htmlContent).not.toContain('Users/jake/Desktop');

    // TASK-P0-01 check: Extension ID elements
    expect(htmlContent).toContain('diag-extension-id');
    expect(htmlContent).toContain('btn-copy-extension-id');

    // TASK-P0-04 check: Warning banner
    expect(htmlContent).toContain('ffmpeg-warning-banner');
  });
});
