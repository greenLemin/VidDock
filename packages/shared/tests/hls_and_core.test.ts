import { describe, expect, it } from 'vitest';
import { parseAttributes, isMasterPlaylist, parseHls } from '../src/hls.ts';
import { describeHls, describeDash } from '../src/describe.ts';
import { qualityLabel, sortQualities, dedupeQualities, pickQuality } from '../src/quality.ts';
import {
  isRetryableStatus,
  backoffDelay,
  parseRetryAfter,
  formatBytes,
  formatDuration,
  formatRate,
} from '../src/util.ts';
import {
  isHttpUrl,
  parseUrl,
  resolveUrl,
  getExtension,
  isAdOrTracker,
  isLikelySegment,
  classifyUrl,
  extFromMime,
  dedupeKey,
  redactUrl,
  isSafeHeaderValue,
} from '../src/url.ts';

describe('HLS parser (packages/shared/src/hls.ts)', () => {
  it('parseAttributes parses various attributes', () => {
    const raw = 'BANDWIDTH=800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="audio-group"';
    const attrs = parseAttributes(raw);
    expect(attrs.BANDWIDTH).toBe('800000');
    expect(attrs.RESOLUTION).toBe('1280x720');
    expect(attrs.CODECS).toBe('avc1.4d401f,mp4a.40.2');
    expect(attrs.AUDIO).toBe('audio-group');
  });

  it('throws on non-M3U8 content', () => {
    expect(() => parseHls('invalid playlist', 'https://example.com/')).toThrow(/Not an M3U8 playlist/);
  });

  it('isMasterPlaylist identifies master playlist', () => {
    expect(isMasterPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500\nvideo.m3u8')).toBe(true);
    expect(isMasterPlaylist('#EXTM3U\n#EXTINF:10,\nsegment1.ts')).toBe(false);
  });

  it('parses master playlist with variants, audio, subtitles, and session drm key', () => {
    const m3u8 = `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="audio/en.m3u8",CHANNELS="2"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English Subs",DEFAULT=NO,AUTOSELECT=YES,LANGUAGE="en",URI="subs/en.vtt"
#EXT-X-STREAM-INF:BANDWIDTH=1500000,AVERAGE-BANDWIDTH=1400000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002a,mp4a.40.2",AUDIO="audio-aac",SUBTITLES="subs"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,CODECS="avc1.4d401f"
720p/index.m3u8
`;
    const res = parseHls(m3u8, 'https://example.com/live/master.m3u8');
    expect(res.type).toBe('master');
    if (res.type === 'master') {
      expect(res.variants).toHaveLength(2);
      expect(res.variants[0]!.width).toBe(1920);
      expect(res.variants[0]!.height).toBe(1080);
      expect(res.variants[0]!.frameRate).toBe(60);
      expect(res.variants[0]!.avgBandwidth).toBe(1400000);
      expect(res.variants[0]!.url).toBe('https://example.com/live/1080p/index.m3u8');
      expect(res.audio).toHaveLength(1);
      expect(res.audio[0]!.isDefault).toBe(true);
      expect(res.audio[0]!.autoselect).toBe(true);
      expect(res.subtitles).toHaveLength(1);
      expect(res.drm).toContain('SAMPLE-AES');
    }
  });

  it('parses media playlist with byteranges, encryption keys, maps, and live status', () => {
    const mediaM3u8 = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:42
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key.bin",IV=0x0000000000000000000000000000002A
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXT-X-DISCONTINUITY
#EXTINF:9.5,
#EXT-X-BYTERANGE:1024@0
segment1.ts
#EXTINF:10.0,
#EXT-X-BYTERANGE:2048
segment1.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:8.0,
segment2.ts
#EXT-X-ENDLIST
`;
    const res = parseHls(mediaM3u8, 'https://example.com/media/playlist.m3u8');
    expect(res.type).toBe('media');
    if (res.type === 'media') {
      expect(res.targetDuration).toBe(10);
      expect(res.endList).toBe(true);
      expect(res.isLive).toBe(false);
      expect(res.playlistType).toBe('VOD');
      expect(res.segments).toHaveLength(3);
      expect(res.segments[0]!.discontinuity).toBe(true);
      expect(res.segments[0]!.key?.method).toBe('AES-128');
      expect(res.segments[0]!.map?.url).toBe('https://example.com/media/init.mp4');
      expect(res.segments[0]!.byteRange).toEqual({ length: 1024, offset: 0 });
      expect(res.segments[1]!.byteRange).toEqual({ length: 2048, offset: 1024 });
      expect(res.segments[2]!.key).toBeUndefined();
      expect(res.totalDuration).toBe(27.5);
    }
  });

  it('detects DRM on AES-128 non-identity and live sliding windows', () => {
    const liveM3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-KEY:METHOD=AES-128,URI="skd://drm.key",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6.0,
seg100.ts
#EXTINF:6.0,
seg101.ts
`;
    const res = parseHls(liveM3u8, 'https://example.com/live.m3u8');
    expect(res.type).toBe('media');
    if (res.type === 'media') {
      expect(res.isLive).toBe(true);
      expect(res.drm).toContain('requires a DRM license');
    }
  });
});

describe('Describe Media (packages/shared/src/describe.ts)', () => {
  it('describes HLS media playlist correctly', () => {
    const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXTINF:5.0,
video0.ts
#EXTINF:5.0,
video1.ts
#EXT-X-ENDLIST
`;
    const d = describeHls(m3u8, 'https://example.com/video.m3u8');
    expect(d.hasVideo).toBe(true);
    expect(d.hasAudio).toBe(true);
    expect(d.durationSec).toBe(10);
    expect(d.isLive).toBe(false);
  });

  it('describes audio-only HLS media playlist', () => {
    const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXTINF:5.0,
audio.aac
#EXT-X-ENDLIST
`;
    const d = describeHls(m3u8, 'https://example.com/audio.m3u8');
    expect(d.hasVideo).toBe(false);
    expect(d.hasAudio).toBe(true);
  });

  it('describes master playlist with audio-only variants', () => {
    const m3u8 = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"
audio.m3u8
`;
    const d = describeHls(m3u8, 'https://example.com/master.m3u8');
    expect(d.hasVideo).toBe(false);
    expect(d.hasAudio).toBe(true);
  });

  it('describes DASH manifests and handles edge cases', () => {
    const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" minBufferTime="PT1.5S" type="static" mediaPresentationDuration="PT30S">
  <Period id="1" duration="PT30S">
    <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401f">
      <Representation id="v1" bandwidth="1000000" width="1280" height="720" frameRate="30">
        <BaseURL>video_720.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" lang="en">
      <Representation id="a1" bandwidth="128000">
        <BaseURL>audio_en.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const d = describeDash(mpd, 'https://example.com/manifest.mpd');
    expect(d.hasVideo).toBe(true);
    expect(d.hasAudio).toBe(true);
    expect(d.qualities).toHaveLength(1);
    expect(d.audioTracks).toHaveLength(1);
    expect(d.durationSec).toBe(30);

    // Multi-period missing video
    const mpdMissingVideo = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period id="1"><AdaptationSet mimeType="video/mp4" codecs="avc1"><Representation id="v1" bandwidth="1000"><BaseURL>v1.mp4</BaseURL></Representation></AdaptationSet></Period>
  <Period id="2"><AdaptationSet mimeType="audio/mp4" codecs="mp4a"><Representation id="a1" bandwidth="100"><BaseURL>a1.mp4</BaseURL></Representation></AdaptationSet></Period>
</MPD>`;
    expect(describeDash(mpdMissingVideo, 'https://example.com/m.mpd').unsupportedReason).toContain(
      'missing video in period 2',
    );

    // Multi-period incompatible video
    const mpdIncompatVideo = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period id="1"><AdaptationSet mimeType="video/mp4" codecs="avc1"><Representation id="v1" bandwidth="1000"><BaseURL>v1.mp4</BaseURL></Representation></AdaptationSet></Period>
  <Period id="2"><AdaptationSet mimeType="video/webm" codecs="vp9"><Representation id="v2" bandwidth="1000"><BaseURL>v2.webm</BaseURL></Representation></AdaptationSet></Period>
</MPD>`;
    expect(describeDash(mpdIncompatVideo, 'https://example.com/m.mpd').unsupportedReason).toContain(
      'incompatible video codecs',
    );

    // Multi-period missing audio
    const mpdMissingAudio = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period id="1"><AdaptationSet mimeType="audio/mp4" codecs="mp4a"><Representation id="a1" bandwidth="100"><BaseURL>a1.mp4</BaseURL></Representation></AdaptationSet></Period>
  <Period id="2"><AdaptationSet mimeType="video/mp4" codecs="avc1"><Representation id="v1" bandwidth="1000"><BaseURL>v1.mp4</BaseURL></Representation></AdaptationSet></Period>
</MPD>`;
    expect(describeDash(mpdMissingAudio, 'https://example.com/m.mpd').unsupportedReason).toContain(
      'missing audio in period 2',
    );

    // Multi-period incompatible audio
    const mpdIncompatAudio = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period id="1"><AdaptationSet mimeType="audio/mp4" codecs="mp4a"><Representation id="a1" bandwidth="100"><BaseURL>a1.mp4</BaseURL></Representation></AdaptationSet></Period>
  <Period id="2"><AdaptationSet mimeType="audio/webm" codecs="opus"><Representation id="a2" bandwidth="100"><BaseURL>a2.webm</BaseURL></Representation></AdaptationSet></Period>
</MPD>`;
    expect(describeDash(mpdIncompatAudio, 'https://example.com/m.mpd').unsupportedReason).toContain(
      'incompatible audio codecs',
    );

    // Audio-only DASH manifest
    const mpdAudioOnly = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period id="1"><AdaptationSet mimeType="audio/mp4" codecs="mp4a"><Representation id="a1" bandwidth="128000"><BaseURL>a1.mp4</BaseURL></Representation></AdaptationSet></Period>
</MPD>`;
    const audioDesc = describeDash(mpdAudioOnly, 'https://example.com/audio.mpd');
    expect(audioDesc.hasVideo).toBe(false);
    expect(audioDesc.hasAudio).toBe(true);

    // Empty DASH manifest
    const mpdEmpty = `<?xml version="1.0" encoding="UTF-8"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"><Period id="1"></Period></MPD>`;
    expect(describeDash(mpdEmpty, 'https://example.com/empty.mpd').unsupportedReason).toContain(
      'no downloadable representations',
    );
  });

  it('detects empty variants in master and media playlists', () => {
    const emptyMaster = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n`;
    expect(describeHls(emptyMaster, 'https://example.com/master.m3u8').unsupportedReason).toBeDefined();

    const emptyMedia = `#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-ENDLIST\n`;
    expect(describeHls(emptyMedia, 'https://example.com/media.m3u8').unsupportedReason).toBe(
      'Playlist contains no segments',
    );
  });
});

describe('Quality helpers (packages/shared/src/quality.ts)', () => {
  it('formats quality labels with fps and bandwidth fallback', () => {
    expect(qualityLabel(1080, 5000000, 60)).toBe('1080p60');
    expect(qualityLabel(720, 2000000, 30)).toBe('720p');
    expect(qualityLabel(undefined, 256000)).toBe('256 kbps');
    expect(qualityLabel()).toBe('Original');
  });

  it('sorts and dedupes qualities', () => {
    const list = [
      { height: 720, bandwidth: 2000, codecs: 'avc1' },
      { height: 1080, bandwidth: 4000, codecs: 'avc1' },
      { height: 1080, bandwidth: 4000, codecs: 'avc1' },
      { height: 1080, bandwidth: 5000, codecs: 'avc1' },
    ];
    const sorted = sortQualities(list);
    expect(sorted[0]!.height).toBe(1080);
    expect(sorted[0]!.bandwidth).toBe(5000);

    const deduped = dedupeQualities(list);
    expect(deduped).toHaveLength(3);
  });

  it('picks appropriate quality based on preference', () => {
    const list = [
      { height: 1080, bandwidth: 4000 },
      { height: 720, bandwidth: 2000 },
      { height: 480, bandwidth: 1000 },
    ];
    expect(pickQuality([], 'best')).toBeUndefined();
    expect(pickQuality(list, 'best')?.height).toBe(1080);
    expect(pickQuality(list, 720)?.height).toBe(720);
    expect(pickQuality(list, 600)?.height).toBe(480);
    expect(pickQuality(list, 240)?.height).toBe(480);

    const bandwidthOnly = [{ bandwidth: 1000 }, { bandwidth: 500 }];
    expect(pickQuality(bandwidthOnly, 720)?.bandwidth).toBe(1000);
  });
});

describe('Utility functions (packages/shared/src/util.ts)', () => {
  it('isRetryableStatus checks retryable HTTP codes', () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
  });

  it('backoffDelay respects boundaries', () => {
    const d1 = backoffDelay(0, 1000, 30000, () => 0.5);
    expect(d1).toBe(750);
    const dMax = backoffDelay(10, 1000, 5000, () => 1);
    expect(dMax).toBe(5000);
  });

  it('parseRetryAfter parses seconds and HTTP dates', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('15')).toBe(15000);
    const future = new Date(Date.now() + 5000).toUTCString();
    const parsed = parseRetryAfter(future, Date.now());
    expect(parsed).toBeGreaterThanOrEqual(4000);
    expect(parsed).toBeLessThanOrEqual(6000);
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });

  it('formatBytes formats file sizes correctly', () => {
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.00 KB');
    expect(formatBytes(15 * 1024 * 1024)).toBe('15.0 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
  });

  it('formatDuration formats timestamps', () => {
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
    expect(formatDuration(45)).toBe('0:45');
    expect(formatDuration(125)).toBe('2:05');
    expect(formatDuration(3665)).toBe('1:01:05');
  });

  it('formatRate formats transfer speeds', () => {
    expect(formatRate(undefined)).toBe('—');
    expect(formatRate(0)).toBe('—');
    expect(formatRate(1024 * 1024)).toBe('1.00 MB/s');
  });
});

describe('URL and Classification helpers (packages/shared/src/url.ts)', () => {
  it('isHttpUrl and parseUrl handle valid and invalid inputs', () => {
    expect(isHttpUrl('https://example.com/test')).toBe(true);
    expect(isHttpUrl('http://localhost:8080')).toBe(true);
    expect(isHttpUrl('ftp://ftp.example.com')).toBe(false);
    expect(isHttpUrl('invalid-url')).toBe(false);
    expect(parseUrl('https://example.com/a', 'https://example.com/b')).toBeDefined();
    expect(parseUrl('::invalid')).toBeUndefined();
  });

  it('resolveUrl and getExtension resolve paths and extensions', () => {
    expect(resolveUrl('seg1.ts', 'https://example.com/path/playlist.m3u8')).toBe('https://example.com/path/seg1.ts');
    expect(getExtension('https://example.com/video.mp4?token=123')).toBe('mp4');
    expect(getExtension('https://example.com/noext')).toBe('');
  });

  it('isAdOrTracker identifies advertising domains and paths', () => {
    expect(isAdOrTracker('https://securepubads.g.doubleclick.net/gampad/ads')).toBe(true);
    expect(isAdOrTracker('https://example.com/vast/adserver')).toBe(true);
    expect(isAdOrTracker('https://example.com/videos/lecture.mp4')).toBe(false);
  });

  it('isLikelySegment detects common segment heuristics', () => {
    expect(isLikelySegment('https://example.com/chunk_001.m4s')).toBe(true);
    expect(isLikelySegment('https://example.com/segment-12.ts')).toBe(true);
    expect(isLikelySegment('https://example.com/init.mp4')).toBe(true);
    expect(isLikelySegment('https://example.com/seg_10.aac')).toBe(true);
    expect(isLikelySegment('https://example.com/video.mp4?bytestart=0&byteend=100')).toBe(true);
    expect(isLikelySegment('https://example.com/video.mp4')).toBe(false);
  });

  it('classifyUrl identifies stream kinds from URL and contentType', () => {
    expect(classifyUrl('https://example.com/stream.m3u8').type).toBe('hls');
    expect(classifyUrl('https://example.com/stream', 'application/x-mpegURL').type).toBe('hls');
    expect(classifyUrl('https://example.com/manifest.mpd').type).toBe('dash');
    expect(classifyUrl('https://example.com/sub.vtt').type).toBe('subtitle');
    expect(classifyUrl('https://example.com/segment.m4s').type).toBe('segment');
    expect(classifyUrl('https://example.com/chunk.ts', 'video/mp2t').type).toBe('segment');
    expect(classifyUrl('https://example.com/chunk.iso', 'video/iso.segment').type).toBe('segment');
    expect(classifyUrl('https://example.com/chunk.ts', 'audio/mp2t').type).toBe('segment');
    expect(classifyUrl('https://example.com/plain.xyz', 'video/mp2t').type).toBe('segment');
    expect(classifyUrl('https://example.com/plain', 'video/webm')).toEqual({
      type: 'direct',
      audioOnly: false,
      ext: 'webm',
    });
    expect(classifyUrl('https://example.com/movie.mp4')).toEqual({
      type: 'direct',
      audioOnly: false,
      ext: 'mp4',
    });
    expect(classifyUrl('https://example.com/track.mp3')).toEqual({
      type: 'direct',
      audioOnly: true,
      ext: 'mp3',
    });
    expect(classifyUrl('https://example.com/audio', 'audio/ogg')).toEqual({
      type: 'direct',
      audioOnly: true,
      ext: 'ogg',
    });
    expect(classifyUrl('https://example.com/file.unknown', 'application/octet-stream')).toEqual({
      type: 'ignore',
    });
  });

  it('extFromMime maps common media mime types', () => {
    expect(extFromMime('video/mp4; codecs="avc1"')).toBe('mp4');
    expect(extFromMime('video/webm')).toBe('webm');
    expect(extFromMime('video/quicktime')).toBe('mov');
    expect(extFromMime('video/x-m4v')).toBe('m4v');
    expect(extFromMime('video/x-matroska')).toBe('mkv');
    expect(extFromMime('video/ogg')).toBe('ogv');
    expect(extFromMime('audio/mpeg')).toBe('mp3');
    expect(extFromMime('audio/mp4')).toBe('m4a');
    expect(extFromMime('audio/x-m4a')).toBe('m4a');
    expect(extFromMime('audio/aac')).toBe('aac');
    expect(extFromMime('audio/ogg')).toBe('ogg');
    expect(extFromMime('audio/opus')).toBe('opus');
    expect(extFromMime('audio/flac')).toBe('flac');
    expect(extFromMime('audio/wav')).toBe('wav');
    expect(extFromMime('audio/x-wav')).toBe('wav');
    expect(extFromMime('audio/webm')).toBe('webm');
    expect(extFromMime('unknown/mime')).toBe('');
  });

  it('dedupeKey strips volatile authentication and caching parameters', () => {
    const u1 = 'https://example.com/video.mp4?token=abc&expire=123&keep=1';
    const u2 = 'https://example.com/video.mp4?keep=1&token=xyz&expire=999';
    expect(dedupeKey(u1)).toBe(dedupeKey(u2));
    expect(dedupeKey(u1)).toBe('https://example.com/video.mp4?keep=1');
  });

  it('redactUrl hides credentials and queries safely', () => {
    expect(redactUrl('https://user:pass@example.com/secret?key=123#frag')).toBe('https://example.com/secret?%E2%80%A6');
    expect(redactUrl('not-a-url')).toBe('[invalid-url]');
  });

  it('isSafeHeaderValue rejects control characters and excessive length', () => {
    expect(isSafeHeaderValue('Bearer token123')).toBe(true);
    expect(isSafeHeaderValue('Bearer bad\r\nHeader: value')).toBe(false);
    expect(isSafeHeaderValue('x'.repeat(20000))).toBe(false);
  });
});
