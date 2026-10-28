import type {
  ContentReport,
  DescribedMedia,
  DomMediaReport,
  MediaItem,
  MediaKind,
  MediasiteReport,
} from '@viddock/shared';
import {
  describeDash,
  describeHls,
  deriveHlsFromSmooth,
  isAudioUrlOrMime,
  kindFromMime,
  parsePlayerOptions,
  sanitizeFilename,
} from '@viddock/shared';
import { mediaStore } from './media_store.ts';
import { taskCoordinator } from './task_coordinator.ts';

// Ignore media segments, chunks, icons, telemetry
export const CHUNK_OR_IGNORABLE = /\.(ts|m4s|m4i|vtt|srt|key|png|jpg|jpeg|gif|svg|ico|css|js|woff|woff2)(\?|#|$)/i;
export const IS_AAC_SEGMENT = /[/_-](?:seg|segment|chunk|frag|part)[-_0-9]+.*\.aac(\?|#|$)/i;
export const IS_HLS = /\.m3u8(\?|#|$)/i;
export const IS_DASH = /\.mpd(\?|#|$)/i;
export const IS_SMOOTH = /\.ism\/manifest/i;
export const IS_DIRECT = /\.(mp4|m4v|webm|mov|mkv|mp3|m4a|aac)(\?|#|$)/i;
export const IS_MEDIASITE_OPTIONS =
  /(PlayerService\.svc\/json\/GetPlayerOptions|\/api\/v1\/player\/options|playeroptions)/i;

export class MediaSniffer {
  private processingUrls = new Set<string>();

  onTabUpdated = async (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, _tab: chrome.tabs.Tab): Promise<void> => {
    if (changeInfo.status === 'loading') {
      await mediaStore.clearTabMedia(tabId);
    }
  };

  onTabRemoved = async (tabId: number): Promise<void> => {
    await mediaStore.clearTabMedia(tabId);
  };

  onTabActivated = async (activeInfo: chrome.tabs.TabActiveInfo): Promise<void> => {
    await mediaStore.updateTabBadge(activeInfo.tabId);
  };

  onBeforeRequest = (details: chrome.webRequest.WebRequestBodyDetails): void => {
    if (details.tabId <= 0 || !details.url) return;
    const url = details.url;

    if (CHUNK_OR_IGNORABLE.test(url) || IS_AAC_SEGMENT.test(url)) return;

    if (IS_HLS.test(url) || IS_DASH.test(url) || IS_SMOOTH.test(url) || IS_DIRECT.test(url)) {
      this.processMediaUrl(details.tabId, url);
    } else if (IS_MEDIASITE_OPTIONS.test(url)) {
      this.fetchAndProcessMediasite(details.tabId, url);
    }
  };

  onHeadersReceived = (details: chrome.webRequest.WebResponseHeadersDetails): void => {
    if (details.tabId <= 0 || !details.url || !details.responseHeaders) return;
    const url = details.url;
    if (CHUNK_OR_IGNORABLE.test(url) || IS_AAC_SEGMENT.test(url)) return;

    let mimeType = '';
    let contentLength = 0;

    for (const h of details.responseHeaders) {
      const name = h.name.toLowerCase();
      if (name === 'content-type' && h.value) {
        mimeType = h.value.split(';')[0]?.trim().toLowerCase() || '';
      } else if (name === 'content-length' && h.value) {
        contentLength = parseInt(h.value, 10) || 0;
      }
    }

    const kind = kindFromMime(mimeType, url);
    if (!kind) return;

    if (kind === 'direct' && contentLength > 0 && contentLength < 262144) {
      // Below min size threshold (default 256KB) - likely audio blip, sprite, or ad beacon
      return;
    }

    this.processMediaUrl(details.tabId, url, mimeType, contentLength);
  };

  async handleContentReport(tabId: number, report: ContentReport): Promise<void> {
    if (report.type === 'domMedia') {
      await this.handleDomReport(tabId, report);
    } else if (report.type === 'mediasiteOptions') {
      await this.handleMediasiteReport(tabId, report);
    }
  }

  private async processMediaUrl(tabId: number, rawUrl: string, mimeType?: string, sizeBytes?: number): Promise<void> {
    if (this.processingUrls.has(rawUrl)) return;
    this.processingUrls.add(rawUrl);

    try {
      let targetUrl = rawUrl;
      let kind: MediaKind = 'direct';

      if (IS_HLS.test(rawUrl)) {
        kind = 'hls';
      } else if (IS_DASH.test(rawUrl)) {
        kind = 'dash';
      } else if (IS_SMOOTH.test(rawUrl)) {
        targetUrl = deriveHlsFromSmooth(rawUrl);
        kind = 'hls';
      } else if (mimeType) {
        const k = kindFromMime(mimeType, rawUrl);
        if (k === 'smooth') {
          targetUrl = deriveHlsFromSmooth(rawUrl);
          kind = 'hls';
        } else if (k === 'hls' || k === 'dash' || k === 'direct') {
          kind = k;
        }
      }

      let tabTitle = 'Unknown Video';
      let pageUrl = rawUrl;
      try {
        if (typeof chrome !== 'undefined' && chrome.tabs) {
          const tab = await chrome.tabs.get(tabId);
          if (tab?.title) tabTitle = tab.title;
          if (tab?.url) pageUrl = tab.url;
        }
      } catch {}

      let described: DescribedMedia = {
        qualities: [],
        audioTracks: [],
        subtitles: [],
        hasVideo: true,
        hasAudio: true,
      };

      if (kind === 'hls') {
        try {
          const res = await fetch(targetUrl, { credentials: 'include' });
          if (res.ok) {
            const text = await res.text();
            described = describeHls(text, targetUrl);
          }
        } catch {
          described.qualities = [{ id: 'q0', label: 'Default', ref: targetUrl }];
        }
      } else if (kind === 'dash') {
        try {
          const res = await fetch(targetUrl, { credentials: 'include' });
          if (res.ok) {
            const text = await res.text();
            described = describeDash(text, targetUrl);
          }
        } catch {
          described.qualities = [{ id: 'v0', label: 'Default', ref: targetUrl }];
        }
      } else {
        // Direct media
        described.qualities = [{ id: 'direct0', label: 'Original', ref: targetUrl, sizeBytes }];
      }

      const mediaItem: MediaItem = {
        id: `media_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        tabId,
        kind,
        url: targetUrl,
        title: sanitizeFilename(tabTitle),
        pageUrl,
        durationSec: described.durationSec,
        qualities:
          described.qualities.length > 0 ? described.qualities : [{ id: 'q0', label: 'Default', ref: targetUrl }],
        audioTracks: described.audioTracks,
        subtitles: described.subtitles,
        mimeType,
        sizeBytes,
        source: 'network',
        hasVideo: described.hasVideo,
        hasAudio: described.hasAudio,
        isLive: described.isLive,
        unsupportedReason: described.unsupportedReason,
        detectedAt: Date.now(),
      };

      await mediaStore.addMediaItem(mediaItem);
    } catch {
    } finally {
      this.processingUrls.delete(rawUrl);
    }
  }

  private async fetchAndProcessMediasite(tabId: number, optionsUrl: string): Promise<void> {
    try {
      const res = await fetch(optionsUrl, { credentials: 'include' });
      if (!res.ok) return;
      const json = await res.json();
      let pageUrl = optionsUrl;
      try {
        if (typeof chrome !== 'undefined' && chrome.tabs) {
          const tab = await chrome.tabs.get(tabId);
          if (tab?.url) pageUrl = tab.url;
        }
      } catch {}

      await this.handleMediasiteReport(tabId, {
        type: 'mediasiteOptions',
        pageUrl,
        payload: json,
      });
    } catch {}
  }

  private async handleDomReport(tabId: number, report: DomMediaReport): Promise<void> {
    const pageTitle = report.ogTitle || report.pageTitle || 'Web Video';

    for (const media of report.media) {
      if (CHUNK_OR_IGNORABLE.test(media.url) || IS_AAC_SEGMENT.test(media.url)) continue;

      let kind: MediaKind = 'direct';
      if (IS_HLS.test(media.url)) kind = 'hls';
      else if (IS_DASH.test(media.url)) kind = 'dash';

      const item: MediaItem = {
        id: `dom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        tabId,
        kind,
        url: media.url,
        title: sanitizeFilename(media.title || pageTitle),
        pageUrl: report.pageUrl,
        durationSec: media.duration,
        thumbnail: media.poster,
        qualities: [{ id: 'orig', label: 'Original', ref: media.url }],
        audioTracks: [],
        subtitles: [],
        source: 'dom',
        hasVideo: media.kind === 'video',
        hasAudio: true,
        unsupportedReason: media.blob ? 'In-memory blob stream (intercepted manifests preferred)' : undefined,
        detectedAt: Date.now(),
      };

      await mediaStore.addMediaItem(item);
    }
  }

  private async handleMediasiteReport(tabId: number, report: MediasiteReport): Promise<void> {
    const pres = parsePlayerOptions(report.payload, report.pageUrl);
    if (!pres || pres.streams.length === 0) return;

    const groupId = pres.presentationId || `group_${Date.now()}`;
    const defaultLayout = (await taskCoordinator.getSettings()).dualStreamLayout || 'side-by-side';

    for (const s of pres.streams) {
      if (s.slidesOnly || s.urls.length === 0) continue;
      const primaryUrl = s.urls[0];
      if (!primaryUrl) continue;

      const streamUrl = primaryUrl.derivedHls || primaryUrl.url;
      const streamKind = primaryUrl.kind === 'smooth' ? 'hls' : primaryUrl.kind;
      const isAudio = s.streamType === 2 || isAudioUrlOrMime(primaryUrl.mimeType, streamUrl);

      const item: MediaItem = {
        id: `ms_${groupId}_${s.index}`,
        tabId,
        kind: streamKind as MediaKind,
        url: streamUrl,
        title: `${sanitizeFilename(pres.title)} - ${s.label}`,
        pageUrl: report.pageUrl,
        durationSec: pres.durationSec,
        qualities: [{ id: 'best', label: 'Best Quality', ref: streamUrl }],
        audioTracks: [],
        subtitles: pres.captions.map((c, i) => ({
          id: `c_${i}`,
          label: c.label,
          language: c.language,
          url: c.url,
          format: 'vtt',
        })),
        source: 'mediasite',
        groupId,
        trackLabel: s.label,
        layout: defaultLayout,
        hasVideo: !isAudio,
        hasAudio: true,
        detectedAt: Date.now(),
      };

      await mediaStore.addMediaItem(item);
    }
  }
}

export const sniffer = new MediaSniffer();
