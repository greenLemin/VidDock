import { describe, expect, it } from 'vitest';
import { validateDownloadRequest } from '../src/protocol.ts';
import type { DualStreamLayout } from '../src/types.ts';

describe('validateDownloadRequest', () => {
  const baseRequest = {
    taskId: 'task-1234_abc',
    title: 'Lecture Video',
    fileName: 'lecture_video',
    container: 'mp4',
    tracks: [
      {
        type: 'direct',
        url: 'https://example.com/video.mp4',
        label: 'Video',
      },
    ],
    subtitles: [],
    subtitleMode: 'none',
    headers: {},
    options: {
      segmentConcurrency: 4,
      maxRetries: 3,
      retryBaseMs: 500,
    },
  };

  it('accepts a valid request without layout', () => {
    const validated = validateDownloadRequest(baseRequest);
    expect(validated.taskId).toBe('task-1234_abc');
    expect(validated.container).toBe('mp4');
    expect(validated.layout).toBeUndefined();
  });

  const validLayouts: DualStreamLayout[] = ['separate', 'side-by-side', 'pip', 'multi-track'];
  it.each(validLayouts)('accepts valid layout: %s', (layout) => {
    const validated = validateDownloadRequest({ ...baseRequest, layout });
    expect(validated.layout).toBe(layout);
  });

  it('rejects unsupported string layout values', () => {
    expect(() => validateDownloadRequest({ ...baseRequest, layout: 'grid' })).toThrow(
      'Invalid request: layout unsupported',
    );
    expect(() => validateDownloadRequest({ ...baseRequest, layout: 'vertical' })).toThrow(
      'Invalid request: layout unsupported',
    );
    expect(() => validateDownloadRequest({ ...baseRequest, layout: 'unknown' })).toThrow(
      'Invalid request: layout unsupported',
    );
  });

  it('rejects non-string layout values', () => {
    expect(() => validateDownloadRequest({ ...baseRequest, layout: 123 })).toThrow(
      'Invalid request: layout unsupported',
    );
    expect(() => validateDownloadRequest({ ...baseRequest, layout: {} })).toThrow(
      'Invalid request: layout unsupported',
    );
  });

  it('rejects invalid taskId characters', () => {
    expect(() => validateDownloadRequest({ ...baseRequest, taskId: 'bad task!' })).toThrow(
      'Invalid request: taskId has illegal characters',
    );
  });

  it('rejects empty tracks array', () => {
    expect(() => validateDownloadRequest({ ...baseRequest, tracks: [] })).toThrow(
      'Invalid request: tracks must have 1..8 entries',
    );
  });

  it('rejects unsupported container', () => {
    expect(() => validateDownloadRequest({ ...baseRequest, container: 'avi' })).toThrow(
      'Invalid request: container unsupported',
    );
  });

  it('validates subtitles and subtitleMode', () => {
    const withSubs = {
      ...baseRequest,
      subtitles: [{ url: 'https://example.com/subs.vtt', language: 'en', label: 'English' }],
      subtitleMode: 'embed',
    };
    const validated = validateDownloadRequest(withSubs);
    expect(validated.subtitleMode).toBe('embed');
    expect(validated.subtitles).toHaveLength(1);
    expect(validated.subtitles[0]?.language).toBe('en');
  });

  describe('segmentToleranceRate and live options validation', () => {
    it('accepts valid segmentToleranceRate numbers', () => {
      const v1 = validateDownloadRequest({
        ...baseRequest,
        options: { ...baseRequest.options, segmentToleranceRate: 0.05 },
      });
      expect(v1.options.segmentToleranceRate).toBe(0.05);

      const v2 = validateDownloadRequest({
        ...baseRequest,
        options: { ...baseRequest.options, segmentToleranceRate: 0 },
      });
      expect(v2.options.segmentToleranceRate).toBe(0);

      const v3 = validateDownloadRequest({
        ...baseRequest,
        options: { ...baseRequest.options, segmentToleranceRate: 1 },
      });
      expect(v3.options.segmentToleranceRate).toBe(1);
    });

    it('defaults segmentToleranceRate to 0.02 when omitted', () => {
      const validated = validateDownloadRequest(baseRequest);
      expect(validated.options.segmentToleranceRate).toBe(0.02);
    });

    it('rejects invalid segmentToleranceRate values', () => {
      expect(() =>
        validateDownloadRequest({
          ...baseRequest,
          options: { ...baseRequest.options, segmentToleranceRate: -0.01 },
        }),
      ).toThrow('Invalid request: segmentToleranceRate must be a number between 0 and 1');

      expect(() =>
        validateDownloadRequest({
          ...baseRequest,
          options: { ...baseRequest.options, segmentToleranceRate: 1.5 },
        }),
      ).toThrow('Invalid request: segmentToleranceRate must be a number between 0 and 1');

      expect(() =>
        validateDownloadRequest({
          ...baseRequest,
          options: { ...baseRequest.options, segmentToleranceRate: 'fast' as unknown as number },
        }),
      ).toThrow('Invalid request: segmentToleranceRate must be a number between 0 and 1');
    });

    it('validates liveMode and liveDurationSeconds', () => {
      const v = validateDownloadRequest({
        ...baseRequest,
        options: { ...baseRequest.options, liveMode: 'duration', liveDurationSeconds: 60 },
      });
      expect(v.options.liveMode).toBe('duration');
      expect(v.options.liveDurationSeconds).toBe(60);

      expect(() =>
        validateDownloadRequest({
          ...baseRequest,
          options: { ...baseRequest.options, liveMode: 'invalid' as unknown as 'dvr' },
        }),
      ).toThrow('Invalid request: invalid liveMode');
    });
  });
});
