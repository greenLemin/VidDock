import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaItem } from '@viddock/shared';
import { TabMediaStore } from '../src/background/media_store.ts';
import { setupChromeMock } from './mocks/chrome.ts';

describe('TabMediaStore Deduplication & Badge Sync Tests', () => {
  let store: TabMediaStore;
  let mockEnv: ReturnType<typeof setupChromeMock>;

  beforeEach(() => {
    mockEnv = setupChromeMock();
    store = new TabMediaStore();
  });

  it('adds new media items to a tab and updates badge', async () => {
    const item1: MediaItem = {
      id: 'm1',
      tabId: 1,
      kind: 'hls',
      url: 'https://cdn.example.com/master.m3u8',
      title: 'Lecture 1',
      pageUrl: 'https://university.edu/course/1',
      qualities: [{ id: 'q1', label: '1080p', ref: 'https://cdn.example.com/1080.m3u8' }],
      audioTracks: [],
      subtitles: [],
      source: 'network',
      hasVideo: true,
      hasAudio: true,
      detectedAt: Date.now(),
    };

    const added = await store.addMediaItem(item1);
    expect(added).toBe(true);

    const items = await store.getTabMedia(1);
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe('m1');

    const badge = mockEnv.mockChrome.action.getBadge(1);
    expect(badge?.text).toBe('1');
    expect(badge?.color).toBe('#0071E3'); // Apple System Blue
  });

  it('deduplicates items with the same URL and merges enriched qualities', async () => {
    const initialItem: MediaItem = {
      id: 'm1',
      tabId: 1,
      kind: 'hls',
      url: 'https://cdn.example.com/video.m3u8',
      title: 'Unknown Video',
      pageUrl: 'https://university.edu/course/1',
      qualities: [{ id: 'q0', label: 'Default', ref: 'https://cdn.example.com/video.m3u8' }],
      audioTracks: [],
      subtitles: [],
      source: 'network',
      hasVideo: true,
      hasAudio: true,
      detectedAt: Date.now(),
    };

    await store.addMediaItem(initialItem);

    // Second report enriched with real title, duration, and full qualities
    const enrichedItem: MediaItem = {
      id: 'm2',
      tabId: 1,
      kind: 'hls',
      url: 'https://cdn.example.com/video.m3u8',
      title: 'Calculus III Chapter 2',
      pageUrl: 'https://university.edu/course/1',
      durationSec: 3600,
      qualities: [
        { id: 'q1', label: '1080p', ref: 'https://cdn.example.com/1080.m3u8' },
        { id: 'q2', label: '720p', ref: 'https://cdn.example.com/720.m3u8' },
      ],
      audioTracks: [],
      subtitles: [],
      source: 'network',
      hasVideo: true,
      hasAudio: true,
      detectedAt: Date.now(),
    };

    const addedSecond = await store.addMediaItem(enrichedItem);
    expect(addedSecond).toBe(false); // Should be merged, not duplicated

    const items = await store.getTabMedia(1);
    expect(items.length).toBe(1);
    expect(items[0]?.title).toBe('Calculus III Chapter 2');
    expect(items[0]?.durationSec).toBe(3600);
    expect(items[0]?.qualities.length).toBe(2);
  });

  it('finds items across tabs using getItemById', async () => {
    const itemA: MediaItem = {
      id: 'item_tab_1',
      tabId: 1,
      kind: 'direct',
      url: 'https://cdn.example.com/vid1.mp4',
      title: 'Video 1',
      pageUrl: 'https://site.com',
      qualities: [],
      audioTracks: [],
      subtitles: [],
      source: 'network',
      hasVideo: true,
      hasAudio: true,
      detectedAt: Date.now(),
    };

    const itemB: MediaItem = {
      id: 'item_tab_2',
      tabId: 2,
      kind: 'dash',
      url: 'https://cdn.example.com/dash.mpd',
      title: 'Video 2',
      pageUrl: 'https://site.com',
      qualities: [],
      audioTracks: [],
      subtitles: [],
      source: 'network',
      hasVideo: true,
      hasAudio: true,
      detectedAt: Date.now(),
    };

    await store.addMediaItem(itemA);
    await store.addMediaItem(itemB);

    const found1 = await store.getItemById('item_tab_1');
    expect(found1).toBeDefined();
    expect(found1?.url).toBe('https://cdn.example.com/vid1.mp4');

    const found2 = await store.getItemById('item_tab_2');
    expect(found2).toBeDefined();
    expect(found2?.url).toBe('https://cdn.example.com/dash.mpd');

    const notFound = await store.getItemById('non_existent');
    expect(notFound).toBeUndefined();
  });

  it('sets green badge when active download tasks are present', async () => {
    await store.updateTabBadge(1, 3); // 3 active tasks
    const badge = mockEnv.mockChrome.action.getBadge(1);
    expect(badge?.text).toBe('3');
    expect(badge?.color).toBe('#34C759'); // Apple System Green
  });

  it('clears media and badge on tab removal', async () => {
    const item: MediaItem = {
      id: 'm1',
      tabId: 5,
      kind: 'direct',
      url: 'https://example.com/clip.mp4',
      title: 'Clip',
      pageUrl: 'https://example.com',
      qualities: [],
      audioTracks: [],
      subtitles: [],
      source: 'network',
      hasVideo: true,
      hasAudio: true,
      detectedAt: Date.now(),
    };

    await store.addMediaItem(item);
    expect((await store.getTabMedia(5)).length).toBe(1);

    await store.clearTabMedia(5);
    expect((await store.getTabMedia(5)).length).toBe(0);

    const badge = mockEnv.mockChrome.action.getBadge(5);
    expect(badge?.text).toBe('');
  });
});
