/** Filename sanitization and templating. */

const RESERVED_WIN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function truncateBytes(value: string, maxBytes: number): string {
  const enc = new TextEncoder();
  let out = '';
  let bytes = 0;
  for (const ch of value) {
    const n = enc.encode(ch).length;
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** Produce a safe, portable file *base name* (no directory separators, no extension handling). */
export function sanitizeFilename(input: string, maxBytes = 180): string {
  let s = String(input ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\.\.+/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^[.\s_-]+/, '').replace(/[.\s]+$/, '');
  s = truncateBytes(s, maxBytes).replace(/[.\s]+$/, '');
  if (!s || RESERVED_WIN.test(s)) s = s ? `_${s}` : 'video';
  return s;
}

export interface TemplateVars {
  title: string;
  quality?: string;
  site?: string;
  id?: string;
  track?: string;
  date?: Date;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function applyFilenameTemplate(template: string, vars: TemplateVars): string {
  const d = vars.date ?? new Date();
  const map: Record<string, string> = {
    title: vars.title,
    quality: vars.quality ?? '',
    site: vars.site ?? '',
    id: vars.id ?? '',
    track: vars.track ?? '',
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`,
  };
  const out = (template || '{title}').replace(/\{(\w+)\}/g, (_m, key: string) => map[key] ?? '');
  const cleaned = out
    .replace(/\s*[-_]\s*[-_]\s*/g, ' - ')
    .replace(/[\s_-]+$/, '')
    .trim();
  return sanitizeFilename(cleaned || vars.title);
}

/** Make `base.ext` unique given a predicate telling whether a name already exists. */
export function uniqueName(base: string, ext: string, exists: (name: string) => boolean): string {
  let name = `${base}.${ext}`;
  let i = 1;
  while (exists(name)) {
    i += 1;
    name = `${base} (${i}).${ext}`;
  }
  return name;
}
