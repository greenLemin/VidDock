import { beforeEach, describe, expect, it } from 'vitest';
import { mediaStore } from '../src/background/media_store.ts';
import {
  CHUNK_OR_IGNORABLE,
  IS_AAC_SEGMENT,
  IS_DASH,
  IS_DIRECT,
  IS_HLS,
  IS_MEDIASITE_OPTIONS,
  IS_SMOOTH,
  MediaSniffer,
} from '../src/background/sniffer.ts';
import { setupChromeMock } from './mocks/chrome.ts';

describe('MediaSniffer Network & URL Filter Tests', () => {
  beforeEach(() => {
    setupChromeMock();
  });

  it('matches HLS master and media playlists with or without query strings', () => {
    expect(IS_HLS.test('https://cdn.example.com/live/master.m3u8')).toBe(true);
    expect(IS_HLS.test('https://cdn.example.com/video/playlist.m3u8?token=xyz123')).toBe(true);
    expect(IS_HLS.test('https://cdn.example.com/video/index.M3U8#track1')).toBe(true);
    expect(IS_HLS.test('https://cdn.example.com/video/stream.mp4')).toBe(false);
  });

  it('matches MPEG-DASH manifest URLs with query strings', () => {
    expect(IS_DASH.test('https://dash.example.com/manifest.mpd')).toBe(true);
    expect(IS_DASH.test('https://dash.example.com/stream.mpd?auth=abc')).toBe(true);
    expect(IS_DASH.test('https://dash.example.com/stream.m4s')).toBe(false);
  });

  it('matches Smooth Streaming manifest URLs and derives HLS', () => {
    expect(IS_SMOOTH.test('https://mediasite.edu/video.ism/manifest')).toBe(true);
    expect(IS_SMOOTH.test('https://mediasite.edu/video.ism/Manifest(format=m3u8-aapl)')).toBe(true);
  });

  it('discards media chunks, segments, and webpage static assets', () => {
    expect(CHUNK_OR_IGNORABLE.test('https://cdn.example.com/seg-105.ts')).toBe(true);
    expect(CHUNK_OR_IGNORABLE.test('https://cdn.example.com/chunk_video_1.m4s')).toBe(true);
    expect(CHUNK_OR_IGNORABLE.test('https://cdn.example.com/styles/app.css')).toBe(true);
    expect(CHUNK_OR_IGNORABLE.test('https://cdn.example.com/bundle.js?v=2')).toBe(true);

    expect(CHUNK_OR_IGNORABLE.test('https://cdn.example.com/video.m3u8')).toBe(false);
    expect(CHUNK_OR_IGNORABLE.test('https://cdn.example.com/stream.mpd')).toBe(false);
    expect(CHUNK_OR_IGNORABLE.test('https://cdn.example.com/movie.mp4')).toBe(false);
  });

  it('detects Mediasite options API endpoints', () => {
    expect(IS_MEDIASITE_OPTIONS.test('https://mediasite.org/Mediasite/PlayerService.svc/json/GetPlayerOptions')).toBe(
      true,
    );
    expect(IS_MEDIASITE_OPTIONS.test('https://lecture.edu/api/v1/player/options?id=9928')).toBe(true);
    expect(IS_MEDIASITE_OPTIONS.test('https://lecture.edu/playeroptions.json')).toBe(true);
  });

  it('filters out direct media under 256KB via onHeadersReceived', async () => {
    const sniffer = new MediaSniffer();
    await mediaStore.clearTabMedia(1);

    // Small beacon: 45KB (should be ignored)
    sniffer.onHeadersReceived({
      tabId: 1,
      url: 'https://example.com/sound_blip.mp4',
      responseHeaders: [
        { name: 'Content-Type', value: 'video/mp4' },
        { name: 'Content-Length', value: '45000' },
      ],
    } as unknown as chrome.webRequest.WebResponseHeadersDetails);

    // Large video: 15MB (should be accepted)
    sniffer.onHeadersReceived({
      tabId: 1,
      url: 'https://example.com/full_video.mp4',
      responseHeaders: [
        { name: 'Content-Type', value: 'video/mp4' },
        { name: 'Content-Length', value: '15728640' },
      ],
    } as unknown as chrome.webRequest.WebResponseHeadersDetails);

    // Allow async processMediaUrl microtask to complete
    await new Promise((r) => setTimeout(r, 50));

    const items = await mediaStore.getTabMedia(1);
    expect(items.some((i) => i.url.includes('sound_blip.mp4'))).toBe(false);
    expect(items.some((i) => i.url.includes('full_video.mp4'))).toBe(true);
  });

  it('detects standalone .aac audio files while distinguishing them from ignorable chunks', async () => {
    const sniffer = new MediaSniffer();
    await mediaStore.clearTabMedia(1);

    const aacUrl = 'https://example.com/audio/podcast_episode_12.aac?token=xyz';
    expect(CHUNK_OR_IGNORABLE.test(aacUrl)).toBe(false);
    expect(IS_AAC_SEGMENT.test(aacUrl)).toBe(false);
    expect(IS_DIRECT.test(aacUrl)).toBe(true);

    sniffer.onBeforeRequest({
      tabId: 1,
      url: aacUrl,
    } as unknown as chrome.webRequest.WebRequestBodyDetails);

    await new Promise((r) => setTimeout(r, 50));

    const items = await mediaStore.getTabMedia(1);
    expect(items.some((i) => i.url === aacUrl)).toBe(true);
    const item = items.find((i) => i.url === aacUrl);
    expect(item?.kind).toBe('direct');
  });

  it('filters out HLS and DASH AAC stream chunks and segments via IS_AAC_SEGMENT', async () => {
    const sniffer = new MediaSniffer();
    await mediaStore.clearTabMedia(1);

    const segmentUrls = [
      'https://cdn.example.com/stream/audio-seg-001.aac',
      'https://cdn.example.com/stream/audio_segment_42.aac?auth=1',
      'https://cdn.example.com/stream/chunk-12.aac#t=10',
      'https://cdn.example.com/stream/frag-5.aac',
      'https://cdn.example.com/stream/track_part_008.aac',
    ];

    for (const segUrl of segmentUrls) {
      expect(IS_AAC_SEGMENT.test(segUrl)).toBe(true);
      sniffer.onBeforeRequest({
        tabId: 1,
        url: segUrl,
      } as unknown as chrome.webRequest.WebRequestBodyDetails);
    }

    await new Promise((r) => setTimeout(r, 50));

    const items = await mediaStore.getTabMedia(1);
    expect(items.length).toBe(0);
  });

  it('disambiguates mixed batch of audio URLs with case insensitivity and query parameters', () => {
    expect(IS_DIRECT.test('https://example.com/AUDIO_SAMPLE.AAC')).toBe(true);
    expect(IS_AAC_SEGMENT.test('https://example.com/AUDIO_SAMPLE.AAC')).toBe(false);
    expect(CHUNK_OR_IGNORABLE.test('https://example.com/AUDIO_SAMPLE.AAC')).toBe(false);

    expect(IS_AAC_SEGMENT.test('https://example.com/STREAM_SEG-99.AAC?query=1')).toBe(true);
    expect(IS_AAC_SEGMENT.test('https://example.com/CHUNK-001.aac')).toBe(true);
  });
});
