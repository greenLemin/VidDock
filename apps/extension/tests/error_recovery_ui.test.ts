import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadTask, PopupState } from '@viddock/shared';
import { DashboardController, getHumanReadableErrorMessage } from '../src/dashboard/index.ts';
import { PopupController } from '../src/popup/index.ts';
import { setupChromeMock } from './mocks/chrome.ts';

interface MockElement {
  id?: string;
  tagName: string;
  className: string;
  textContent: string;
  title: string;
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
  appendChild: (child: MockElement) => MockElement;
  querySelector: (sel: string) => MockElement | null;
  querySelectorAll: (sel: string) => MockElement[];
  addEventListener: (event: string, fn: (e?: unknown) => void) => void;
  dispatchEvent: (event: { type: string; preventDefault?: () => void }) => void;
}

function createMockElement(id = '', tagName = 'div'): MockElement {
  let classes = new Set<string>();
  const attributes = new Map<string, string>();
  const listeners = new Map<string, ((e?: unknown) => void)[]>();
  const children: MockElement[] = [];
  const style: Record<string, string> = {};

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
    appendChild: (child: MockElement) => {
      children.push(child);
      return child;
    },
    querySelector: (sel: string): MockElement | null => {
      for (const child of children) {
        if (sel.startsWith('.') && child.classList.contains(sel.slice(1))) return child;
        if (sel.startsWith('#') && child.id === sel.slice(1)) return child;
        if (child.tagName.toLowerCase() === sel.toLowerCase()) return child;
        const nested = child.querySelector(sel);
        if (nested) return nested;
      }
      return null;
    },
    querySelectorAll: (sel: string): MockElement[] => {
      const matches: MockElement[] = [];
      for (const child of children) {
        if (sel.startsWith('.') && child.classList.contains(sel.slice(1))) matches.push(child);
        else if (sel.startsWith('#') && child.id === sel.slice(1)) matches.push(child);
        else if (child.tagName.toLowerCase() === sel.toLowerCase()) matches.push(child);
        matches.push(...child.querySelectorAll(sel));
      }
      return matches;
    },
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

describe('TASK-P1-04: Surface Structured Error Codes & Actionable Controls', () => {
  const elements = new Map<string, MockElement>();

  beforeEach(() => {
    elements.clear();
    setupChromeMock();

    const ids = [
      'tasks-summary-dock',
      'dock-task-count',
      'dock-task-speed',
      'dock-progress-fill',
      'dock-view-all',
      'media-list',
      'media-count',
      'empty-state',
      'btn-open-dashboard',
      'btn-open-settings',
      'btn-refresh-media',
      'btn-empty-rescan',
      'onboarding-modal',
      'btn-onboarding-dismiss',
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
  });

  describe('Human-Readable Error Code Messages', () => {
    it('maps NO_FFMPEG, HTTP_401, HTTP_403, SEGMENT_MISSING, and DISK_FULL cleanly', () => {
      expect(getHumanReadableErrorMessage('NO_FFMPEG')).toContain('FFmpeg is required');
      expect(getHumanReadableErrorMessage('HTTP_401')).toContain('Authentication required');
      expect(getHumanReadableErrorMessage('HTTP_403')).toContain('Access forbidden');
      expect(getHumanReadableErrorMessage('SEGMENT_MISSING')).toContain('Stream segment');
      expect(getHumanReadableErrorMessage('DISK_FULL')).toContain('Disk space is full');
      expect(getHumanReadableErrorMessage('UNKNOWN', 'Custom msg')).toBe('Custom msg');
    });
  });

  describe('Dashboard Contextual Error Action Buttons', () => {
    const baseTask: DownloadTask = {
      id: 'task_err_1',
      title: 'Faulty Stream',
      state: 'failed',
      engine: 'native',
      kind: 'hls',
      sourceUrl: 'https://example.com/master.m3u8',
      pageUrl: 'https://example.com/watch?v=123',
      progress: {
        bytesDownloaded: 0,
        bytesPerSec: 0,
        segmentsDone: 0,
        segmentsTotal: 10,
        percent: 0,
        elapsedMs: 5000,
      },
      createdAt: Date.now() - 5000,
      updatedAt: Date.now(),
    };

    it('renders Install FFmpeg button for NO_FFMPEG and navigates to companion help', () => {
      const dashboard = new DashboardController();
      const card = (dashboard as unknown as { createTaskCard: (t: DownloadTask) => MockElement }).createTaskCard({
        ...baseTask,
        errorCode: 'NO_FFMPEG',
      });

      const btn = card.querySelector('.btn-error-action');
      expect(btn).not.toBeNull();
      expect(btn?.textContent).toBe('Install FFmpeg');

      const tabsSpy = vi.spyOn(chrome.tabs, 'create');
      btn?.dispatchEvent({ type: 'click' });
      expect(tabsSpy).toHaveBeenCalledWith({
        url: expect.stringContaining('settings/index.html#companion-help-box'),
      });
      tabsSpy.mockRestore();
    });

    it('renders Reopen Page button for HTTP_401 / HTTP_403 and opens stream pageUrl', () => {
      const dashboard = new DashboardController();
      const card = (dashboard as unknown as { createTaskCard: (t: DownloadTask) => MockElement }).createTaskCard({
        ...baseTask,
        errorCode: 'HTTP_401',
      });

      const btn = card.querySelector('.btn-error-action');
      expect(btn).not.toBeNull();
      expect(btn?.textContent).toBe('Reopen Page to Refresh Session');

      const tabsSpy = vi.spyOn(chrome.tabs, 'create');
      btn?.dispatchEvent({ type: 'click' });
      expect(tabsSpy).toHaveBeenCalledWith({ url: 'https://example.com/watch?v=123' });
      tabsSpy.mockRestore();
    });

    it('renders Retry Download button for SEGMENT_MISSING and triggers retry action', () => {
      const dashboard = new DashboardController();
      const executeSpy = vi.spyOn(
        dashboard as unknown as { executeAction: (id: string, act: string) => void },
        'executeAction',
      );

      const card = (dashboard as unknown as { createTaskCard: (t: DownloadTask) => MockElement }).createTaskCard({
        ...baseTask,
        errorCode: 'SEGMENT_MISSING',
      });

      const btn = card.querySelector('.btn-error-action');
      expect(btn).not.toBeNull();
      expect(btn?.textContent).toBe('Retry Download');

      btn?.dispatchEvent({ type: 'click' });
      expect(executeSpy).toHaveBeenCalledWith('task_err_1', 'retry');
      executeSpy.mockRestore();
    });

    it('renders Clean Work Cache button for DISK_FULL and sends cacheClear', () => {
      const dashboard = new DashboardController();
      const sendSpy = vi.spyOn(chrome.runtime, 'sendMessage');

      const card = (dashboard as unknown as { createTaskCard: (t: DownloadTask) => MockElement }).createTaskCard({
        ...baseTask,
        errorCode: 'DISK_FULL',
      });

      const btn = card.querySelector('.btn-error-action');
      expect(btn).not.toBeNull();
      expect(btn?.textContent).toBe('Clean Work Cache');

      btn?.dispatchEvent({ type: 'click' });
      expect(sendSpy).toHaveBeenCalledWith({ type: 'cacheClear' });
      sendSpy.mockRestore();
    });
  });

  describe('Popup Tasks Dock Visibility for Queued and Failed Tasks', () => {
    it('remains visible with failed status badge when only failed tasks exist', () => {
      const controller = new PopupController();
      const mockState: Partial<PopupState> = {
        tasks: [
          {
            id: 'failed_1',
            title: 'Failed Video',
            state: 'failed',
            engine: 'native',
            kind: 'direct',
            sourceUrl: 'https://example.com/1.mp4',
            pageUrl: 'https://example.com',
            progress: {
              bytesDownloaded: 0,
              bytesPerSec: 0,
              segmentsDone: 0,
              segmentsTotal: 10,
              percent: 0,
              elapsedMs: 5000,
            },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      };

      (controller as unknown as { state: PopupState }).state = mockState as PopupState;
      (controller as unknown as { renderTasksDock: () => void }).renderTasksDock();

      const dock = elements.get('tasks-summary-dock')!;
      const countEl = elements.get('dock-task-count')!;
      const speedEl = elements.get('dock-task-speed')!;
      const fillEl = elements.get('dock-progress-fill')!;

      expect(dock.classList.contains('hidden')).toBe(false);
      expect(countEl.textContent).toContain('1 Failed Download');
      expect(speedEl.textContent).toBe('Action Required');
      expect(fillEl.classList.contains('failed')).toBe(true);
      expect(fillEl.style.width).toBe('100%');
    });

    it('remains visible with queued status badge when only queued tasks exist', () => {
      const controller = new PopupController();
      const mockState: Partial<PopupState> = {
        tasks: [
          {
            id: 'queued_1',
            title: 'Queued Video',
            state: 'queued',
            engine: 'native',
            kind: 'direct',
            sourceUrl: 'https://example.com/1.mp4',
            pageUrl: 'https://example.com',
            progress: {
              bytesDownloaded: 0,
              bytesPerSec: 0,
              segmentsDone: 0,
              segmentsTotal: 10,
              percent: 0,
              elapsedMs: 5000,
            },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      };

      (controller as unknown as { state: PopupState }).state = mockState as PopupState;
      (controller as unknown as { renderTasksDock: () => void }).renderTasksDock();

      const dock = elements.get('tasks-summary-dock')!;
      const countEl = elements.get('dock-task-count')!;
      const speedEl = elements.get('dock-task-speed')!;
      const fillEl = elements.get('dock-progress-fill')!;

      expect(dock.classList.contains('hidden')).toBe(false);
      expect(countEl.textContent).toContain('1 Queued Task');
      expect(speedEl.textContent).toBe('Queued');
      expect(fillEl.style.width).toBe('0%');
    });

    it('hides dock completely when tasks list is empty', () => {
      const controller = new PopupController();
      (controller as unknown as { state: PopupState }).state = { tasks: [] } as unknown as PopupState;
      (controller as unknown as { renderTasksDock: () => void }).renderTasksDock();

      const dock = elements.get('tasks-summary-dock')!;
      expect(dock.classList.contains('hidden')).toBe(true);
    });
  });
});
