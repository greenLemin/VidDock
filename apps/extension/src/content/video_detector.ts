import type { DomMediaReport } from '@viddock/shared';

(function initVideoDetector() {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const reportedUrls = new Set<string>();

  function harvestPageMetadata() {
    const pageTitle = document.title || '';
    const ogTitle =
      (document.querySelector('meta[property="og:title"]') as HTMLMetaElement)?.content ||
      (document.querySelector('meta[name="twitter:title"]') as HTMLMetaElement)?.content ||
      undefined;

    return { pageTitle, ogTitle };
  }

  function scanMediaElements() {
    const { pageTitle, ogTitle } = harvestPageMetadata();
    const discovered: DomMediaReport['media'] = [];

    const elements = document.querySelectorAll<HTMLMediaElement>('video, audio');
    for (const el of Array.from(elements)) {
      const isVideo = el.tagName.toLowerCase() === 'video';
      const kind: 'video' | 'audio' = isVideo ? 'video' : 'audio';
      const poster = isVideo ? (el as HTMLVideoElement).poster : undefined;
      const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : undefined;

      // 1. Direct src attribute
      const src = el.currentSrc || el.src;
      if (src && !reportedUrls.has(src)) {
        reportedUrls.add(src);
        discovered.push({
          url: src,
          kind,
          duration,
          poster: poster || undefined,
          blob: src.startsWith('blob:'),
        });
      }

      // 2. <source> child elements
      const sources = el.querySelectorAll<HTMLSourceElement>('source');
      for (const source of Array.from(sources)) {
        const sourceUrl = source.src;
        if (sourceUrl && !reportedUrls.has(sourceUrl)) {
          reportedUrls.add(sourceUrl);
          discovered.push({
            url: sourceUrl,
            kind,
            duration,
            poster: poster || undefined,
            blob: sourceUrl.startsWith('blob:'),
          });
        }
      }
    }

    if (discovered.length > 0) {
      const report: DomMediaReport = {
        type: 'domMedia',
        pageTitle,
        pageUrl: window.location.href,
        ogTitle,
        media: discovered,
      };

      try {
        chrome.runtime.sendMessage(report);
      } catch {}
    }
  }

  function scheduleScan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      requestAnimationFrame(() => {
        scanMediaElements();
      });
    }, 200);
  }

  // Initial scan
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scheduleScan());
  } else {
    scheduleScan();
  }

  // Observe dynamically inserted media elements in SPAs
  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO' || el.querySelector?.('video, audio')) {
              shouldScan = true;
              break;
            }
          }
        }
      } else if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
        shouldScan = true;
        break;
      }
      if (shouldScan) break;
    }

    if (shouldScan) {
      scheduleScan();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });
})();
