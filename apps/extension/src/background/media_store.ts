import type { MediaItem } from '@viddock/shared';

export class TabMediaStore {
  private memoryCache = new Map<number, Map<string, MediaItem>>();

  /** Retrieves all detected media items for a specific tab. */
  async getTabMedia(tabId: number): Promise<MediaItem[]> {
    if (this.memoryCache.has(tabId)) {
      return Array.from(this.memoryCache.get(tabId)!.values());
    }

    try {
      const key = `media_tab_${tabId}`;
      const res = await chrome.storage.session.get(key);
      const items: MediaItem[] = res[key] || [];
      const itemMap = new Map<string, MediaItem>();
      for (const item of items) {
        itemMap.set(item.url, item);
      }
      this.memoryCache.set(tabId, itemMap);
      return items;
    } catch {
      return [];
    }
  }

  /** Adds or updates a detected media item for a tab. */
  async addMediaItem(item: MediaItem): Promise<boolean> {
    const tabId = item.tabId;
    let tabItems = this.memoryCache.get(tabId);
    if (!tabItems) {
      await this.getTabMedia(tabId);
      tabItems = this.memoryCache.get(tabId) || new Map<string, MediaItem>();
      this.memoryCache.set(tabId, tabItems);
    }

    const existing = tabItems.get(item.url);
    if (existing) {
      // Merge qualities and update if new info discovered
      if (item.qualities.length > existing.qualities.length) {
        existing.qualities = item.qualities;
      }
      if (item.audioTracks.length > existing.audioTracks.length) {
        existing.audioTracks = item.audioTracks;
      }
      if (item.subtitles.length > existing.subtitles.length) {
        existing.subtitles = item.subtitles;
      }
      if (item.durationSec && !existing.durationSec) {
        existing.durationSec = item.durationSec;
      }
      if (item.title && existing.title === 'Unknown Video') {
        existing.title = item.title;
      }
      await this.persistTab(tabId);
      return false;
    }

    tabItems.set(item.url, item);
    await this.persistTab(tabId);
    await this.updateTabBadge(tabId);
    return true;
  }

  /** Clears media items for a closed or navigated tab. */
  async clearTabMedia(tabId: number): Promise<void> {
    this.memoryCache.delete(tabId);
    try {
      await chrome.storage.session.remove(`media_tab_${tabId}`);
      await chrome.action.setBadgeText({ tabId, text: '' });
    } catch {}
  }

  /** Searches for an item across all tabs by its unique id. */
  async getItemById(itemId: string): Promise<MediaItem | undefined> {
    // 1. Search memory cache
    for (const items of this.memoryCache.values()) {
      for (const item of items.values()) {
        if (item.id === itemId) return item;
      }
    }

    // 2. Search session storage
    try {
      const allSession = await chrome.storage.session.get(null);
      for (const [key, val] of Object.entries(allSession)) {
        if (key.startsWith('media_tab_') && Array.isArray(val)) {
          for (const item of val as MediaItem[]) {
            if (item.id === itemId) return item;
          }
        }
      }
    } catch {}

    return undefined;
  }

  /** Updates the extension action badge for a tab. */
  async updateTabBadge(tabId: number, activeTasksCount = 0): Promise<void> {
    try {
      const items = await this.getTabMedia(tabId);
      const count = items.length;

      if (activeTasksCount > 0) {
        await chrome.action.setBadgeText({ tabId, text: String(activeTasksCount) });
        await chrome.action.setBadgeBackgroundColor({ tabId, color: '#34C759' }); // Apple system green
      } else if (count > 0) {
        await chrome.action.setBadgeText({ tabId, text: String(count) });
        await chrome.action.setBadgeBackgroundColor({ tabId, color: '#0071E3' }); // Apple system blue
      } else {
        await chrome.action.setBadgeText({ tabId, text: '' });
      }
    } catch {}
  }

  private async persistTab(tabId: number): Promise<void> {
    const tabItems = this.memoryCache.get(tabId);
    if (!tabItems) return;
    try {
      const items = Array.from(tabItems.values());
      await chrome.storage.session.set({ [`media_tab_${tabId}`]: items });
    } catch {}
  }
}

export const mediaStore = new TabMediaStore();
