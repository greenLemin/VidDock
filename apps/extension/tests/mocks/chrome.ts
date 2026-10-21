import type { HostRequest } from '@viddock/shared';

export interface MockPort {
  name: string;
  sender?: chrome.runtime.MessageSender;
  onMessage: {
    addListener: (fn: (msg: unknown) => void) => void;
    removeListener: (fn: (msg: unknown) => void) => void;
    listeners: ((msg: unknown) => void)[];
  };
  onDisconnect: {
    addListener: (fn: (port: MockPort) => void) => void;
    removeListener: (fn: (port: MockPort) => void) => void;
    listeners: ((port: MockPort) => void)[];
  };
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
  messagesSent: (HostRequest & { id: string })[];
  simulateReceive: (msg: unknown) => void;
  simulateDisconnect: (errMsg?: string) => void;
}

export class MockStorageArea {
  private data: Record<string, unknown> = {};

  async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    if (!keys) return { ...this.data };
    if (typeof keys === 'string') return { [keys]: this.data[keys] };
    if (Array.isArray(keys)) {
      const res: Record<string, unknown> = {};
      for (const k of keys) res[k] = this.data[k];
      return res;
    }
    const res: Record<string, unknown> = { ...keys };
    for (const k of Object.keys(keys)) {
      if (this.data[k] !== undefined) res[k] = this.data[k];
    }
    return res;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) {
      this.data[k] = v;
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      delete this.data[k];
    }
  }

  async clear(): Promise<void> {
    this.data = {};
  }
}

export function createMockPort(name = 'mock-port'): MockPort {
  const onMessageListeners: ((msg: unknown) => void)[] = [];
  const onDisconnectListeners: ((port: MockPort) => void)[] = [];
  const messagesSent: (HostRequest & { id: string })[] = [];

  const port: MockPort = {
    name,
    messagesSent,
    onMessage: {
      addListener: (fn) => onMessageListeners.push(fn),
      removeListener: (fn) => {
        const i = onMessageListeners.indexOf(fn);
        if (i >= 0) onMessageListeners.splice(i, 1);
      },
      listeners: onMessageListeners,
    },
    onDisconnect: {
      addListener: (fn) => onDisconnectListeners.push(fn),
      removeListener: (fn) => {
        const i = onDisconnectListeners.indexOf(fn);
        if (i >= 0) onDisconnectListeners.splice(i, 1);
      },
      listeners: onDisconnectListeners,
    },
    postMessage: (msg: unknown) => {
      messagesSent.push(msg as HostRequest & { id: string });
    },
    disconnect: () => {
      for (const fn of [...onDisconnectListeners]) fn(port);
    },
    simulateReceive: (msg: unknown) => {
      for (const fn of [...onMessageListeners]) fn(msg);
    },
    simulateDisconnect: (errMsg?: string) => {
      if (errMsg && typeof chrome !== 'undefined') {
        (chrome.runtime as unknown as { lastError: { message?: string } | undefined }).lastError = { message: errMsg };
      }
      for (const fn of [...onDisconnectListeners]) fn(port);
      if (typeof chrome !== 'undefined') {
        (chrome.runtime as unknown as { lastError: { message?: string } | undefined }).lastError = undefined;
      }
    },
  };

  return port;
}

export function setupChromeMock() {
  const localStorageArea = new MockStorageArea();
  const sessionStorageArea = new MockStorageArea();
  const badges = new Map<number, { text?: string; color?: string }>();
  const activeTabs: chrome.tabs.Tab[] = [
    {
      id: 1,
      index: 0,
      windowId: 1,
      highlighted: true,
      active: true,
      pinned: false,
      incognito: false,
      url: 'https://university.edu/mediasite/Play/1234567890abcdef1234567890abcdef1d',
      title: 'CS101 Lecture 03',
      selected: true,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
    },
  ];

  let nativePortInstance: MockPort | null = null;
  const messageListeners: ((
    msg: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (res: unknown) => void,
  ) => boolean | void)[] = [];
  const connectListeners: ((port: MockPort) => void)[] = [];
  const alarmListeners: ((alarm: chrome.alarms.Alarm) => void)[] = [];
  const tabUpdatedListeners: ((tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void)[] =
    [];
  const tabRemovedListeners: ((tabId: number) => void)[] = [];
  const tabActivatedListeners: ((activeInfo: chrome.tabs.TabActiveInfo) => void)[] = [];
  const webRequestBeforeListeners: ((details: chrome.webRequest.WebRequestBodyDetails) => void)[] = [];
  const webRequestHeadersListeners: ((details: chrome.webRequest.WebResponseHeadersDetails) => void)[] = [];

  const mockChrome = {
    runtime: {
      lastError: undefined as { message?: string } | undefined,
      getURL: (p: string) => `chrome-extension://viddock-extension/${p}`,
      connectNative: (_hostName: string) => {
        nativePortInstance = createMockPort('native-companion');
        return nativePortInstance;
      },
      connect: (options?: { name?: string }) => {
        const port = createMockPort(options?.name || 'ui-port');
        for (const listener of connectListeners) listener(port);
        return port;
      },
      onConnect: {
        addListener: (fn: (port: MockPort) => void) => connectListeners.push(fn),
      },
      sendMessage: async (msg: unknown) => {
        return new Promise((resolve) => {
          let answered = false;
          const sendResponse = (res: unknown) => {
            answered = true;
            resolve(res);
          };
          for (const listener of messageListeners) {
            const isAsync = listener(msg, { tab: activeTabs[0] }, sendResponse);
            if (isAsync && !answered) return;
          }
          if (!answered) resolve({ ok: true });
        });
      },
      onMessage: {
        addListener: (
          fn: (
            msg: unknown,
            sender: chrome.runtime.MessageSender,
            sendResponse: (res: unknown) => void,
          ) => boolean | void,
        ) => messageListeners.push(fn),
      },
      onInstalled: {
        addListener: (fn: (details: chrome.runtime.InstalledDetails) => void) =>
          fn({ reason: 'install' as chrome.runtime.OnInstalledReason }),
      },
      onStartup: {
        addListener: (_fn: () => void) => {},
      },
    },
    storage: {
      local: localStorageArea,
      session: sessionStorageArea,
    },
    tabs: {
      query: async (q?: chrome.tabs.QueryInfo) => {
        if (q?.active) return [activeTabs[0]!];
        return activeTabs;
      },
      get: async (tabId: number) => {
        const found = activeTabs.find((t) => t.id === tabId);
        if (!found) throw new Error(`Tab ${tabId} not found`);
        return found;
      },
      create: async (props: chrome.tabs.CreateProperties) => {
        const newTab = { id: activeTabs.length + 1, ...props } as chrome.tabs.Tab;
        activeTabs.push(newTab);
        return newTab;
      },
      onUpdated: {
        addListener: (fn: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void) =>
          tabUpdatedListeners.push(fn),
        dispatch: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
          for (const fn of tabUpdatedListeners) fn(tabId, changeInfo, tab);
        },
      },
      onRemoved: {
        addListener: (fn: (tabId: number) => void) => tabRemovedListeners.push(fn),
        dispatch: (tabId: number) => {
          for (const fn of tabRemovedListeners) fn(tabId);
        },
      },
      onActivated: {
        addListener: (fn: (activeInfo: chrome.tabs.TabActiveInfo) => void) => tabActivatedListeners.push(fn),
        dispatch: (info: chrome.tabs.TabActiveInfo) => {
          for (const fn of tabActivatedListeners) fn(info);
        },
      },
    },
    action: {
      setBadgeText: async (details: { tabId?: number; text: string }) => {
        const id = details.tabId ?? 1;
        const cur = badges.get(id) || {};
        badges.set(id, { ...cur, text: details.text });
      },
      setBadgeBackgroundColor: async (details: { tabId?: number; color: string }) => {
        const id = details.tabId ?? 1;
        const cur = badges.get(id) || {};
        badges.set(id, { ...cur, color: details.color });
      },
      getBadge: (tabId = 1) => badges.get(tabId),
    },
    alarms: {
      create: async (_name: string, _info?: chrome.alarms.AlarmCreateInfo) => {},
      clear: async (_name: string) => true,
      onAlarm: {
        addListener: (fn: (alarm: chrome.alarms.Alarm) => void) => alarmListeners.push(fn),
        dispatch: (alarm: chrome.alarms.Alarm) => {
          for (const fn of alarmListeners) fn(alarm);
        },
      },
    },
    cookies: {
      getAll: async (_details: chrome.cookies.GetAllDetails) => [
        { name: 'session_auth', value: 'token_xyz_123' } as chrome.cookies.Cookie,
      ],
    },
    notifications: {
      create: async (_id: string, _options: chrome.notifications.NotificationOptions) => 'viddock_notif_1',
      clear: async (_id: string) => true,
    },
    downloads: {
      download: async (_opts: chrome.downloads.DownloadOptions) => 101,
      pause: async (_id: number) => {},
      resume: async (_id: number) => {},
      cancel: async (_id: number) => {},
      open: (_id: number) => {},
      show: (_id: number) => {},
      erase: async (_query: chrome.downloads.DownloadQuery) => [101],
      onChanged: {
        addListener: (_fn: (delta: chrome.downloads.DownloadDelta) => void) => {},
      },
    },
    webRequest: {
      onBeforeRequest: {
        addListener: (fn: (details: chrome.webRequest.WebRequestBodyDetails) => void) =>
          webRequestBeforeListeners.push(fn),
        dispatch: (details: chrome.webRequest.WebRequestBodyDetails) => {
          for (const fn of webRequestBeforeListeners) fn(details);
        },
      },
      onHeadersReceived: {
        addListener: (fn: (details: chrome.webRequest.WebResponseHeadersDetails) => void) =>
          webRequestHeadersListeners.push(fn),
        dispatch: (details: chrome.webRequest.WebResponseHeadersDetails) => {
          for (const fn of webRequestHeadersListeners) fn(details);
        },
      },
    },
    scripting: {
      executeScript: async (_details: chrome.scripting.ScriptInjection<unknown[], unknown>) => [],
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = mockChrome;

  return {
    mockChrome,
    localStorage: localStorageArea,
    sessionStorage: sessionStorageArea,
    getNativePort: () => nativePortInstance,
    activeTabs,
  };
}
