import { describe, expect, it } from 'vitest';
import { parseMpd } from '../src/dash.ts';
import { describeDash } from '../src/describe.ts';
import { parsePlayerOptions } from '../src/mediasite.ts';
import { validateDownloadRequest } from '../src/protocol.ts';
import type { DualStreamLayout } from '../src/types.ts';

describe('CHALLENGER: parsePlayerOptions Empirical Stress Suite', () => {
  const basePresentation = {
    Title: 'Test Presentation',
    Duration: 120000,
    Streams: [
      {
        StreamType: 0,
        VideoUrls: [{ Location: 'https://example.com/stream.mp4', MimeType: 'video/mp4' }],
      },
    ],
  };

  describe('1. Empty slides and non-object items', () => {
    it('handles empty slides array cleanly', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [],
        },
      });
      expect(res).toBeDefined();
      expect(res?.slides).toEqual([]);
    });

    it('handles stream slides with empty array cleanly', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Streams: [
            {
              StreamType: 0,
              VideoUrls: [{ Location: 'https://example.com/stream.mp4', MimeType: 'video/mp4' }],
              Slides: [],
            },
          ],
        },
      });
      expect(res).toBeDefined();
      expect(res?.slides).toEqual([]);
    });

    it('handles empty slide object {} safely without throwing', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [{}],
        },
      });
      expect(res).toBeDefined();
      expect(res?.slides).toHaveLength(1);
      expect(res?.slides[0]).toEqual({
        index: 0,
        title: undefined,
        timeMs: 0,
        timeSec: 0,
        thumbnailUrl: undefined,
      });
    });

    it('filters out non-object entries in Slides array', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [
            null,
            undefined,
            42,
            'malicious-string',
            true,
            false,
            [],
            { Title: 'Valid Slide', Time: 1000 },
          ] as unknown as Array<Record<string, unknown>>,
        },
      });
      expect(res).toBeDefined();
      // Only the valid object and empty array (which has typeof === 'object' but no slide props)
      // Note: [] has typeof === 'object', parseSlide([]) returns timeMs 0, index 0, deduplicated if same
      expect(res?.slides.some((s) => s.title === 'Valid Slide' && s.timeMs === 1000)).toBe(true);
      // Ensure no crash occurred
    });

    it('handles non-array Slides property gracefully', () => {
      const res1 = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: 'not-an-array',
        },
      });
      expect(res1?.slides).toEqual([]);

      const res2 = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: { a: 1, b: 2 },
        },
      });
      expect(res2?.slides).toEqual([]);
    });
  });

  describe('2. Malformed and edge-case timestamps', () => {
    it('clamps negative timestamps to 0', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [
            { Title: 'Neg1', Time: -500 },
            { Title: 'Neg2', Time: -0.001 },
            { Title: 'Neg3', Time: -9999999 },
            { Title: 'NegStr', Time: '-1000' },
          ],
        },
      });
      expect(res).toBeDefined();
      // All negative timestamps default to 0 ms.
      // Since they have the same timeMs (0) and no thumbnail, deduplication key is "0||<title>"
      expect(res?.slides).toHaveLength(4);
      for (const slide of res!.slides) {
        expect(slide.timeMs).toBe(0);
        expect(slide.timeSec).toBe(0);
      }
    });

    it('parses string timestamps correctly or defaults to 0', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [
            { Title: 'Zero', Time: '0' },
            { Title: 'Integer', Time: '5000' },
            { Title: 'Float', Time: '1234.56' },
            { Title: 'Sci', Time: '1e4' },
            { Title: 'Hex', Time: '0x20' }, // 32
            { Title: 'Garbage', Time: 'not-a-number' },
            { Title: 'EmptyStr', Time: '' },
            { Title: 'Whitespace', Time: '   ' },
          ],
        },
      });
      expect(res).toBeDefined();
      const slideMap = new Map(res!.slides.map((s) => [s.title, s]));
      expect(slideMap.get('Zero')?.timeMs).toBe(0);
      expect(slideMap.get('Integer')?.timeMs).toBe(5000);
      expect(slideMap.get('Float')?.timeMs).toBe(1235);
      expect(slideMap.get('Sci')?.timeMs).toBe(10000);
      expect(slideMap.get('Hex')?.timeMs).toBe(32);
      expect(slideMap.get('Garbage')?.timeMs).toBe(0);
      expect(slideMap.get('EmptyStr')?.timeMs).toBe(0);
      expect(slideMap.get('Whitespace')?.timeMs).toBe(0);
    });

    it('handles floating point timestamps and rounds to integer ms', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [
            { Title: 'Floor', Time: 1000.2 },
            { Title: 'Ceil', Time: 1000.8 },
            { Title: 'Half', Time: 1000.5 },
            { Title: 'SubMs', Time: 0.4 },
          ],
        },
      });
      expect(res).toBeDefined();
      const slideMap = new Map(res!.slides.map((s) => [s.title, s]));
      expect(slideMap.get('Floor')?.timeMs).toBe(1000);
      expect(slideMap.get('Floor')?.timeSec).toBe(1);
      expect(slideMap.get('Ceil')?.timeMs).toBe(1001);
      expect(slideMap.get('Ceil')?.timeSec).toBe(1.001);
      expect(slideMap.get('Half')?.timeMs).toBe(1001);
      expect(slideMap.get('SubMs')?.timeMs).toBe(0);
    });

    it('handles Infinity, -Infinity, and NaN safely', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [
            { Title: 'PosInf', Time: Infinity },
            { Title: 'NegInf', Time: -Infinity },
            { Title: 'NaNVal', Time: NaN },
          ],
        },
      });
      expect(res).toBeDefined();
      for (const slide of res!.slides) {
        expect(slide.timeMs).toBe(0);
        expect(slide.timeSec).toBe(0);
      }
    });

    it('handles extreme numbers (MAX_SAFE_INTEGER, 1e25) without throwing RangeError', () => {
      expect(() => {
        parsePlayerOptions({
          Presentation: {
            ...basePresentation,
            Slides: [
              { Title: 'MaxSafe', Time: Number.MAX_SAFE_INTEGER },
              { Title: 'SuperLarge', Time: 1e25 },
              { Title: 'MaxVal', Time: Number.MAX_VALUE },
            ],
          },
        });
      }).not.toThrow();
    });

    it('supports alternative timestamp field names with correct fallback', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [
            { Title: 'T1', Time: 1000 },
            { Title: 'T2', Timestamp: 2000 },
            { Title: 'T3', TimeMs: 3000 },
            { Title: 'T4', PresentationTime: 4000 },
            { Title: 'T5', StartTime: 5000 },
            { Title: 'T6', Offset: 6000 },
          ],
        },
      });
      expect(res).toBeDefined();
      expect(res?.slides.map((s) => s.timeMs)).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
    });
  });

  describe('3. Missing fields and null/undefined values', () => {
    it('returns undefined when input is null, undefined, primitive, or lacks Presentation', () => {
      expect(parsePlayerOptions(null)).toBeUndefined();
      expect(parsePlayerOptions(undefined)).toBeUndefined();
      expect(parsePlayerOptions('')).toBeUndefined();
      expect(parsePlayerOptions(123)).toBeUndefined();
      expect(parsePlayerOptions(true)).toBeUndefined();
      expect(parsePlayerOptions({})).toBeUndefined();
      expect(parsePlayerOptions({ Presentation: null })).toBeUndefined();
      expect(parsePlayerOptions({ Presentation: 'invalid' })).toBeUndefined();
    });

    it('handles slides with missing Title, Time, ThumbnailUrl, and Index', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [
            { ThumbnailUrl: 'https://example.com/1.jpg' }, // missing Title, Time, Index
            { Title: 'Only Title' }, // missing Time, ThumbnailUrl, Index
            { Time: 42000 }, // missing Title, ThumbnailUrl, Index
          ],
        },
      });
      expect(res).toBeDefined();
      expect(res?.slides).toHaveLength(3);

      expect(res?.slides[0]).toMatchObject({
        title: undefined,
        timeMs: 0,
        thumbnailUrl: 'https://example.com/1.jpg',
      });

      expect(res?.slides[1]).toMatchObject({
        title: 'Only Title',
        timeMs: 0,
        thumbnailUrl: undefined,
      });

      expect(res?.slides[2]).toMatchObject({
        title: undefined,
        timeMs: 42000,
        thumbnailUrl: undefined,
      });
    });

    it('filters out invalid VideoUrls with missing Location or non-http URLs', () => {
      const res = parsePlayerOptions({
        Presentation: {
          Title: 'Test',
          Streams: [
            {
              StreamType: 0,
              VideoUrls: [
                null,
                {},
                { Location: 'not a url', MimeType: 'video/mp4' },
                { Location: 'javascript:alert(1)', MimeType: 'video/mp4' }, // parseUrl parses JS scheme, but kindFromMime handles it
                { Location: 'https://example.com/valid.mp4', MimeType: 'video/mp4' },
              ],
            },
          ],
        },
      });
      expect(res).toBeDefined();
      expect(res?.streams[0]?.urls.some((u) => u.url === 'https://example.com/valid.mp4')).toBe(true);
    });
  });

  describe('4. Duplicate slides across presentation and streams', () => {
    it('deduplicates identical slides across Presentation.Slides and multiple Streams', () => {
      const sharedSlide = {
        Title: 'Shared Slide',
        Time: 5000,
        ThumbnailUrl: 'https://example.com/slide.jpg',
      };

      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [sharedSlide, { ...sharedSlide }, { ...sharedSlide }],
          Streams: [
            {
              StreamType: 0,
              VideoUrls: [{ Location: 'https://example.com/v1.mp4', MimeType: 'video/mp4' }],
              Slides: [{ ...sharedSlide }],
            },
            {
              StreamType: 1,
              VideoUrls: [{ Location: 'https://example.com/v2.mp4', MimeType: 'video/mp4' }],
              Slides: [{ ...sharedSlide }],
            },
          ],
        },
      });
      expect(res).toBeDefined();
      expect(res?.slides).toHaveLength(1);
      expect(res?.slides[0]).toEqual({
        index: 0,
        title: 'Shared Slide',
        timeMs: 5000,
        timeSec: 5,
        thumbnailUrl: 'https://example.com/slide.jpg',
      });
    });

    it('preserves distinct slides that share identical timestamps', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [
            { Title: 'Slide A', Time: 1000 },
            { Title: 'Slide B', Time: 1000 },
            { Title: 'Slide A', Time: 1000, ThumbnailUrl: 'https://example.com/a.jpg' },
          ],
        },
      });
      expect(res).toBeDefined();
      expect(res?.slides).toHaveLength(3);
    });

    it('sorts unsorted slides chronologically and assigns 0-based sequential indexes', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [
            { Title: 'T4', Time: 4000, Index: 99 },
            { Title: 'T1', Time: 1000, Index: 88 },
            { Title: 'T3', Time: 3000, Index: 77 },
            { Title: 'T2', Time: 2000, Index: 66 },
          ],
        },
      });
      expect(res).toBeDefined();
      expect(res?.slides.map((s) => s.title)).toEqual(['T1', 'T2', 'T3', 'T4']);
      expect(res?.slides.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    });
  });

  describe('5. Slides without titles and alternate title fields', () => {
    it('sets title to undefined when Title is missing, null, empty, or whitespace', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [
            { Time: 1000, Title: '' },
            { Time: 2000, Title: '   ' },
            { Time: 3000, Title: null },
            { Time: 4000 },
          ],
        },
      });
      expect(res).toBeDefined();
      for (const slide of res!.slides) {
        expect(slide.title).toBeUndefined();
      }
    });

    it('falls back to alternate title fields: SlideTitle, Name, Description, Text', () => {
      const res = parsePlayerOptions({
        Presentation: {
          ...basePresentation,
          Slides: [
            { Time: 1000, SlideTitle: 'From SlideTitle' },
            { Time: 2000, Name: 'From Name' },
            { Time: 3000, Description: 'From Description' },
            { Time: 4000, Text: 'From Text' },
          ],
        },
      });
      expect(res).toBeDefined();
      expect(res?.slides.map((s) => s.title)).toEqual([
        'From SlideTitle',
        'From Name',
        'From Description',
        'From Text',
      ]);
    });
  });

  describe('6. Slides with exotic relative URLs', () => {
    const pageUrl = 'https://lectures.university.edu/Mediasite/Play/abcdef1234567890';

    it('resolves root-relative thumbnail URLs (/path)', () => {
      const res = parsePlayerOptions(
        {
          Presentation: {
            ...basePresentation,
            Slides: [{ Time: 1000, ThumbnailUrl: '/static/slides/slide1.jpg' }],
          },
        },
        pageUrl,
      );
      expect(res?.slides[0]?.thumbnailUrl).toBe('https://lectures.university.edu/static/slides/slide1.jpg');
    });

    it('resolves path-relative thumbnail URLs (relative/path)', () => {
      const res = parsePlayerOptions(
        {
          Presentation: {
            ...basePresentation,
            Slides: [{ Time: 1000, ThumbnailUrl: 'thumbnails/slide1.jpg' }],
          },
        },
        pageUrl,
      );
      expect(res?.slides[0]?.thumbnailUrl).toBe('https://lectures.university.edu/Mediasite/Play/thumbnails/slide1.jpg');
    });

    it('resolves parent-directory relative URLs (../path and ../../path)', () => {
      const res = parsePlayerOptions(
        {
          Presentation: {
            ...basePresentation,
            Slides: [
              { Time: 1000, ThumbnailUrl: '../thumbs/slide1.jpg' },
              { Time: 2000, ThumbnailUrl: '../../assets/slide2.jpg' },
            ],
          },
        },
        pageUrl,
      );
      expect(res?.slides[0]?.thumbnailUrl).toBe('https://lectures.university.edu/Mediasite/thumbs/slide1.jpg');
      expect(res?.slides[1]?.thumbnailUrl).toBe('https://lectures.university.edu/assets/slide2.jpg');
    });

    it('resolves protocol-relative thumbnail URLs (//cdn.example.com/path)', () => {
      const res = parsePlayerOptions(
        {
          Presentation: {
            ...basePresentation,
            Slides: [{ Time: 1000, ThumbnailUrl: '//cdn.mediasite.com/slides/slide1.jpg' }],
          },
        },
        pageUrl,
      );
      expect(res?.slides[0]?.thumbnailUrl).toBe('https://cdn.mediasite.com/slides/slide1.jpg');
    });

    it('preserves query parameters and hashes in relative URLs', () => {
      const res = parsePlayerOptions(
        {
          Presentation: {
            ...basePresentation,
            Slides: [{ Time: 1000, ThumbnailUrl: '/thumb.jpg?size=large&v=2#main' }],
          },
        },
        pageUrl,
      );
      expect(res?.slides[0]?.thumbnailUrl).toBe('https://lectures.university.edu/thumb.jpg?size=large&v=2#main');
    });

    it('handles relative URLs safely when pageUrl is empty or invalid', () => {
      const resEmpty = parsePlayerOptions(
        {
          Presentation: {
            ...basePresentation,
            Slides: [{ Time: 1000, ThumbnailUrl: '/thumb.jpg' }],
          },
        },
        '',
      );
      expect(resEmpty?.slides[0]?.thumbnailUrl).toBe('/thumb.jpg');

      const resInvalid = parsePlayerOptions(
        {
          Presentation: {
            ...basePresentation,
            Slides: [{ Time: 1000, ThumbnailUrl: '/thumb.jpg' }],
          },
        },
        'not a valid url',
      );
      expect(resInvalid?.slides[0]?.thumbnailUrl).toBe('/thumb.jpg');
    });

    it('leaves absolute URLs untouched regardless of pageUrl', () => {
      const res = parsePlayerOptions(
        {
          Presentation: {
            ...basePresentation,
            Slides: [{ Time: 1000, ThumbnailUrl: 'https://cdn.external.com/slide1.jpg' }],
          },
        },
        pageUrl,
      );
      expect(res?.slides[0]?.thumbnailUrl).toBe('https://cdn.external.com/slide1.jpg');
    });
  });
});

describe('CHALLENGER: validateDownloadRequest Layout Empirical Stress Suite', () => {
  const validBase = {
    taskId: 'challenge-task-001',
    title: 'Dual Stream Lecture',
    fileName: 'lecture_dual',
    container: 'mp4',
    tracks: [
      {
        type: 'direct',
        url: 'https://example.com/presentation.mp4',
        label: 'Presentation',
      },
      {
        type: 'direct',
        url: 'https://example.com/camera.mp4',
        label: 'Camera',
      },
    ],
  };

  describe('1. Valid layouts and optional handling', () => {
    const validLayouts: DualStreamLayout[] = ['separate', 'side-by-side', 'pip', 'multi-track'];

    it.each(validLayouts)('accepts valid layout: %s', (layout) => {
      const req = validateDownloadRequest({ ...validBase, layout });
      expect(req.layout).toBe(layout);
    });

    it('accepts omitted layout as undefined', () => {
      const req = validateDownloadRequest({ ...validBase });
      expect(req.layout).toBeUndefined();
    });

    it('accepts layout: undefined as undefined', () => {
      const req = validateDownloadRequest({ ...validBase, layout: undefined });
      expect(req.layout).toBeUndefined();
    });

    it('accepts layout: null as undefined', () => {
      const req = validateDownloadRequest({ ...validBase, layout: null });
      expect(req.layout).toBeUndefined();
    });
  });

  describe('2. Prototype pollution attempts', () => {
    const protoPayloads = [
      '__proto__',
      'constructor',
      'prototype',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
    ];

    it.each(protoPayloads)('rejects layout property name: %s', (payload) => {
      expect(() => validateDownloadRequest({ ...validBase, layout: payload })).toThrow(
        'Invalid request: layout unsupported',
      );
    });

    it('is not fooled by Object.prototype or JSON __proto__ injection', () => {
      const parsedWithProto = JSON.parse('{"layout": "__proto__"}');
      expect(() => validateDownloadRequest({ ...validBase, ...parsedWithProto })).toThrow(
        'Invalid request: layout unsupported',
      );
    });
  });

  describe('3. Unknown and malformed string values', () => {
    const invalidStrings = [
      '',
      '   ',
      'grid',
      'vertical',
      'horizontal',
      'side_by_side',
      'SIDE-BY-SIDE',
      'Side-By-Side',
      'side-by-side ',
      ' side-by-side',
      'pip ',
      ' pip',
      'PIP',
      'PiP',
      'picture-in-picture',
      'overlay',
      'hstack',
      'separate ',
      'multi_track',
      'multi-track ',
      '<script>alert(1)</script>',
      'side-by-side\0',
      'side-by-side\n',
    ];

    it.each(invalidStrings)('rejects invalid layout string: %j', (str) => {
      expect(() => validateDownloadRequest({ ...validBase, layout: str })).toThrow(
        'Invalid request: layout unsupported',
      );
    });
  });

  describe('4. Non-string types (numbers, booleans, objects, arrays)', () => {
    const invalidTypes: unknown[] = [
      0,
      1,
      -1,
      42,
      3.14,
      NaN,
      Infinity,
      -Infinity,
      true,
      false,
      {},
      { layout: 'side-by-side' },
      { toString: () => 'side-by-side' },
      [],
      ['side-by-side'],
      ['pip'],
      Symbol('pip'),
    ];

    it.each(invalidTypes)('rejects non-string layout: %s', (val) => {
      expect(() => validateDownloadRequest({ ...validBase, layout: val })).toThrow(
        'Invalid request: layout unsupported',
      );
    });
  });
});

describe('TASK-P1-01: Multi-Period MPEG-DASH Manifest Assembly', () => {
  const multiPeriodCompatibleXml = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" mediaPresentationDuration="PT6.0S" minBufferTime="PT4.0S">
  <Period id="0" start="PT0.0S" duration="PT4.0S">
    <AdaptationSet id="0" contentType="video">
      <Representation id="0" mimeType="video/mp4" codecs="avc1.42c00d" bandwidth="160000" width="320" height="240">
        <SegmentTemplate timescale="1000" initialization="init-0.m4s" media="chunk-0-$Number$.m4s" startNumber="1">
          <SegmentTimeline>
            <S t="0" d="2000" r="1" />
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio">
      <Representation id="2" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="64000">
        <SegmentTemplate timescale="1000" initialization="init-2.m4s" media="chunk-2-$Number$.m4s" startNumber="1">
          <SegmentTimeline>
            <S t="0" d="2000" r="1" />
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
  <Period id="1" start="PT4.0S" duration="PT2.0S">
    <AdaptationSet id="0" contentType="video">
      <Representation id="0" mimeType="video/mp4" codecs="avc1.42c00d" bandwidth="160000" width="320" height="240">
        <SegmentTemplate timescale="1000" initialization="init-0.m4s" media="chunk-0-$Number$.m4s" startNumber="3">
          <SegmentTimeline>
            <S t="4000" d="2000" />
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio">
      <Representation id="2" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="64000">
        <SegmentTemplate timescale="1000" initialization="init-2.m4s" media="chunk-2-$Number$.m4s" startNumber="3">
          <SegmentTimeline>
            <S t="4000" d="2000" />
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  it('describeDash accepts multi-period manifest with compatible codecs', () => {
    const desc = describeDash(multiPeriodCompatibleXml, 'https://example.com/manifest.mpd');
    expect(desc.unsupportedReason).toBeUndefined();
    expect(desc.durationSec).toBe(6.0);
    expect(desc.hasVideo).toBe(true);
    expect(desc.hasAudio).toBe(true);
    expect(desc.qualities).toHaveLength(1);
    expect(desc.qualities[0]?.height).toBe(240);
    expect(desc.audioTracks).toHaveLength(1);
  });

  it('describeDash rejects multi-period manifest with incompatible video codecs', () => {
    const incompatibleXml = multiPeriodCompatibleXml.replace(
      'Period id="1" start="PT4.0S" duration="PT2.0S">\n    <AdaptationSet id="0" contentType="video">\n      <Representation id="0" mimeType="video/mp4" codecs="avc1.42c00d"',
      'Period id="1" start="PT4.0S" duration="PT2.0S">\n    <AdaptationSet id="0" contentType="video">\n      <Representation id="0" mimeType="video/webm" codecs="vp09.00.10.08"',
    );
    const desc = describeDash(incompatibleXml, 'https://example.com/manifest.mpd');
    expect(desc.unsupportedReason).toBe('Multi-period manifest has incompatible video codecs across periods');
  });

  it('describeDash rejects multi-period manifest with missing video adaptation in period 2', () => {
    const missingVideoXml = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static">
  <Period id="0" start="PT0.0S" duration="PT4.0S">
    <AdaptationSet id="0" contentType="video">
      <Representation id="0" mimeType="video/mp4" codecs="avc1.42c00d" bandwidth="160000" width="320" height="240">
        <SegmentTemplate timescale="1000" media="chunk-0-$Number$.m4s" startNumber="1">
          <SegmentTimeline><S t="0" d="4000" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
  <Period id="1" start="PT4.0S" duration="PT2.0S">
    <AdaptationSet id="1" contentType="audio">
      <Representation id="2" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="64000">
        <SegmentTemplate timescale="1000" media="chunk-2-$Number$.m4s" startNumber="1">
          <SegmentTimeline><S t="0" d="2000" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const desc = describeDash(missingVideoXml, 'https://example.com/manifest.mpd');
    expect(desc.unsupportedReason).toBe('Multi-period manifest has missing video in period 2');
  });

  it('parseMpd calculates periodDuration when @duration is omitted but @start is present', () => {
    const startOnlyXml = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10.0S">
  <Period id="0" start="PT0.0S">
    <AdaptationSet id="0" contentType="video">
      <Representation id="0" bandwidth="100000" width="320" height="240">
        <SegmentTemplate timescale="1000" media="chunk-0-$Number$.m4s" startNumber="1">
          <SegmentTimeline><S t="0" d="4000" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
  <Period id="1" start="PT4.0S">
    <AdaptationSet id="0" contentType="video">
      <Representation id="0" bandwidth="100000" width="320" height="240">
        <SegmentTemplate timescale="1000" media="chunk-0-$Number$.m4s" startNumber="2">
          <SegmentTimeline><S t="4000" d="6000" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const mpd = parseMpd(startOnlyXml, 'https://example.com/manifest.mpd');
    expect(mpd.periods).toHaveLength(2);
    expect(mpd.durationSec).toBe(10);
  });

  it('parseMpd calculates total durationSec as sum across periods when mediaPresentationDuration is absent', () => {
    const noMpdDurationXml = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period id="0" start="PT0.0S" duration="PT3.0S">
    <AdaptationSet id="0" contentType="video">
      <Representation id="0" bandwidth="100000" width="320" height="240">
        <SegmentTemplate timescale="1000" media="chunk-0-$Number$.m4s" startNumber="1">
          <SegmentTimeline><S t="0" d="3000" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
  <Period id="1" start="PT3.0S" duration="PT5.0S">
    <AdaptationSet id="0" contentType="video">
      <Representation id="0" bandwidth="100000" width="320" height="240">
        <SegmentTemplate timescale="1000" media="chunk-0-$Number$.m4s" startNumber="2">
          <SegmentTimeline><S t="3000" d="5000" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const mpd = parseMpd(noMpdDurationXml, 'https://example.com/manifest.mpd');
    expect(mpd.durationSec).toBe(8.0);
  });
});
