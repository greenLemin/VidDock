/** Quality labelling and selection. */
import type { Quality } from './types.ts';

export function qualityLabel(height?: number, bandwidth?: number, frameRate?: number): string {
  if (height) {
    const fps = frameRate && frameRate > 30 ? `${Math.round(frameRate)}` : '';
    return `${height}p${fps}`;
  }
  if (bandwidth) return `${Math.round(bandwidth / 1000)} kbps`;
  return 'Original';
}

/** Highest first (by height, then bandwidth). */
export function sortQualities<T extends Pick<Quality, 'height' | 'bandwidth'>>(list: T[]): T[] {
  return [...list].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
}

/** Remove duplicate (height,bandwidth) entries keeping the first. */
export function dedupeQualities<T extends Pick<Quality, 'height' | 'bandwidth' | 'codecs'>>(list: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const q of list) {
    const key = `${q.height ?? 0}|${q.bandwidth ?? 0}|${q.codecs ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/**
 * Choose a quality: 'best' = highest; a number = the highest quality with height <= wanted,
 * else the lowest available above it. Never fabricates a quality that does not exist.
 */
export function pickQuality<T extends Pick<Quality, 'height' | 'bandwidth'>>(
  qualities: T[],
  preferred: 'best' | number,
): T | undefined {
  if (qualities.length === 0) return undefined;
  const sorted = sortQualities(qualities);
  if (preferred === 'best') return sorted[0];
  const atOrBelow = sorted.find((q) => (q.height ?? 0) > 0 && (q.height ?? 0) <= preferred);
  if (atOrBelow) return atOrBelow;
  const withHeight = sorted.filter((q) => (q.height ?? 0) > 0);
  if (withHeight.length > 0) return withHeight[withHeight.length - 1];
  return sorted[0];
}
