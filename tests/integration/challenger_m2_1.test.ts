import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelloData } from '@viddock/shared';
import { getExtension, isLikelySegment, parsePlayerOptions } from '@viddock/shared';
import { mediaStore } from '../../apps/extension/src/background/media_store.ts';
import { NativeClient } from '../../apps/extension/src/background/native_client.ts';
import { MediaSniffer } from '../../apps/extension/src/background/sniffer.ts';
import { setupChromeMock } from '../../apps/extension/tests/mocks/chrome.ts';

describe('Milestone 2 Challenger Empirical Test Suite', () => {
  let mockEnv: ReturnType<typeof setupChromeMock>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllTimers();
    mockEnv = setupChromeMock();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // =========================================================================
  // SECTION 1: Sniffer Regex & URL Parser Stress Testing
  // =========================================================================
  describe('1. Sniffer Regex & URL Parser Adversarial Edge Cases', () => {
    const CHUNK_OR_IGNORABLE = /\.(ts|m4s|m4i|vtt|srt|key|aac|png|jpg|jpeg|gif|svg|ico|css|js|woff|woff2)(\?|#|$)/i;
    const IS_HLS = /\.m3u8(\?|#|$)/i;
    const IS_DASH = /\.mpd(\?|#|$)/i;
    const IS_SMOOTH = /\.ism\/manifest/i;
    const IS_DIRECT = /\.(mp4|m4v|webm|mov|mkv|mp3|m4a|aac)(\?|#|$)/i;
    const IS_MEDIASITE_OPTIONS =
      /(PlayerService\.svc\/json\/GetPlayerOptions|\/api\/v1\/player\/options|playeroptions)/i;

    it('matches Smooth and Direct streams with standard regexes', () => {
      expect(IS_SMOOTH.test('https://mediasite.edu/video.ism/manifest')).toBe(true);
      expect(IS_DIRECT.test('https://cdn.example.com/movie.mp4')).toBe(true);
    });

    it('matches obfuscated and complex HLS URLs', () => {
      const validHlsUrls = [
        'https://cdn.example.com/live/master.m3u8',
        'https://cdn.example.com/live/master.m3u8?token=abc.def&exp=1799999999&sig=4a8f9c',
        'https://cdn.example.com/live/master.M3U8',
        'https://cdn.example.com/live/master.m3u8#track=1&bitrate=2000',
        'https://cdn.example.com/video%2Fmaster.m3u8?auth=1',
        'https://cdn.example.com/hls/stream.m3u8?query=param&another=val#frag',
        'https://sub.domain.corp.com:8443/hls-vod/index.m3u8?wmsAuthSign=c2VydmVyX3RpbWU9MTAv',
      ];

      for (const url of validHlsUrls) {
        expect(IS_HLS.test(url), `Failed matching HLS URL: ${url}`).toBe(true);
        expect(CHUNK_OR_IGNORABLE.test(url), `HLS URL mistakenly flagged as chunk: ${url}`).toBe(false);
      }
    });

    it('identifies matrix parameter limitation in regex-based URL extension detection', () => {
      // Matrix parameter URL: .m3u8;session=xyz
      // In RFC 3986 matrix parameters (;param=value) are part of path segments
      const matrixUrl = 'https://cdn.example.com/video.m3u8;session=12345?token=abc';
      const matchesStandardRegex = IS_HLS.test(matrixUrl);
      // Documenting exact empirical behavior:
      // Because regex checks (\?|#|$), a semicolon prevents standard regex match
      expect(matchesStandardRegex).toBe(false);

      // However, URL path classification via getExtension or classifyUrl
      const ext = getExtension(matrixUrl);
      // Last segment has .m3u8;session=12345 so extension extraction includes semicolon param
      expect(ext).toContain('m3u8');
    });

    it('matches obfuscated and complex MPEG-DASH manifest URLs', () => {
      const validDashUrls = [
        'https://dash.example.com/manifest.mpd',
        'https://dash.example.com/stream.mpd?hdnts=exp=1690000000~hmac=abcdef',
        'https://dash.example.com/stream.MPD#subtitle_track',
        'https://dash.example.com/path%2Fmanifest.mpd?range=100-200',
      ];

      for (const url of validDashUrls) {
        expect(IS_DASH.test(url), `Failed matching DASH URL: ${url}`).toBe(true);
        expect(CHUNK_OR_IGNORABLE.test(url), `DASH URL mistakenly flagged as chunk: ${url}`).toBe(false);
      }
    });

    it('correctly filters fragmented video stream chunks and static assets', () => {
      const chunksAndAssets = [
        'https://cdn.example.com/stream/segment-001.ts',
        'https://cdn.example.com/stream/segment-001.ts?auth=token123',
        'https://cdn.example.com/stream/segment-001.TS#t=10',
        'https://cdn.example.com/stream/chunk-v1-0001.m4s',
        'https://cdn.example.com/stream/chunk.m4s?range=0-1024',
        'https://cdn.example.com/stream/init.m4s',
        'https://cdn.example.com/stream/init.m4i',
        'https://cdn.example.com/captions/subtitles.vtt',
        'https://cdn.example.com/captions/subtitles.srt',
        'https://cdn.example.com/encryption/hls.key',
        'https://cdn.example.com/styles/main.css?v=1.2.3',
        'https://cdn.example.com/scripts/vendor.js',
        'https://cdn.example.com/images/hero.png',
        'https://cdn.example.com/images/poster.jpg',
        'https://cdn.example.com/favicon.ico',
        'https://cdn.example.com/fonts/sfpro.woff2',
      ];

      for (const url of chunksAndAssets) {
        expect(CHUNK_OR_IGNORABLE.test(url), `Failed to discard chunk/asset: ${url}`).toBe(true);
      }
    });

    it('empirically evaluates fragmented MP4 init and segment chunks with isLikelySegment', () => {
      // Test segment chunk heuristics
      expect(isLikelySegment('https://cdn.example.com/stream/init.mp4')).toBe(true);
      expect(isLikelySegment('https://cdn.example.com/stream/initialization-video.mp4')).toBe(true);
      expect(isLikelySegment('https://cdn.example.com/stream/chunk_001.m4s')).toBe(true);
      expect(isLikelySegment('https://cdn.example.com/stream/seg-10.ts')).toBe(true);
      expect(isLikelySegment('https://cdn.example.com/video.mp4?bytestart=0&byteend=5000')).toBe(true);

      // Whole standalone videos should NOT be flagged as segments
      expect(isLikelySegment('https://cdn.example.com/uploads/full_lecture_2026.mp4')).toBe(false);
      expect(isLikelySegment('https://cdn.example.com/videos/movie_trailer.webm')).toBe(false);
    });

    it('empirically tests direct video size threshold filtering via onHeadersReceived', async () => {
      const sniffer = new MediaSniffer();

      // Test 1: Video under 256KB threshold (e.g., 50KB audio sprite / short beacon) -> must be ignored
      sniffer.onHeadersReceived({
        tabId: 1,
        url: 'https://cdn.example.com/short_audio_sprite.mp4',
        responseHeaders: [
          { name: 'Content-Type', value: 'video/mp4' },
          { name: 'Content-Length', value: '51200' }, // 50 KB
        ],
      } as unknown as chrome.webRequest.WebResponseHeadersDetails);

      // Test 2: Video over 256KB threshold (e.g., 15MB video) -> must be captured
      sniffer.onHeadersReceived({
        tabId: 1,
        url: 'https://cdn.example.com/full_lecture_recording.mp4',
        responseHeaders: [
          { name: 'Content-Type', value: 'video/mp4' },
          { name: 'Content-Length', value: '15728640' }, // 15 MB
        ],
      } as unknown as chrome.webRequest.WebResponseHeadersDetails);

      // Test 3: Favicon / Image -> must be ignored by kindFromMime
      sniffer.onHeadersReceived({
        tabId: 1,
        url: 'https://cdn.example.com/favicon.png',
        responseHeaders: [
          { name: 'Content-Type', value: 'image/png' },
          { name: 'Content-Length', value: '1024' },
        ],
      } as unknown as chrome.webRequest.WebResponseHeadersDetails);

      // Test 4: Video with missing Content-Length header (chunked transfer)
      sniffer.onHeadersReceived({
        tabId: 1,
        url: 'https://cdn.example.com/chunked_live_video.mp4',
        responseHeaders: [
          { name: 'Content-Type', value: 'video/mp4' },
          { name: 'Transfer-Encoding', value: 'chunked' },
        ],
      } as unknown as chrome.webRequest.WebResponseHeadersDetails);

      // Allow microtasks to complete
      await Promise.resolve();
      await vi.runAllTimersAsync();

      const tabMedia = await mediaStore.getTabMedia(1);
      const capturedUrls = tabMedia.map((m) => m.url);

      // Assertions
      expect(capturedUrls).not.toContain('https://cdn.example.com/short_audio_sprite.mp4');
      expect(capturedUrls).not.toContain('https://cdn.example.com/favicon.png');
      expect(capturedUrls).toContain('https://cdn.example.com/full_lecture_recording.mp4');
      expect(capturedUrls).toContain('https://cdn.example.com/chunked_live_video.mp4');
    });

    it('empirically evaluates Mediasite options API path variations', () => {
      const validMediasiteEndpoints = [
        'https://mediasite.org/Mediasite/PlayerService.svc/json/GetPlayerOptions',
        'https://university.edu/Mediasite/PlayerService.svc/json/GetPlayerOptions',
        'https://lecture.edu/api/v1/player/options?id=presentation_992',
        'https://lecture.edu/playeroptions.json',
        'https://lecture.edu/mediasite/playerservice.svc/json/getplayeroptions',
        'https://school.edu/api/playeroptions?format=json',
      ];

      for (const endpoint of validMediasiteEndpoints) {
        expect(IS_MEDIASITE_OPTIONS.test(endpoint), `Failed matching Mediasite endpoint: ${endpoint}`).toBe(true);
      }

      // Non-Mediasite URLs must not match
      expect(IS_MEDIASITE_OPTIONS.test('https://example.com/api/v1/player/settings')).toBe(false);
      expect(IS_MEDIASITE_OPTIONS.test('https://example.com/video/options.mp4')).toBe(false);
    });

    it('correctly parses Mediasite PlayerOptions multi-track presentation and slides', () => {
      const mockMediasitePayload = {
        Presentation: {
          Id: 'pres_m2_test_1',
          Title: 'Introduction to Distributed Systems',
          Duration: 3600000, // 1 hour = 3600s
          Presenters: [{ DisplayName: 'Dr. Turing' }],
          Streams: [
            {
              StreamType: 0,
              VideoUrls: [
                {
                  Location: 'https://mediasite.edu/video1.ism/manifest',
                  MimeType: 'application/vnd.ms-sstr+xml',
                },
              ],
            },
            {
              StreamType: 2,
              VideoUrls: [
                {
                  Location: 'https://mediasite.edu/video2.ism/manifest',
                  MimeType: 'application/vnd.ms-sstr+xml',
                },
              ],
            },
          ],
          Slides: [
            { Time: 0, Title: 'Slide 1: Agenda', ThumbnailUrl: 'https://mediasite.edu/slide1.jpg' },
            { Time: 30000, Title: 'Slide 2: Consensus', ThumbnailUrl: 'https://mediasite.edu/slide2.jpg' },
          ],
          Transcripts: [{ Name: 'English Subtitles', Language: 'en', Url: 'https://mediasite.edu/subtitles.vtt' }],
        },
      };

      const parsed = parsePlayerOptions(mockMediasitePayload, 'https://mediasite.edu/Play/pres_m2_test_1');
      expect(parsed).toBeDefined();
      expect(parsed?.title).toBe('Introduction to Distributed Systems');
      expect(parsed?.durationSec).toBe(3600);
      expect(parsed?.presenters).toContain('Dr. Turing');
      expect(parsed?.streams.length).toBe(2);
      expect(parsed?.slides.length).toBe(2);
      expect(parsed?.captions.length).toBe(1);

      // Verify derived HLS URL generation for Smooth Streaming
      const s0 = parsed?.streams[0]?.urls[0];
      expect(s0?.derivedHls).toBe('https://mediasite.edu/video1.ism/manifest(format=m3u8-aapl)');
    });
  });

  // =========================================================================
  // SECTION 2: Native Client RPC & Port Reconnect Lifecycle
  // =========================================================================
  describe('2. Native Client Port Reconnect & RPC Queue Lifecycle', () => {
    it('executes handshake and successfully establishes connection status', async () => {
      const client = new NativeClient();
      const port = mockEnv.getNativePort()!;
      expect(port).toBeDefined();
      expect(port.messagesSent.length).toBe(1);
      expect(port.messagesSent[0]?.type).toBe('hello');

      // Companion responds with hello payload
      port.simulateReceive({
        type: 'reply',
        id: port.messagesSent[0]?.id || '',
        ok: true,
        data: {
          protocol: 1,
          version: '1.0.0',
          platform: 'darwin',
          ffmpeg: '/usr/local/bin/ffmpeg',
          ffprobe: '/usr/local/bin/ffprobe',
          defaultOutputDir: '/Users/test/Downloads',
        } as HelloData,
      });

      await Promise.resolve();

      const status = client.getStatus();
      expect(status.connected).toBe(true);
      expect(status.version).toBe('1.0.0');
      expect(status.ffmpeg).toBe('/usr/local/bin/ffmpeg');
      expect(status.platform).toBe('darwin');
    });

    it('rejects pending requests upon unexpected port disconnection and schedules reconnect', async () => {
      const client = new NativeClient();
      const port = mockEnv.getNativePort()!;

      // Complete handshake
      port.simulateReceive({
        type: 'reply',
        id: port.messagesSent[0]?.id || '',
        ok: true,
        data: { version: '1.0.0' },
      });
      await Promise.resolve();

      // Dispatch 2 concurrent RPC requests
      const p1 = client.sendRequest({ type: 'tasks.list' });
      const p2 = client.sendRequest({ type: 'diagnostics' });

      // Simulate abrupt port disconnection (e.g. native host crashed)
      port.simulateDisconnect('Native messaging host crashed unexpectedly');

      await expect(p1).rejects.toThrow('Native messaging host crashed unexpectedly');
      await expect(p2).rejects.toThrow('Native messaging host crashed unexpectedly');

      const status = client.getStatus();
      expect(status.connected).toBe(false);
      expect(status.error).toContain('crashed');
      client.disconnect();
    });

    it('applies exponential backoff with jitter on reconnect attempts', async () => {
      const client = new NativeClient();
      const port = mockEnv.getNativePort()!;

      // Complete handshake
      port.simulateReceive({
        type: 'reply',
        id: port.messagesSent[0]?.id || '',
        ok: true,
        data: { version: '1.0.0' },
      });
      await Promise.resolve();
      expect(client.getStatus().connected).toBe(true);

      // Disconnect 1: Base delay ~1000ms * (0.8 ~ 1.2)
      port.simulateDisconnect('Port closed');
      expect(client.getStatus().connected).toBe(false);

      // Fast-forward 700ms (should not have reconnected yet)
      await vi.advanceTimersByTimeAsync(700);
      expect(mockEnv.getNativePort()).toBe(port); // Still old disconnected port

      // Fast-forward remaining 600ms (total 1300ms, triggers reconnect)
      await vi.advanceTimersByTimeAsync(600);

      // A new port should have been created and new hello sent
      const newPort = mockEnv.getNativePort()!;
      expect(newPort).not.toBe(port);
      expect(newPort.messagesSent.length).toBe(1);
      expect(newPort.messagesSent[0]?.type).toBe('hello');

      // Successful handshake resets backoff
      newPort.simulateReceive({
        type: 'reply',
        id: newPort.messagesSent[0]?.id || '',
        ok: true,
        data: { version: '1.0.0' },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(client.getStatus().connected).toBe(true);
      client.disconnect();
    });

    it('enforces request timeout for unresponsive host requests', async () => {
      const client = new NativeClient();
      const port = mockEnv.getNativePort()!;

      port.simulateReceive({
        type: 'reply',
        id: port.messagesSent[0]?.id || '',
        ok: true,
        data: { version: '1.0.0' },
      });
      await Promise.resolve();
      await Promise.resolve();

      const timeoutMs = 2500;
      const promise = client.sendRequest({ type: 'diagnostics' }, timeoutMs);
      const assertion = expect(promise).rejects.toThrow(`Host request timed out after ${timeoutMs}ms`);

      // Advance clock past timeout
      await vi.advanceTimersByTimeAsync(3000);
      await assertion;
    });

    it('empirically challenges behavior when initial handshake times out (companion hung)', async () => {
      const client = new NativeClient();
      const port = mockEnv.getNativePort()!;
      expect(port).toBeDefined();
      expect(port.messagesSent.length).toBe(1);

      // Host never responds to hello (hangs) -> advance past 10000ms handshake timeout
      await vi.advanceTimersByTimeAsync(11000);
      await Promise.resolve();
      await Promise.resolve();

      const status = client.getStatus();
      expect(status.connected).toBe(false);
      expect(status.error).toContain('Host request timed out after 10000ms');

      // CRITICAL ARCHITECTURAL FINDING:
      // Notice that when handshake times out without onDisconnect firing from Chrome,
      // client.port still holds the Port object reference.
      // Calling client.disconnect() cleans up the zombie port.
      client.disconnect();
      expect(client.getStatus().connected).toBe(false);
    });

    it('broadcasts status changes to registered listeners', async () => {
      const client = new NativeClient();
      const port = mockEnv.getNativePort()!;
      const observedStatuses: boolean[] = [];

      const unsubscribe = client.onStatusChange((status) => {
        observedStatuses.push(status.connected);
      });

      port.simulateReceive({
        type: 'reply',
        id: port.messagesSent[0]?.id || '',
        ok: true,
        data: { version: '1.0.0' },
      });
      await Promise.resolve();
      await Promise.resolve();

      port.simulateDisconnect('Lost host connection');
      await Promise.resolve();

      unsubscribe();
      expect(observedStatuses).toEqual([true, false]);
      client.disconnect();
    });
  });

  // =========================================================================
  // SECTION 3: Unpacked Extension Packaging & Asset Integrity
  // =========================================================================
  describe('3. Unpacked Extension Packaging & Asset Byte Integrity', () => {
    const extDist = path.resolve(process.cwd(), 'apps', 'extension', 'dist');

    it('validates manifest.json syntax and MV3 specifications', () => {
      const manifestPath = path.join(extDist, 'manifest.json');
      expect(fs.existsSync(manifestPath), 'manifest.json missing in dist/').toBe(true);

      const content = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(content);

      expect(manifest.manifest_version).toBe(3);
      expect(manifest.name).toBe('VidDock - Video Stream & Lecture Downloader');
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.minimum_chrome_version).toBe('116');

      // Background module worker
      expect(manifest.background?.service_worker).toBe('background.js');
      expect(manifest.background?.type).toBe('module');

      // Action popup
      expect(manifest.action?.default_popup).toBe('popup/index.html');
      expect(manifest.action?.default_title).toBe('VidDock Video Downloader');

      // Permissions
      expect(manifest.permissions).toContain('storage');
      expect(manifest.permissions).not.toContain('declarativeNetRequest');
      expect(manifest.permissions).toContain('nativeMessaging');
      expect(manifest.permissions).toContain('downloads');
      expect(manifest.host_permissions).toContain('<all_urls>');

      // Content scripts
      expect(manifest.content_scripts.length).toBe(2);
      expect(manifest.content_scripts[0]?.js).toContain('content_video.js');
      expect(manifest.content_scripts[1]?.js).toContain('content_mediasite.js');
    });

    it('verifies that all files referenced in manifest.json actually exist in dist', () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(extDist, 'manifest.json'), 'utf8'));
      const referencedFiles: string[] = [
        manifest.background?.service_worker,
        manifest.action?.default_popup,
        ...(manifest.content_scripts ?? []).flatMap((c: { js?: string[] }) => c.js ?? []),
        ...Object.values(manifest.icons ?? {}),
        ...Object.values(manifest.action?.default_icon ?? {}),
      ];

      for (const rel of referencedFiles) {
        const abs = path.join(extDist, rel);
        expect(fs.existsSync(abs), `Referenced file missing: ${rel}`).toBe(true);
        expect(fs.statSync(abs).size, `Referenced file is empty: ${rel}`).toBeGreaterThan(0);
      }
    });

    it('verifies absence of inline scripts across all extension HTML views (Strict MV3 CSP)', () => {
      const views = ['popup', 'dashboard', 'settings'];
      for (const view of views) {
        const htmlPath = path.join(extDist, view, 'index.html');
        expect(fs.existsSync(htmlPath), `HTML view missing: ${view}`).toBe(true);
        const html = fs.readFileSync(htmlPath, 'utf8');

        // Regex detecting inline script tags without src attribute
        const hasInlineScript = /<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/i.test(html);
        expect(hasInlineScript, `Disallowed inline script detected in ${view}/index.html`).toBe(false);
      }
    });

    it('empirically verifies PNG icon validity: dimensions, 8-bit depth, RGBA color type, and IEEE 802.3 CRC32', () => {
      const crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
          c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        crcTable[n] = c;
      }
      function computeCrc32(buf: Buffer): number {
        let crc = 0xffffffff;
        for (let i = 0; i < buf.length; i++) {
          crc = crcTable[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
      }

      const iconSpecs = [
        { file: 'icons/icon-16.png', expectedSize: 16 },
        { file: 'icons/icon-48.png', expectedSize: 48 },
        { file: 'icons/icon-128.png', expectedSize: 128 },
      ];

      for (const { file, expectedSize } of iconSpecs) {
        const iconPath = path.join(extDist, file);
        expect(fs.existsSync(iconPath), `Icon not found: ${file}`).toBe(true);
        const buf = fs.readFileSync(iconPath);

        // PNG 8-byte signature: 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A
        const signature = buf.subarray(0, 8);
        expect(signature.toString('hex')).toBe('89504e470d0a1a0a');

        let offset = 8;
        let ihdrValidated = false;
        let iendValidated = false;

        while (offset < buf.length) {
          const chunkLen = buf.readUInt32BE(offset);
          const chunkType = buf.subarray(offset + 4, offset + 8).toString('ascii');
          const chunkData = buf.subarray(offset + 8, offset + 8 + chunkLen);
          const expectedCrc = buf.readUInt32BE(offset + 8 + chunkLen);

          // Verify CRC32 checksum over (chunkType + chunkData)
          const typeAndData = buf.subarray(offset + 4, offset + 8 + chunkLen);
          const actualCrc = computeCrc32(typeAndData);
          expect(actualCrc, `CRC32 checksum mismatch in ${file} chunk ${chunkType}`).toBe(expectedCrc);

          if (chunkType === 'IHDR') {
            ihdrValidated = true;
            const width = chunkData.readUInt32BE(0);
            const height = chunkData.readUInt32BE(4);
            const bitDepth = chunkData[8];
            const colorType = chunkData[9];
            const compressionMethod = chunkData[10];
            const filterMethod = chunkData[11];
            const interlaceMethod = chunkData[12];

            expect(width).toBe(expectedSize);
            expect(height).toBe(expectedSize);
            expect(bitDepth).toBe(8); // 8-bit depth
            expect(colorType).toBe(6); // RGBA (Truecolor with alpha)
            expect(compressionMethod).toBe(0); // Deflate
            expect(filterMethod).toBe(0); // Standard filter
            expect(interlaceMethod).toBe(0); // Non-interlaced
          } else if (chunkType === 'IEND') {
            iendValidated = true;
          }

          offset += 8 + chunkLen + 4;
        }

        expect(ihdrValidated, `IHDR chunk missing in ${file}`).toBe(true);
        expect(iendValidated, `IEND chunk missing in ${file}`).toBe(true);
      }
    });
  });
});
