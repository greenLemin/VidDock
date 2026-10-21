import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { backoffDelay, isRetryableStatus, parseRetryAfter } from '@viddock/shared';
import type { DownloadOptions, RequestHeaders } from '@viddock/shared';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class AbortedError extends Error {
  constructor(readonly reason: string) {
    super(`Aborted: ${reason}`);
  }
}

export interface RangeSpec {
  offset: number;
  length: number;
}

export interface FetchTarget {
  url: string;
  range?: RangeSpec;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError(String(signal.reason ?? 'aborted')));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError(String(signal.reason ?? 'aborted')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * HTTP client that applies the request context (cookies, referer, user agent) safely:
 * the Cookie header is only ever sent to origins the user's request explicitly referenced,
 * and is dropped on cross-origin redirects.
 */
export class HttpClient {
  private readonly cookieOrigins: Set<string>;
  constructor(
    private readonly headers: RequestHeaders,
    cookieOriginUrls: string[],
    readonly options: DownloadOptions,
  ) {
    this.cookieOrigins = new Set(cookieOriginUrls.map((u) => new URL(u).origin));
  }

  private buildHeaders(url: string, range?: RangeSpec, rangeFrom?: number): Record<string, string> {
    const h: Record<string, string> = { accept: '*/*', 'accept-encoding': 'identity' };
    if (this.headers.userAgent) h['user-agent'] = this.headers.userAgent;
    if (this.headers.referer) h.referer = this.headers.referer;
    if (this.headers.cookie && this.cookieOrigins.has(new URL(url).origin)) h.cookie = this.headers.cookie;
    if (range) h.range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    else if (rangeFrom && rangeFrom > 0) h.range = `bytes=${rangeFrom}-`;
    return h;
  }

  /** One request with manual, credential-safe redirect handling. */
  private async request(
    target: FetchTarget,
    signal: AbortSignal,
    rangeFrom?: number,
  ): Promise<{ res: Response; finalUrl: string }> {
    let url = target.url;
    for (let hop = 0; hop < 6; hop++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: this.buildHeaders(url, target.range, rangeFrom),
          redirect: 'manual',
          signal,
        });
      } catch (e) {
        if (signal.aborted) throw new AbortedError(String(signal.reason ?? 'aborted'));
        const cause = (e as { cause?: { code?: string } }).cause;
        throw new HttpError(`Network error: ${cause?.code ?? (e as Error).message}`, undefined, 'NETWORK', true);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location') as string, url).toString();
        if (!/^https?:/i.test(next))
          throw new HttpError('Redirect to non-http URL blocked', res.status, 'BAD_REDIRECT', false);
        await res.body?.cancel();
        url = next;
        continue;
      }
      return { res, finalUrl: url };
    }
    throw new HttpError('Too many redirects', undefined, 'REDIRECTS', false);
  }

  private async withRetry<T>(
    signal: AbortSignal,
    fn: (attempt: number) => Promise<T>,
    onRetry?: (attempt: number, err: HttpError, delay: number) => void,
  ): Promise<T> {
    const { maxRetries, retryBaseMs } = this.options;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(attempt);
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        const err =
          e instanceof HttpError
            ? e
            : new HttpError(
                (e as Error).message,
                undefined,
                classifyFsError(e),
                (e as { code?: string }).code === 'ECONNRESET',
              );
        if (!err.retryable || attempt >= maxRetries) throw err;
        const delay = err.retryAfterMs ?? backoffDelay(attempt, retryBaseMs);
        onRetry?.(attempt, err, delay);
        await sleep(delay, signal);
      }
    }
  }

  private statusError(res: Response, what: string): HttpError {
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    return new HttpError(
      `${what}: HTTP ${res.status}`,
      res.status,
      `HTTP_${res.status}`,
      isRetryableStatus(res.status),
      retryAfter,
    );
  }

  async getText(
    url: string,
    signal: AbortSignal,
    maxBytes = 20 * 1024 * 1024,
  ): Promise<{ text: string; finalUrl: string }> {
    return this.withRetry(signal, async () => {
      const { res, finalUrl } = await this.request({ url }, signal);
      if (!res.ok) {
        await res.body?.cancel();
        throw this.statusError(res, 'Manifest request failed');
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new HttpError('Manifest too large', undefined, 'TOO_LARGE', false);
      return { text: buf.toString('utf8'), finalUrl };
    });
  }

  async getBuffer(target: FetchTarget, signal: AbortSignal, onBytes?: (n: number) => void): Promise<Buffer> {
    return this.withRetry(signal, async () => {
      const { res } = await this.request(target, signal);
      if (!res.ok) {
        await res.body?.cancel();
        throw this.statusError(res, 'Request failed');
      }
      const buf = Buffer.from(await res.arrayBuffer());
      onBytes?.(buf.length);
      return buf;
    });
  }

  /**
   * Stream a resource into `dest` (atomically, via dest + ".part"). Resumes a partial file with
   * Range when `resume` is set and the server honors it.
   */
  async downloadToFile(
    target: FetchTarget,
    dest: string,
    signal: AbortSignal,
    opts: {
      resume?: boolean;
      onBytes?: (n: number) => void;
      onTotal?: (total: number) => void;
      transform?: (b: Buffer) => Buffer;
    } = {},
  ): Promise<number> {
    if (fs.existsSync(dest)) return fs.statSync(dest).size;
    const part = `${dest}.part`;
    let counted = 0;
    const add = (n: number) => {
      counted += n;
      opts.onBytes?.(n);
    };
    return this.withRetry(signal, async () => {
      if (counted !== 0) add(-counted); // roll back what the failed attempt reported
      let offset = 0;
      if (opts.resume && !target.range && fs.existsSync(part)) offset = fs.statSync(part).size;
      const { res } = await this.request(target, signal, offset);
      if (!res.ok) {
        await res.body?.cancel();
        if (res.status === 416 && offset > 0) {
          // Range not satisfiable: partial file is complete or stale; restart from scratch.
          fs.rmSync(part, { force: true });
          throw new HttpError('Resume rejected; restarting', 416, 'HTTP_416', true, 0);
        }
        throw this.statusError(res, 'Download failed');
      }
      let append = false;
      if (offset > 0) {
        if (res.status === 206) append = true;
        else {
          offset = 0; // server ignored Range
        }
      }
      const len = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(len)) opts.onTotal?.(len + (append ? offset : 0));
      if (append) add(offset);
      if (!res.body) throw new HttpError('Empty response body', res.status, 'EMPTY', true);
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          add(chunk.length);
          cb(null, chunk);
        },
      });
      const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
      try {
        await pipeline(Readable.fromWeb(res.body as never), counter, out, { signal });
      } catch (e) {
        if (signal.aborted) throw new AbortedError(String(signal.reason ?? 'aborted'));
        if ((e as { code?: string }).code === 'ENOSPC')
          throw new HttpError('Disk is full', undefined, 'DISK_FULL', false);
        const cause = (e as { cause?: { code?: string } }).cause;
        throw new HttpError(`Transfer interrupted: ${cause?.code ?? (e as Error).message}`, undefined, 'NETWORK', true);
      }
      const size = fs.statSync(part).size;
      const expected = Number.isFinite(len) ? len + (append ? offset : 0) : undefined;
      if (expected !== undefined && size !== expected) {
        if (!append) fs.rmSync(part, { force: true });
        throw new HttpError(`Incomplete response (${size}/${expected} bytes)`, undefined, 'TRUNCATED', true);
      }
      if (opts.transform) {
        fs.writeFileSync(part, opts.transform(fs.readFileSync(part)));
      }
      fs.renameSync(part, dest);
      return fs.statSync(dest).size;
    });
  }
}

function classifyFsError(e: unknown): string {
  const code = (e as { code?: string }).code;
  if (code === 'ENOSPC') return 'DISK_FULL';
  if (code === 'EACCES' || code === 'EPERM') return 'PATH_ERROR';
  return code ?? 'ERROR';
}
