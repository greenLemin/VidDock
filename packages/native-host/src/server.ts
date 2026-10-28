import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION, validateDownloadRequest } from '@viddock/shared';
import type { HelloData, HostMessage, HostRequest } from '@viddock/shared';
import { binaryVersion, findBinary } from './ffmpeg.ts';
import { appHome, defaultOutputDir, encodeMessage, MessageDecoder, validateExistingFile } from './framing.ts';
import { pruneWorkDirs, TaskManager } from './manager.ts';

export const HOST_VERSION = '1.0.0';

/** Protocol server: reads framed requests from `input`, writes framed replies to `output`. */
export class HostServer {
  readonly manager: TaskManager;
  private readonly workRoot: string;
  private inFlight = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    opts: { home?: string } = {},
  ) {
    const home = opts.home ?? appHome();
    this.workRoot = path.join(home, 'work');
    fs.mkdirSync(this.workRoot, { recursive: true, mode: 0o700 });
    this.manager = new TaskManager({
      workRoot: this.workRoot,
      onUpdate: (task) => this.send({ type: 'task.update', task }),
    });
    pruneWorkDirs(this.workRoot, new Set());
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      const decoder = new MessageDecoder(
        (msg) => {
          const p: Promise<void> = Promise.resolve(this.handle(msg))
            .catch((err) => this.log(`handler error: ${(err as Error).message}`))
            .finally(() => this.inFlight.delete(p));
          this.inFlight.add(p);
        },
        (err) => this.log(`protocol error: ${err.message}`),
      );
      this.input.on('data', (chunk: Buffer | string) =>
        decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      let ended = false;
      const end = async () => {
        if (ended) return;
        ended = true;
        while (this.inFlight.size > 0) {
          await Promise.allSettled(Array.from(this.inFlight));
        }
        await this.close();
        resolve();
      };
      this.input.on('end', () => void end());
      this.input.on('close', () => void end());
      this.input.on('error', () => void end());
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.manager.shutdown();
  }

  private log(msg: string): void {
    // stdout is the protocol channel; logs go to stderr and never include URLs or headers.
    process.stderr.write(`[viddock-host] ${msg}\n`);
  }

  private send(msg: HostMessage): void {
    if (this.closed && msg.type === 'task.update') return;
    try {
      this.output.write(encodeMessage(msg));
    } catch (e) {
      this.log(`send failed: ${(e as Error).message}`);
    }
  }

  private reply(id: string, data?: unknown): void {
    this.send({ type: 'reply', id, ok: true, data });
  }

  private fail(id: string, err: unknown): void {
    const e = err as Error & { code?: string };
    this.send({ type: 'reply', id, ok: false, error: e.message ?? String(err), code: e.code });
  }

  async handle(raw: unknown): Promise<void> {
    const m = raw as Partial<HostRequest> & { id?: unknown };
    if (!m || typeof m !== 'object' || typeof m.type !== 'string' || typeof m.id !== 'string') {
      this.log('ignored malformed message');
      return;
    }
    const id = m.id;
    try {
      switch (m.type) {
        case 'hello':
          this.reply(id, await this.hello());
          break;
        case 'download.start': {
          const req = validateDownloadRequest((m as { request?: unknown }).request);
          this.reply(id, this.manager.submit(req));
          break;
        }
        case 'download.pause':
          this.reply(id, this.manager.pause(this.taskId(m)));
          break;
        case 'download.resume':
          this.reply(id, this.manager.resume(this.taskId(m)));
          break;
        case 'download.cancel':
          this.reply(id, this.manager.cancel(this.taskId(m)));
          break;
        case 'download.stop':
          this.reply(id, this.manager.stop(this.taskId(m)));
          break;
        case 'download.remove':
          this.manager.remove(this.taskId(m));
          this.reply(id);
          break;
        case 'tasks.list':
          this.reply(id, this.manager.list());
          break;
        case 'config': {
          const n = (m as { maxSimultaneous?: unknown }).maxSimultaneous;
          if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('maxSimultaneous must be a number');
          this.manager.setMaxSimultaneous(n);
          this.reply(id);
          break;
        }
        case 'file.open':
        case 'file.reveal': {
          const p = validateExistingFile((m as { path?: unknown }).path as string);
          await this.openOrReveal(p, m.type === 'file.reveal');
          this.reply(id);
          break;
        }
        case 'diagnostics':
          this.reply(id, { ...(await this.hello()), tasks: this.manager.list().length, node: process.version });
          break;
        case 'cache.info':
          this.reply(id, this.manager.getCacheInfo());
          break;
        case 'cache.clear':
          this.reply(id, this.manager.clearCache());
          break;
        default:
          throw new Error(`Unknown message type: ${String(m.type)}`);
      }
    } catch (e) {
      this.fail(id, e);
    }
  }

  private taskId(m: { taskId?: unknown }): string {
    if (typeof m.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(m.taskId)) throw new Error('Invalid taskId');
    return m.taskId;
  }

  private async hello(): Promise<HelloData> {
    const ffmpeg = findBinary('ffmpeg');
    const ffprobe = findBinary('ffprobe');
    return {
      protocol: PROTOCOL_VERSION,
      version: HOST_VERSION,
      platform: process.platform,
      ffmpeg: await binaryVersion(ffmpeg),
      ffprobe: await binaryVersion(ffprobe),
      defaultOutputDir: defaultOutputDir(),
    };
  }

  private openOrReveal(file: string, reveal: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      let cmd: string;
      let args: string[];
      if (process.platform === 'darwin') {
        cmd = 'open';
        args = reveal ? ['-R', file] : [file];
      } else if (process.platform === 'win32') {
        cmd = reveal ? 'explorer.exe' : 'cmd';
        args = reveal ? [`/select,${file}`] : ['/c', 'start', '""', file];
      } else {
        cmd = 'xdg-open';
        args = [reveal ? path.dirname(file) : file];
      }
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
    });
  }
}
