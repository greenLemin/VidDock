import { beforeEach, describe, expect, it } from 'vitest';
import { lifecycle } from '../src/background/lifecycle.ts';
import { PopupController } from '../src/popup/index.ts';
import { setupChromeMock } from './mocks/chrome.ts';

interface MockElement {
  id?: string;
  tagName: string;
  className: string;
  textContent: string;
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

describe('First-Run Onboarding Modal Workflow', () => {
  const elements = new Map<string, MockElement>();

  beforeEach(() => {
    elements.clear();
    setupChromeMock();

    const ids = [
      'onboarding-modal',
      'btn-onboarding-dismiss',
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
      const el = createMockElement(id);
      if (id === 'onboarding-modal') {
        el.classList.add('hidden');
      }
      elements.set(id, el);
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

  it('initializes hasSeenOnboarding: false on first install', async () => {
    await lifecycle.onInstalled({
      reason: 'install',
    } as chrome.runtime.InstalledDetails);

    const stored = await chrome.storage.local.get('hasSeenOnboarding');
    expect(stored.hasSeenOnboarding).toBe(false);
  });

  it('renders onboarding modal on first install and dismisses on Get Started', async () => {
    await chrome.storage.local.set({ hasSeenOnboarding: false });

    const controller = new PopupController();
    await controller.checkOnboarding();

    const modal = elements.get('onboarding-modal')!;
    const dismissBtn = elements.get('btn-onboarding-dismiss')!;

    // Modal should be visible
    expect(modal.classList.contains('hidden')).toBe(false);

    // User clicks "Get Started"
    dismissBtn.dispatchEvent({ type: 'click' });
    await Promise.resolve();

    // Modal should now be hidden
    expect(modal.classList.contains('hidden')).toBe(true);

    // Storage flag should be updated to true
    const stored = await chrome.storage.local.get('hasSeenOnboarding');
    expect(stored.hasSeenOnboarding).toBe(true);
  });

  it('suppresses onboarding modal on subsequent opens when already seen', async () => {
    await chrome.storage.local.set({ hasSeenOnboarding: true });

    const controller = new PopupController();
    await controller.checkOnboarding();

    const modal = elements.get('onboarding-modal')!;
    expect(modal.classList.contains('hidden')).toBe(true);
  });
});
