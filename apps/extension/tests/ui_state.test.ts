import { describe, expect, it } from 'vitest';
import { applyFilenameTemplate } from '@viddock/shared';
import { formatBytes, formatDuration, formatEta, formatSpeed } from '../src/ui/formatters.ts';

describe('UI State & Formatter Tests', () => {
  it('formats byte quantities into human-readable units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1572864)).toBe('1.5 MB');
    expect(formatBytes(1073741824)).toBe('1.0 GB');
    expect(formatBytes(5368709120)).toBe('5.0 GB');
  });

  it('formats transfer rates (bytes/second)', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
    expect(formatSpeed(1048576)).toBe('1.0 MB/s');
    expect(formatSpeed(8800000)).toBe('8.4 MB/s');
  });

  it('formats durations into HH:MM:SS or MM:SS', () => {
    expect(formatDuration(0)).toBe('--:--');
    expect(formatDuration(45)).toBe('00:45');
    expect(formatDuration(125)).toBe('02:05');
    expect(formatDuration(3665)).toBe('1:01:05');
    expect(formatDuration(7200)).toBe('2:00:00');
  });

  it('formats remaining ETA times', () => {
    expect(formatEta(undefined)).toBe('');
    expect(formatEta(0)).toBe('');
    expect(formatEta(25000)).toBe('25s remaining');
    expect(formatEta(95000)).toBe('1m 35s remaining');
    expect(formatEta(3720000)).toBe('1h 2m remaining');
  });

  it('applies filename template tokens correctly', () => {
    const template = '{title} - {quality} [{site}]';
    const result = applyFilenameTemplate(template, {
      title: 'Intro to Algorithms',
      quality: '1080p',
      site: 'university.edu',
    });
    expect(result).toBe('Intro to Algorithms - 1080p [university.edu]');

    const dateTemplate = '{title} ({date})';
    const dateResult = applyFilenameTemplate(dateTemplate, {
      title: 'Lecture 1',
      date: new Date('2026-10-21T12:00:00Z'),
    });
    expect(dateResult).toContain('Lecture 1 (2026-10-21');
  });
});
