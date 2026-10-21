import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export interface Rule {
  match: RegExp;
  /** Fail the first N matching requests with `status`. */
  failCount?: number;
  status?: number;
  headers?: Record<string, string>;
  /** Respond 401 unless this exact Cookie header value is sent. */
  requireCookie?: string;
  /** Throttle response to this many bytes/second. */
  bytesPerSec?: number;
  /** Close the connection after sending this many bytes (simulate truncated transfer). */
  truncateAfter?: number;
  /** Redirect to this absolute URL. */
  redirectTo?: string;
  /** Ignore Range headers. */
  ignoreRange?: boolean;
  _hits?: number;
}

export interface LoggedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  status: number;
}

export class TestServer {
  rules: Rule[] = [];
  log: LoggedRequest[] = [];
  private server: http.Server;
  private root: string;
  port = 0;

  constructor(root: string) {
    this.root = root;
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  reset(): void {
    this.rules = [];
    this.log = [];
  }

  count(re: RegExp): number {
    return this.log.filter((l) => re.test(l.url)).length;
  }

  private record(req: http.IncomingMessage, status: number): void {
    this.log.push({ url: req.url ?? '', headers: req.headers, status });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const rule = this.rules.find((r) => r.match.test(urlPath));
    if (rule) {
      rule._hits = (rule._hits ?? 0) + 1;
      if (rule.requireCookie !== undefined && req.headers.cookie !== rule.requireCookie) {
        this.record(req, 401);
        res.writeHead(401).end('unauthorized');
        return;
      }
      if (rule.redirectTo) {
        this.record(req, 302);
        res.writeHead(302, { location: rule.redirectTo }).end();
        return;
      }
      if (rule.failCount !== undefined && rule._hits <= rule.failCount) {
        const status = rule.status ?? 503;
        this.record(req, status);
        res.writeHead(status, rule.headers ?? {}).end('injected failure');
        return;
      }
      if (rule.failCount === undefined && rule.status !== undefined) {
        this.record(req, rule.status);
        res.writeHead(rule.status, rule.headers ?? {}).end('injected failure');
        return;
      }
    }
    const file = path.join(this.root, urlPath);
    if (!file.startsWith(this.root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      this.record(req, 404);
      res.writeHead(404).end('not found');
      return;
    }
    const size = fs.statSync(file).size;
    const ext = path.extname(file).slice(1);
    const types: Record<string, string> = {
      mp4: 'video/mp4',
      m3u8: 'application/vnd.apple.mpegurl',
      mpd: 'application/dash+xml',
      ts: 'video/mp2t',
      m4s: 'video/iso.segment',
      vtt: 'text/vtt',
      json: 'application/json',
      html: 'text/html',
    };
    const headers: Record<string, string | number> = {
      'content-type': types[ext] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ''));
    if (range && !rule?.ignoreRange) {
      start = range[1] ? Number(range[1]) : 0;
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size) {
        this.record(req, 416);
        res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
        return;
      }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = end - start + 1;
    this.record(req, status);
    res.writeHead(status, headers);
    const bps = rule?.bytesPerSec;
    const truncate = rule?.truncateAfter;
    if (!bps && truncate === undefined) {
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    const buf = fs.readFileSync(file).subarray(start, end + 1);
    const chunk = bps ? Math.max(1024, Math.floor(bps / 10)) : 64 * 1024;
    let sent = 0;
    const limit = truncate ?? buf.length;
    const tick = () => {
      if (res.destroyed) return;
      if (sent >= limit) {
        if (truncate !== undefined && truncate < buf.length) res.destroy();
        else res.end();
        return;
      }
      const piece = buf.subarray(sent, Math.min(sent + chunk, limit));
      sent += piece.length;
      res.write(piece);
      setTimeout(tick, bps ? 100 : 0);
    };
    tick();
  }
}
