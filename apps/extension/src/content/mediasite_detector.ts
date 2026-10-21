import type { MediasiteReport } from '@viddock/shared';
import { isMediasiteUrl } from '@viddock/shared';

(function initMediasiteDetector() {
  let reported = false;

  function scanMediasitePlayer() {
    if (reported) return;

    const href = window.location.href;
    const isMediasite =
      isMediasiteUrl(href) ||
      document.querySelector('#MediasitePlayer, .mediasite-player, iframe[src*="mediasite"]') !== null;

    if (!isMediasite) return;

    // 1. Look for embedded Mediasite Player Options in script tags
    const scripts = document.querySelectorAll('script');
    for (const s of Array.from(scripts)) {
      const text = s.textContent || '';
      if (
        text.includes('GetPlayerOptions') ||
        text.includes('MediasitePlayerConfiguration') ||
        text.includes('"Presentation"')
      ) {
        // Try extracting JSON payload
        const jsonMatch = text.match(/\{["']?Presentation["']?\s*:\s*\{[\s\S]*?\}\s*\}\s*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            reportOptions(parsed);
            return;
          } catch {}
        }

        // Try extracting broader object containing Presentation
        const varMatch = text.match(/var\s+\w+\s*=\s*(\{[\s\S]*?"Presentation"[\s\S]*?\});/);
        if (varMatch && varMatch[1]) {
          try {
            const parsed = JSON.parse(varMatch[1]);
            reportOptions(parsed);
            return;
          } catch {}
        }
      }
    }

    // 2. Fallback: inspect any global window properties if accessible or DOM slide metadata
    const slides = document.querySelectorAll('.slide-image, .thumbnail-item img, [data-slide-time]');
    if (slides.length > 0) {
      const slideItems: { index: number; timeMs: number; thumbnailUrl?: string }[] = [];
      slides.forEach((sl, idx) => {
        const timeAttr = sl.getAttribute('data-slide-time') || sl.getAttribute('data-time') || '0';
        const timeMs = parseInt(timeAttr, 10) || idx * 30000;
        const img = sl as HTMLImageElement;
        slideItems.push({
          index: idx,
          timeMs,
          thumbnailUrl: img.src || undefined,
        });
      });

      const syntheticPayload = {
        Presentation: {
          Title: document.title || 'Mediasite Lecture',
          Streams: [],
          Slides: slideItems,
        },
      };

      reportOptions(syntheticPayload);
    }
  }

  function reportOptions(payload: unknown) {
    if (reported) return;
    reported = true;

    const report: MediasiteReport = {
      type: 'mediasiteOptions',
      pageUrl: window.location.href,
      payload,
    };

    try {
      chrome.runtime.sendMessage(report);
    } catch {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      scanMediasitePlayer();
    });
  } else {
    scanMediasitePlayer();
  }

  // Also check after window load
  window.addEventListener('load', () => {
    scanMediasitePlayer();
  });
})();
