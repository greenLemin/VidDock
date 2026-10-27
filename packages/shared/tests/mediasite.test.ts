import { describe, expect, it } from 'vitest';
import {
  deriveHlsFromSmooth,
  isMediasiteUrl,
  kindFromMime,
  mediasitePresentationId,
  parsePlayerOptions,
} from '../src/mediasite.ts';

describe('mediasite url helpers', () => {
  it('correctly identifies mediasite playback urls', () => {
    expect(isMediasiteUrl('https://myuni.mediasite.com/Mediasite/Play/abcdef1234567890abcdef12345678901d')).toBe(true);
    expect(isMediasiteUrl('https://example.com/mediasite/show')).toBe(true);
    expect(isMediasiteUrl('https://youtube.com/watch?v=123')).toBe(false);
    expect(isMediasiteUrl('not-a-url')).toBe(false);
  });

  it('extracts presentation id from playback url', () => {
    const id = 'abcdef1234567890abcdef12345678901d';
    const url = `https://myuni.mediasite.com/Mediasite/Play/${id}`;
    expect(mediasitePresentationId(url)).toBe(id);
    expect(mediasitePresentationId('https://myuni.mediasite.com/Mediasite/Catalog')).toBeUndefined();
    expect(mediasitePresentationId('invalid-url')).toBeUndefined();
  });

  it('derives hls manifest url from smooth streaming url', () => {
    const ism = 'https://media.mediasite.com/stream.ism/manifest';
    expect(deriveHlsFromSmooth(ism)).toBe('https://media.mediasite.com/stream.ism/manifest(format=m3u8-aapl)');

    const ismWithFormat = 'https://media.mediasite.com/stream.ism/manifest(format=mpd-time-csf)';
    expect(deriveHlsFromSmooth(ismWithFormat)).toBe(
      'https://media.mediasite.com/stream.ism/manifest(format=m3u8-aapl)',
    );
  });

  it('detects media kind from mime type and url', () => {
    expect(kindFromMime('application/vnd.apple.mpegurl', 'https://example.com/stream.m3u8')).toBe('hls');
    expect(kindFromMime('application/dash+xml', 'https://example.com/manifest.mpd')).toBe('dash');
    expect(kindFromMime('application/vnd.ms-sstr+xml', 'https://example.com/stream.ism/manifest')).toBe('smooth');
    expect(kindFromMime('video/mp4', 'https://example.com/video.mp4')).toBe('direct');
    expect(kindFromMime('unknown/type', 'https://example.com/video.webm')).toBe('direct');
    expect(kindFromMime('unknown/type', 'https://example.com/unknown')).toBeUndefined();
  });
});

describe('mediasite slide parsing (parsePlayerOptions)', () => {
  it('returns undefined for invalid inputs', () => {
    expect(parsePlayerOptions(null)).toBeUndefined();
    expect(parsePlayerOptions({})).toBeUndefined();
    expect(parsePlayerOptions('not json')).toBeUndefined();
  });

  it('extracts slides from Presentation.Slides with timestamps, titles, and thumbnails', () => {
    const json = {
      Presentation: {
        Id: 'abcdef1234567890abcdef12345678901d',
        Title: 'Introduction to Distributed Systems',
        Duration: 3600000,
        Streams: [
          {
            StreamType: 0,
            VideoUrls: [{ Location: 'https://media.example.com/video.mp4', MimeType: 'video/mp4' }],
          },
        ],
        Slides: [
          {
            Title: 'Lecture Overview',
            Time: 0,
            ThumbnailUrl: 'https://media.example.com/slides/slide0.jpg',
          },
          {
            SlideTitle: 'CAP Theorem',
            Timestamp: 120500,
            ThumbnailLocation: 'https://media.example.com/slides/slide1.jpg',
          },
        ],
      },
    };

    const res = parsePlayerOptions(json);
    expect(res).toBeDefined();
    expect(res?.title).toBe('Introduction to Distributed Systems');
    expect(res?.durationSec).toBe(3600);
    expect(res?.slides).toHaveLength(2);

    expect(res?.slides[0]).toEqual({
      index: 0,
      title: 'Lecture Overview',
      timeMs: 0,
      timeSec: 0,
      thumbnailUrl: 'https://media.example.com/slides/slide0.jpg',
    });

    expect(res?.slides[1]).toEqual({
      index: 1,
      title: 'CAP Theorem',
      timeMs: 120500,
      timeSec: 120.5,
      thumbnailUrl: 'https://media.example.com/slides/slide1.jpg',
    });
  });

  it('extracts slides from stream.Slides and sorts chronologically', () => {
    const json = {
      Presentation: {
        Title: 'Physics 101',
        Streams: [
          {
            StreamType: 1,
            VideoUrls: [{ Location: 'https://media.example.com/camera.mp4', MimeType: 'video/mp4' }],
            Slides: [
              { Name: 'Later Slide', TimeMs: 30000, Thumbnail: 'https://example.com/late.jpg' },
              { Name: 'Earlier Slide', TimeMs: 5000, Thumbnail: 'https://example.com/early.jpg' },
            ],
          },
        ],
      },
    };

    const res = parsePlayerOptions(json);
    expect(res).toBeDefined();
    expect(res?.slides).toHaveLength(2);
    // Should be sorted ascending by timeMs
    expect(res?.slides[0]?.title).toBe('Earlier Slide');
    expect(res?.slides[0]?.index).toBe(0);
    expect(res?.slides[1]?.title).toBe('Later Slide');
    expect(res?.slides[1]?.index).toBe(1);
  });

  it('deduplicates slides present in both Presentation.Slides and Stream.Slides', () => {
    const slide = {
      Title: 'Duplicate Slide',
      Time: 10000,
      ThumbnailUrl: 'https://media.example.com/slides/shared.jpg',
    };

    const json = {
      Presentation: {
        Title: 'Math 200',
        Slides: [slide],
        Streams: [
          {
            StreamType: 0,
            VideoUrls: [{ Location: 'https://media.example.com/stream.mp4', MimeType: 'video/mp4' }],
            Slides: [slide],
          },
        ],
      },
    };

    const res = parsePlayerOptions(json);
    expect(res?.slides).toHaveLength(1);
    expect(res?.slides[0]?.title).toBe('Duplicate Slide');
  });

  it('resolves relative thumbnail URLs against pageUrl', () => {
    const json = {
      Presentation: {
        Title: 'Biology 101',
        Streams: [
          {
            VideoUrls: [{ Location: 'https://media.example.com/vid.mp4', MimeType: 'video/mp4' }],
          },
        ],
        Slides: [
          {
            Title: 'Cell Structure',
            Time: 5000,
            ThumbnailUrl: '/assets/thumbnails/slide1.png',
          },
        ],
      },
    };

    const pageUrl = 'https://lectures.university.edu/mediasite/Play/presentation123';
    const res = parsePlayerOptions(json, pageUrl);
    expect(res?.slides[0]?.thumbnailUrl).toBe('https://lectures.university.edu/assets/thumbnails/slide1.png');
  });

  it('handles slide-only streams correctly', () => {
    const json = {
      Presentation: {
        Title: 'Keynote Presentation',
        Streams: [
          {
            StreamType: 2,
            VideoUrls: [],
            Slides: [{ Title: 'Title Card', Time: 0, Url: 'https://example.com/t.png' }],
          },
        ],
      },
    };

    const res = parsePlayerOptions(json);
    expect(res).toBeDefined();
    expect(res?.streams).toHaveLength(1);
    expect(res?.streams[0]?.slidesOnly).toBe(true);
    expect(res?.streams[0]?.label).toBe('Slides');
    expect(res?.slides).toHaveLength(1);
  });

  it('extracts presenters and captions', () => {
    const json = {
      Presentation: {
        Title: 'Chemistry 300',
        Presenters: [{ FirstName: 'Jane', LastName: 'Doe' }, { DisplayName: 'Dr. Smith' }],
        Transcripts: [{ Url: 'https://example.com/captions.vtt', Language: 'en', Name: 'English CC' }],
        Streams: [{ VideoUrls: [{ Location: 'https://example.com/chem.mp4', MimeType: 'video/mp4' }] }],
      },
    };

    const res = parsePlayerOptions(json);
    expect(res?.presenters).toEqual(['Jane Doe', 'Dr. Smith']);
    expect(res?.captions).toEqual([{ url: 'https://example.com/captions.vtt', language: 'en', label: 'English CC' }]);
  });

  it('extracts decoupled audio streams from StreamType 2 and AudioUrls', () => {
    const json = {
      Presentation: {
        Title: 'Lecture with Decoupled Audio',
        Streams: [
          {
            StreamType: 0,
            VideoUrls: [{ Location: 'https://example.com/cam.mp4', MimeType: 'video/mp4' }],
          },
          {
            StreamType: 1,
            VideoUrls: [{ Location: 'https://example.com/slides.mp4', MimeType: 'video/mp4' }],
          },
          {
            StreamType: 2,
            AudioUrls: [{ Location: 'https://example.com/mic.m4a', MimeType: 'audio/mp4' }],
          },
        ],
      },
    };

    const res = parsePlayerOptions(json);
    expect(res).toBeDefined();
    expect(res?.streams).toHaveLength(3);
    const audioStream = res?.streams.find((s) => s.streamType === 2);
    expect(audioStream).toBeDefined();
    expect(audioStream?.label).toBe('Audio');
    expect(audioStream?.urls[0]?.url).toBe('https://example.com/mic.m4a');
  });

  it('extracts decoupled audio from Presentation.AudioUrls', () => {
    const json = {
      Presentation: {
        Title: 'Presentation AudioUrls',
        Streams: [
          {
            StreamType: 0,
            VideoUrls: [{ Location: 'https://example.com/cam.mp4', MimeType: 'video/mp4' }],
          },
        ],
        AudioUrls: [{ Location: 'https://example.com/audio.aac', MimeType: 'audio/aac' }],
      },
    };

    const res = parsePlayerOptions(json);
    expect(res).toBeDefined();
    expect(res?.streams).toHaveLength(2);
    const audioStream = res?.streams.find((s) => s.streamType === 2);
    expect(audioStream).toBeDefined();
    expect(audioStream?.label).toBe('Audio');
    expect(audioStream?.urls[0]?.url).toBe('https://example.com/audio.aac');
  });

  it('extracts decoupled audio from singular Presentation.AudioUrl', () => {
    const json = {
      Presentation: {
        Title: 'Singular AudioUrl Presentation',
        Streams: [
          {
            StreamType: 0,
            VideoUrls: [{ Location: 'https://example.com/cam.mp4', MimeType: 'video/mp4' }],
          },
        ],
        AudioUrl: { Location: 'https://example.com/audio_singular.m4a' },
      },
    };

    const res = parsePlayerOptions(json);
    expect(res).toBeDefined();
    expect(res?.streams).toHaveLength(2);
    const audioStream = res?.streams.find((s) => s.streamType === 2);
    expect(audioStream).toBeDefined();
    expect(audioStream?.label).toBe('Audio');
    expect(audioStream?.urls[0]?.url).toBe('https://example.com/audio_singular.m4a');
    expect(audioStream?.urls[0]?.kind).toBe('direct');
  });

  it('kindFromMime correctly identifies direct audio formats without mime type', () => {
    expect(kindFromMime('', 'https://example.com/track.m4a')).toBe('direct');
    expect(kindFromMime('', 'https://example.com/track.aac')).toBe('direct');
    expect(kindFromMime('', 'https://example.com/track.mp3')).toBe('direct');
    expect(kindFromMime('', 'https://example.com/track.flac')).toBe('direct');
  });

  it('identifies audio stream from AudioUrls with empty mimeType and defaults mime to audio/mp4', () => {
    const json = {
      Presentation: {
        Title: 'Missing MIME audio',
        Streams: [
          {
            StreamType: 0,
            VideoUrls: [{ Location: 'https://example.com/cam.mp4', MimeType: 'video/mp4' }],
          },
          {
            AudioUrls: [{ Location: 'https://example.com/mic_nomime.m4a' }],
          },
        ],
      },
    };

    const res = parsePlayerOptions(json);
    expect(res).toBeDefined();
    expect(res?.streams).toHaveLength(2);
    const audioStream = res?.streams.find((s) => s.streamType === 2);
    expect(audioStream).toBeDefined();
    expect(audioStream?.label).toBe('Audio');
    expect(audioStream?.urls[0]?.mimeType).toBe('audio/mp4');
  });

  it('identifies audio stream from stream with audio extension when StreamType is omitted', () => {
    const json = {
      Presentation: {
        Title: 'Audio extension only',
        Streams: [
          {
            VideoUrls: [{ Location: 'https://example.com/cam.mp4', MimeType: 'video/mp4' }],
          },
          {
            VideoUrls: [{ Location: 'https://example.com/lecture_mic.mp3' }],
          },
        ],
      },
    };

    const res = parsePlayerOptions(json);
    expect(res).toBeDefined();
    expect(res?.streams).toHaveLength(2);
    const audioStream = res?.streams.find((s) => s.streamType === 2);
    expect(audioStream).toBeDefined();
    expect(audioStream?.label).toBe('Audio');
  });
});
