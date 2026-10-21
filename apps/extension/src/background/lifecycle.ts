import { DEFAULT_SETTINGS, isActive } from '@viddock/shared';
import { nativeClient } from './native_client.ts';
import { taskCoordinator } from './task_coordinator.ts';

export const lifecycle = {
  onInstalled: async (_details: chrome.runtime.InstalledDetails): Promise<void> => {
    try {
      const stored = await chrome.storage.local.get('settings');
      if (!stored.settings) {
        await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
      }
    } catch {}

    // Setup periodic watchdog alarm (every 30 seconds)
    try {
      await chrome.alarms.create('viddock-watchdog', { periodInMinutes: 0.5 });
    } catch {}
  },

  onStartup: async (): Promise<void> => {
    nativeClient.connect();
    await taskCoordinator.init();
  },

  onAlarm: async (alarm: chrome.alarms.Alarm): Promise<void> => {
    if (alarm.name !== 'viddock-watchdog') return;

    await taskCoordinator.init();
    const activeTasks = taskCoordinator.getTasks().filter((t) => isActive(t.state));

    if (activeTasks.length > 0) {
      const status = nativeClient.getStatus();
      if (!status.connected) {
        nativeClient.connect();
      }
    }

    // Prune orphaned session storage tab media
    try {
      const allSession = await chrome.storage.session.get(null);
      const openTabs = await chrome.tabs.query({});
      const openTabIds = new Set(openTabs.map((t) => t.id).filter((id): id is number => id !== undefined));

      const keysToRemove: string[] = [];
      for (const key of Object.keys(allSession)) {
        if (key.startsWith('media_tab_')) {
          const tabId = parseInt(key.replace('media_tab_', ''), 10);
          if (!openTabIds.has(tabId)) {
            keysToRemove.push(key);
          }
        }
      }
      if (keysToRemove.length > 0) {
        await chrome.storage.session.remove(keysToRemove);
      }
    } catch {}
  },
};
