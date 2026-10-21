import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Native messaging stdio framing: 4-byte native-endian length + UTF-8 JSON. */
export const MAX_INCOMING = 64 * 1024 * 1024; // extension -> host may be large (Chrome allows 4 GiB); we cap at 64 MiB
export const MAX_OUTGOING = 1024 * 1024 - 1024; // host -> extension hard limit is 1 MiB

export function encodeMessage(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (body.length > MAX_OUTGOING) throw new Error('Outgoing message exceeds the 1 MiB native messaging limit');
  const header = Buffer.alloc(4);
  if (os.endianness() === 'LE') header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder: push chunks, receive complete messages via callback. */
export class MessageDecoder {
  private buf: Buffer = Buffer.alloc(0);
  constructor(
    private readonly onMessage: (msg: unknown) => void,
    private readonly onError: (err: Error) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 4) return;
      const len = os.endianness() === 'LE' ? this.buf.readUInt32LE(0) : this.buf.readUInt32BE(0);
      if (len > MAX_INCOMING) {
        this.onError(new Error(`Incoming message too large (${len} bytes)`));
        this.buf = Buffer.alloc(0);
        return;
      }
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      try {
        this.onMessage(JSON.parse(body.toString('utf8')));
      } catch (e) {
        this.onError(e as Error);
      }
    }
  }
}

export function appHome(): string {
  if (process.env.VIDDOCK_HOME) return process.env.VIDDOCK_HOME;
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'VidDock');
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'VidDock');
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'viddock');
  }
}

export function defaultOutputDir(): string {
  return process.env.VIDDOCK_OUTPUT_DIR ?? path.join(os.homedir(), 'Downloads', 'VidDock');
}

/** Roots under which output may be written: the user's home dir (plus explicit test override). */
function allowedRoots(): string[] {
  const roots = [os.homedir()];
  if (process.env.VIDDOCK_ALLOWED_ROOT) roots.push(process.env.VIDDOCK_ALLOWED_ROOT);
  return roots.map((r) => safeRealpath(r));
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class PathError extends Error {
  readonly code = 'PATH_ERROR';
}

/** Resolve and create the output dir; reject anything outside the allowed roots (incl. via symlinks). */
export function resolveOutputDir(requested: string | undefined): string {
  let dir = requested && requested.trim() ? requested.trim() : defaultOutputDir();
  if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
  if (!path.isAbsolute(dir)) throw new PathError('Output directory must be an absolute path');
  if (dir.includes('\0')) throw new PathError('Output directory contains a NUL byte');
  dir = path.resolve(dir);
  // Walk up to the deepest existing ancestor and resolve symlinks there.
  let existing = dir;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = safeRealpath(existing);
  const real = path.join(realExisting, path.relative(existing, dir));
  if (!allowedRoots().some((r) => isInside(real, r))) {
    throw new PathError('Output directory must be inside your home folder');
  }
  try {
    fs.mkdirSync(real, { recursive: true });
    fs.accessSync(real, fs.constants.W_OK);
  } catch (e) {
    throw new PathError(`Cannot write to output directory: ${(e as Error).message}`);
  }
  return real;
}

/** Only files inside allowed roots may be opened/revealed. */
export function validateExistingFile(p: string): string {
  if (typeof p !== 'string' || p.includes('\0') || !path.isAbsolute(p)) throw new PathError('Invalid path');
  const real = safeRealpath(p);
  if (!fs.existsSync(real)) throw new PathError('File no longer exists');
  if (!allowedRoots().some((r) => isInside(real, r))) throw new PathError('Path outside allowed folders');
  return real;
}
