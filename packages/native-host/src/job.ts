import fs from 'node:fs';
import path from 'node:path';
import { emptyProgress, parseHls, parseMpd, sanitizeFilename } from '@viddock/shared';
import type { NativeDownloadRequest, TaskInfo, TaskProgress, TaskState } from '@viddock/shared';
import { findBinary, probe, runFfmpeg } from './ffmpeg.ts';
import { AbortedError, HttpClient, HttpError, sleep } from './http.ts';
import { buildMuxArgs, chooseContainer } from './mux.ts';
import type { MuxInput, MuxSubtitle } from './mux.ts';
import {
  assembleStream,
  decryptSegment,
  defaultIv,
  hexIv,
  pad,
  parseRange,
  planTrack,
  UserFacingError,
} from './plans.ts';
import type { Part, StreamPlan, TrackPlan } from './plans.ts';
import { PathError, resolveOutputDir } from './framing.ts';
import { verifyOutput } from './verify.ts';

export interface JobContext {
  workRoot: string;
  ffmpeg?: string;
  ffprobe?: string;
  onUpdate: (info: TaskInfo) => void;
}

/** Rolling throughput / progress accounting. */
export class ProgressTracker {
  bytes = 0;
  totalBytes?: number;
  segDone = 0;
  segTotal = 0;
  stage = '';
  private samples: { t: number; b: number }[] = [];
  private startedAt = Date.now();

  addBytes(n: number, now = Date.now()): void {
    this.bytes = Math.max(0, this.bytes + n);
    this.samples.push({ t: now, b: this.bytes });
    const cutoff = now - 4000;
    while (this.samples.length > 2 && (this.samples[0] as { t: number }).t < cutoff) this.samples.shift();
  }

  rate(now = Date.now()): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.t === first.t) return 0;
    if (now - last.t > 3000) return 0;
    return Math.max(0, ((last.b - first.b) / (last.t - first.t)) * 1000);
  }

  snapshot(downloadDone: boolean, now = Date.now()): TaskProgress {
    const rate = this.rate(now);
    let total = this.totalBytes;
    if (this.segTotal > 1 && this.segDone > 0)
      total = Math.max(this.bytes, (this.bytes / this.segDone) * this.segTotal);
    let percent: number;
    if (downloadDone) percent = 100;
    else if (this.segTotal > 1) percent = (this.segDone / this.segTotal) * 100;
    else if (total && total > 0) percent = (this.bytes / total) * 100;
    else percent = 0;
    percent = Math.min(100, Math.max(0, percent));
    const remaining = total ? Math.max(0, total - this.bytes) : undefined;
    return {
      bytesDownloaded: this.bytes,
      totalBytes: total ? Math.round(total) : undefined,
      bytesPerSec: Math.round(rate),
      segmentsDone: this.segDone,
      segmentsTotal: this.segTotal,
      percent: Math.round(percent * 10) / 10,
      stage: this.stage,
      elapsedMs: now - this.startedAt,
      etaMs: rate > 0 && remaining !== undefined && !downloadDone ? Math.round((remaining / rate) * 1000) : undefined,
    };
  }
}

function reserveFile(dir: string, base: string, ext: string): string {
  for (let i = 1; i < 10_000; i++) {
    const name = i === 1 ? `${base}.${ext}` : `${base} (${i}).${ext}`;
    const full = path.join(dir, name);
    try {
      fs.closeSync(fs.openSync(full, 'wx'));
      return full;
    } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST') continue;
      throw e;
    }
  }
  throw new UserFacingError('Could not find a free file name', 'PATH_ERROR');
}

function moveFile(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if ((e as { code?: string }).code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.rmSync(src, { force: true });
    } else throw e;
  }
}

export class DownloadJob {
  info: TaskInfo;
  private controller = new AbortController();
  private tracker = new ProgressTracker();
  private downloadDone = false;
  private timer?: NodeJS.Timeout;
  private lastEmit = 0;
  private keyCache = new Map<string, Promise<Buffer>>();
  private isLive = false;
  private stopped = false;
  readonly workDir: string;

  constructor(
    readonly req: NativeDownloadRequest,
    private readonly ctx: JobContext,
  ) {
    const now = Date.now();
    this.info = {
      id: req.taskId,
      title: req.title,
      state: 'queued',
      progress: emptyProgress(),
      createdAt: now,
      updatedAt: now,
    };
    this.workDir = path.join(ctx.workRoot, req.taskId);
  }

  get state(): TaskState {
    return this.info.state;
  }

  private setState(state: TaskState, patch: Partial<TaskInfo> = {}): void {
    this.info = { ...this.info, ...patch, state, updatedAt: Date.now() };
    this.emit(true);
  }

  private emit(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.info = { ...this.info, progress: this.tracker.snapshot(this.downloadDone), updatedAt: now };
    this.ctx.onUpdate(this.info);
  }

  markQueued(): void {
    this.setState('queued', { error: undefined, errorCode: undefined });
  }

  markPaused(): void {
    this.setState('paused');
  }

  stop(): void {
    this.stopped = true;
    this.abort('stop');
  }

  abort(reason: 'pause' | 'cancel' | 'shutdown' | 'stop'): void {
    if (reason === 'stop') this.stopped = true;
    this.controller.abort(reason);
  }

  cleanup(): void {
    fs.rmSync(this.workDir, { recursive: true, force: true });
  }

  /** Runs the whole pipeline. Never rejects; outcome is reflected in `info.state`. */
  async run(): Promise<void> {
    this.controller = new AbortController();
    this.tracker = new ProgressTracker();
    this.downloadDone = false;
    const signal = this.controller.signal;
    this.timer = setInterval(() => this.emit(), 500);
    try {
      this.setState('preparing', { error: undefined, errorCode: undefined, warnings: undefined });
      const outputPath = await this.pipeline(signal);
      const size = fs.statSync(outputPath).size;
      this.tracker.stage = 'Done';
      this.downloadDone = true;
      this.setState('completed', { outputPath, outputBytes: size });
      this.cleanup();
    } catch (e) {
      const reason = signal.aborted ? String(signal.reason) : undefined;
      if (reason === 'cancel') {
        this.cleanup();
        this.setState('cancelled');
      } else if (reason === 'pause' || reason === 'shutdown') {
        this.setState('paused');
      } else if (e instanceof AbortedError) {
        this.setState('paused');
      } else {
        const { message, code } = describeError(e);
        this.setState('failed', { error: message, errorCode: code });
      }
    } finally {
      clearInterval(this.timer);
    }
  }

  private async pipeline(signal: AbortSignal): Promise<string> {
    const req = this.req;
    const outDir = resolveOutputDir(req.outputDir);
    fs.mkdirSync(this.workDir, { recursive: true });

    const ffmpeg = this.ctx.ffmpeg ?? findBinary('ffmpeg');
    const ffprobe = this.ctx.ffprobe ?? findBinary('ffprobe');

    const client = new HttpClient(
      req.headers,
      [...req.tracks.map((t) => t.url), ...req.subtitles.map((s) => s.url)],
      req.options,
    );

    // ---- Plan ----
    this.tracker.stage = 'Reading manifests';
    this.emit(true);
    const plans: TrackPlan[] = [];
    for (let i = 0; i < req.tracks.length; i++) {
      plans.push(await planTrack(req.tracks[i]!, { client, workDir: this.workDir, signal, trackIndex: i }));
    }
    const streams = plans.flatMap((p) => p.streams.map((s) => ({ ...s, label: s.label || p.label })));
    const needsFfmpeg =
      !(plans.length === 1 && plans[0]?.originalExt && req.container === 'auto' && req.subtitleMode !== 'embed') ||
      streams.some((s) => !s.direct);
    if (needsFfmpeg && (!ffmpeg || !ffprobe)) {
      throw new UserFacingError(
        'FFmpeg was not found. Install it (macOS: "brew install ffmpeg") and run the VidDock installer again.',
        'NO_FFMPEG',
      );
    }

    this.isLive = streams.some((s) => s.isLive);
    const liveMode = req.options.liveMode ?? (this.isLive ? 'dvr' : undefined);
    if (this.isLive) {
      this.info = { ...this.info, isLive: true, liveMode };
    }

    const allParts: Part[] = streams.flatMap((s) => s.parts);
    this.tracker.segTotal = allParts.length;
    const totalDur = Math.max(0, ...plans.map((p) => p.durationSec ?? 0));
    const expectedDuration = totalDur > 0 ? totalDur : req.expectedDurationSec;

    // ---- Download ----
    this.setState('downloading');
    this.tracker.stage = 'Downloading';
    let totalSkipped = 0;
    let livePreserved = false;
    let warnings: string[] = [];

    if (this.isLive && (liveMode === 'duration' || liveMode === 'until_stopped')) {
      try {
        await this.downloadLiveStream(streams, client, signal);
      } catch (e) {
        if (this.isLive && (signal.aborted || this.stopped)) {
          livePreserved = true;
        } else {
          throw e;
        }
      }
    } else {
      try {
        const { skippedParts } = await this.downloadParts(allParts, client, signal);
        totalSkipped += skippedParts.size;
      } catch (e) {
        if (this.isLive && (signal.aborted || this.stopped)) {
          livePreserved = true;
        } else {
          throw e;
        }
      }
    }

    if (this.isLive && (signal.aborted || this.stopped || livePreserved)) {
      livePreserved = true;
      for (const s of streams) {
        s.parts = s.parts.filter((p) => fs.existsSync(p.dest) && fs.statSync(p.dest).size > 0);
        if (s.parts.length === 0) {
          throw new UserFacingError('No media segments were downloaded before stopping', 'NO_SEGMENTS');
        }
      }
      warnings.push('Recording stopped; partial capture preserved.');
    }

    let assembleSkipped = 0;
    for (const s of streams) {
      const res = await assembleStream(s);
      assembleSkipped += res.skippedParts;
    }
    this.downloadDone = true;

    const finalSkipped = Math.max(totalSkipped, assembleSkipped);
    if (finalSkipped > 0 && !livePreserved) {
      const percent = Math.round((finalSkipped / Math.max(1, allParts.length)) * 100);
      warnings.push(
        `Missing ${finalSkipped} of ${allParts.length} media segments (${percent}%). Captured output may contain playback stutters at missing segment boundaries.`,
      );
    }

    const procSignal = livePreserved ? new AbortController().signal : signal;

    // ---- Subtitles ----
    const subs = await this.fetchSubtitles(client, procSignal);

    // ---- Process ----
    this.tracker.stage = 'Processing';
    this.setState('processing');
    const finalBase = sanitizeFilename(req.fileName || req.title || 'video');

    let finalTmp: string;
    let ext: string;
    const single = plans.length === 1 ? plans[0] : undefined;
    const singleStream = single?.streams.length === 1 ? single.streams[0] : undefined;
    const keepOriginal = !!(
      single?.originalExt &&
      singleStream &&
      req.container === 'auto' &&
      req.subtitleMode !== 'embed'
    );
    let inputs: MuxInput[] = [];
    if (keepOriginal && single && singleStream) {
      finalTmp = singleStream.file;
      ext = single.originalExt as string;
    } else {
      inputs = await this.probeInputs(streams, ffprobe as string, procSignal);
      const embed = req.subtitleMode === 'embed' ? subs : [];
      const choice = chooseContainer(req.container, inputs, req.layout);
      if (choice.note) warnings.push(choice.note);
      ext = choice.ext;
      finalTmp = path.join(this.workDir, `output.${ext}`);
      const args = buildMuxArgs({
        inputs,
        subtitles: embed,
        choice,
        output: finalTmp,
        title: req.title,
        layout: req.layout,
      });
      const r = await runFfmpeg(ffmpeg as string, args, procSignal);
      if (r.code !== 0) {
        throw new UserFacingError(`FFmpeg failed (exit ${r.code}): ${lastLine(r.stderr)}`, 'FFMPEG_FAILED');
      }
    }

    // ---- Verify ----
    this.tracker.stage = 'Verifying';
    this.setState('verifying');
    if (ffmpeg && ffprobe) {
      const p = inputs.length > 0 ? inputs : await this.probeInputs(streams, ffprobe, procSignal);
      const expectVideo = p.some((i) => i.probe.streams.some((s) => s.codec_type === 'video'));
      const expectAudio = p.some((i) => i.probe.streams.some((s) => s.codec_type === 'audio'));
      const v = await verifyOutput(
        { ffmpeg, ffprobe },
        finalTmp,
        {
          video: expectVideo,
          audio: expectAudio,
          durationSec: this.isLive ? undefined : expectedDuration,
          skippedSegments: finalSkipped,
        },
        procSignal,
      );
      warnings = [...warnings, ...v.warnings];
    } else {
      warnings.push('FFmpeg not available: output was not verified');
    }

    // ---- Publish ----
    const finalPath = reserveFile(outDir, finalBase, ext);
    moveFile(finalTmp, finalPath);
    if (req.subtitleMode === 'separate') {
      for (const s of subs) {
        const lang = sanitizeFilename(s.language || s.label || 'sub', 20);
        const target = reserveFile(outDir, `${path.basename(finalPath, `.${ext}`)}.${lang}`, 'vtt');
        moveFile(s.file, target);
      }
    }
    if (warnings.length) this.info = { ...this.info, warnings };
    return finalPath;
  }

  private async probeInputs(streams: StreamPlan[], ffprobe: string, signal: AbortSignal): Promise<MuxInput[]> {
    const out: MuxInput[] = [];
    for (const s of streams) {
      let pr;
      try {
        pr = await probe(ffprobe, s.file, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        throw new UserFacingError(`Downloaded ${s.kind} stream is not valid media (ffprobe failed)`, 'BAD_MEDIA');
      }
      out.push({ file: s.file, kind: s.kind, probe: pr, label: s.label });
    }
    return out;
  }

  private async fetchSubtitles(client: HttpClient, signal: AbortSignal): Promise<MuxSubtitle[]> {
    const out: MuxSubtitle[] = [];
    if (this.req.subtitleMode === 'none') return out;
    const dir = path.join(this.workDir, 'subs');
    fs.mkdirSync(dir, { recursive: true });
    let idx = 0;
    for (const sub of this.req.subtitles) {
      const file = path.join(dir, `${idx++}.vtt`);
      try {
        const { text } = await client.getText(sub.url, signal);
        const vtt = /^\s*#EXTM3U/.test(text)
          ? await this.mergeVttPlaylist(text, sub.url, client, signal)
          : normalizeVtt(text);
        fs.writeFileSync(file, vtt);
        out.push({ file, language: sub.language, label: sub.label });
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        const w = this.info.warnings ?? [];
        this.info = {
          ...this.info,
          warnings: [...w, `Subtitle "${sub.label ?? sub.language ?? idx}" could not be downloaded`],
        };
      }
    }
    return out;
  }

  private async mergeVttPlaylist(text: string, url: string, client: HttpClient, signal: AbortSignal): Promise<string> {
    const pl = parseHls(text, url);
    if (pl.type !== 'media') throw new Error('subtitle playlist is not a media playlist');
    let merged = 'WEBVTT\n\n';
    for (const seg of pl.segments) {
      const buf = await client.getBuffer({ url: seg.url }, signal);
      merged += stripVttHeader(buf.toString('utf8')) + '\n';
    }
    return merged;
  }

  private async getKey(url: string, client: HttpClient, signal: AbortSignal): Promise<Buffer> {
    let p = this.keyCache.get(url);
    if (!p) {
      p = client.getBuffer({ url }, signal).then((b) => {
        if (b.length !== 16)
          throw new UserFacingError('HLS encryption key is not 16 bytes (unsupported key delivery)', 'DRM');
        return b;
      });
      this.keyCache.set(url, p);
      p.catch(() => this.keyCache.delete(url));
    }
    return p;
  }

  private async downloadLiveStream(streams: StreamPlan[], client: HttpClient, signal: AbortSignal): Promise<void> {
    const conc = this.req.options.segmentConcurrency;
    const toleranceRate = this.req.options.segmentToleranceRate ?? 0.02;
    const targetDurationSec = Math.max(1, streams[0]?.targetDuration ?? 2);
    const liveMode = this.req.options.liveMode ?? 'dvr';
    const liveDurationLimit = this.req.options.liveDurationSeconds;

    const seenUrls = new Set<string>();
    const queue: { p: Part; i: number; s: StreamPlan }[] = [];
    const skippedParts = new Set<number>();
    let partIndex = 0;
    let accumulatedDuration = 0;
    let pollingEnded = false;

    for (const s of streams) {
      for (const p of s.parts) {
        seenUrls.add(p.url);
        queue.push({ p, i: partIndex++, s });
      }
      accumulatedDuration += s.durationSec ?? 0;
    }
    this.tracker.segTotal = queue.length;

    const pollController = new AbortController();
    const onSignalAbort = () => pollController.abort();
    signal.addEventListener('abort', onSignalAbort, { once: true });

    let wakeWorker: (() => void) | null = null;
    const notifyWorkers = () => {
      if (wakeWorker) {
        const cb = wakeWorker;
        wakeWorker = null;
        cb();
      }
    };

    const poller = async () => {
      while (!pollController.signal.aborted && !this.stopped && !pollingEnded) {
        if (liveMode === 'duration' && liveDurationLimit && accumulatedDuration >= liveDurationLimit) {
          pollingEnded = true;
          break;
        }

        try {
          await sleep(Math.min(targetDurationSec * 1000, 2000), pollController.signal);
        } catch {
          break;
        }

        if (pollController.signal.aborted || this.stopped) break;

        for (const s of streams) {
          if (!s.pollUrl) continue;
          try {
            const { text, finalUrl } = await client.getText(s.pollUrl, pollController.signal);
            if (s.type === 'hls') {
              const pl = parseHls(text, finalUrl);
              if (pl.type === 'media') {
                for (const seg of pl.segments) {
                  if (!seenUrls.has(seg.url)) {
                    seenUrls.add(seg.url);
                    const dest = path.join(path.dirname(s.parts[0]?.dest ?? s.file), `${pad(s.parts.length)}.seg`);
                    const encrypted = seg.key && seg.key.method === 'AES-128' && seg.key.url;
                    const newPart: Part = {
                      url: seg.url,
                      range: seg.byteRange,
                      dest,
                      key: encrypted
                        ? { url: seg.key?.url as string, iv: hexIv(seg.key?.iv), seq: seg.seq }
                        : undefined,
                    };
                    s.parts.push(newPart);
                    queue.push({ p: newPart, i: partIndex++, s });
                    this.tracker.segTotal++;
                    accumulatedDuration += seg.duration;
                    notifyWorkers();
                    if (liveMode === 'duration' && liveDurationLimit && accumulatedDuration >= liveDurationLimit) {
                      pollingEnded = true;
                      break;
                    }
                  }
                }
                if (pl.endList) pollingEnded = true;
              }
            } else if (s.type === 'dash') {
              const mpd = parseMpd(text, finalUrl);
              const period = mpd.periods[0];
              const reps = period?.adaptations.flatMap((a) => a.representations) ?? [];
              const matched = (s.dashRepId ? reps.find((r) => r.id === s.dashRepId) : reps[0]) ?? reps[0];
              if (matched) {
                for (const seg of matched.segments) {
                  if (!seenUrls.has(seg.url)) {
                    seenUrls.add(seg.url);
                    const dest = path.join(path.dirname(s.parts[0]?.dest ?? s.file), `${pad(s.parts.length)}.seg`);
                    const newPart: Part = {
                      url: seg.url,
                      range: parseRange(seg.range),
                      dest,
                    };
                    s.parts.push(newPart);
                    queue.push({ p: newPart, i: partIndex++, s });
                    this.tracker.segTotal++;
                    accumulatedDuration += seg.duration;
                    notifyWorkers();
                    if (liveMode === 'duration' && liveDurationLimit && accumulatedDuration >= liveDurationLimit) {
                      pollingEnded = true;
                      break;
                    }
                  }
                }
              }
              if (!mpd.isLive) pollingEnded = true;
            }
          } catch {
            // Ignore transient playlist poll errors
          }
        }
      }
      pollingEnded = true;
      notifyWorkers();
    };

    let nextQueueIdx = 0;
    let workerFailure: unknown;

    const worker = async () => {
      while (!signal.aborted && !this.stopped) {
        if (nextQueueIdx < queue.length) {
          const item = queue[nextQueueIdx++];
          if (!item) continue;
          const { p, i } = item;
          try {
            if (fs.existsSync(p.dest)) {
              const size = fs.statSync(p.dest).size;
              this.tracker.addBytes(size);
            } else {
              let transform: ((b: Buffer) => Buffer) | undefined;
              if (p.key) {
                const key = await this.getKey(p.key.url, client, signal);
                const iv = p.key.iv ?? defaultIv(p.key.seq);
                transform = (b) => decryptSegment(b, key, iv);
              }
              await client.downloadToFile({ url: p.url, range: p.range }, p.dest, signal, {
                resume: p.resume,
                transform,
                onBytes: (n) => this.tracker.addBytes(n),
              });
            }
            this.tracker.segDone += 1;
            this.emit();
          } catch (e) {
            if (signal.aborted || this.stopped || e instanceof AbortedError) return;
            const is404 = e instanceof HttpError && e.status === 404;
            if (is404 && !p.isInit) {
              const wouldSkip = skippedParts.size + 1;
              if (wouldSkip / Math.max(1, queue.length) <= toleranceRate + 1e-9) {
                skippedParts.add(i);
                const partialFile = `${p.dest}.part`;
                if (fs.existsSync(partialFile)) fs.rmSync(partialFile, { force: true });
                this.tracker.segDone += 1;
                this.emit();
                continue;
              }
            }
            if (workerFailure === undefined) {
              if (is404) {
                const reason = p.isInit
                  ? 'Initialization segment is missing (HTTP 404)'
                  : `Segment ${i + 1} of ${queue.length} is missing (HTTP 404). Missing segments exceed tolerance (${Math.round(toleranceRate * 100)}%)`;
                workerFailure = new UserFacingError(reason, 'SEGMENT_MISSING');
              } else {
                workerFailure = e;
              }
            }
            pollController.abort();
            return;
          }
        } else if (pollingEnded) {
          return;
        } else {
          await new Promise<void>((res) => {
            wakeWorker = res;
            if (pollingEnded || nextQueueIdx < queue.length || signal.aborted || this.stopped) res();
          });
        }
      }
    };

    const pollerPromise = poller();
    const workers = Promise.all(Array.from({ length: Math.min(conc, Math.max(1, queue.length || 1)) }, worker));

    await Promise.race([workers, pollerPromise.then(() => workers)]);
    pollController.abort();
    signal.removeEventListener('abort', onSignalAbort);
    notifyWorkers();
    await Promise.allSettled([pollerPromise, workers]);

    if (workerFailure !== undefined && !this.stopped && !signal.aborted) {
      throw workerFailure;
    }
  }

  private async downloadParts(
    parts: Part[],
    client: HttpClient,
    signal: AbortSignal,
  ): Promise<{ skippedParts: Set<number> }> {
    const conc = this.req.options.segmentConcurrency;
    const toleranceRate = this.req.options.segmentToleranceRate ?? 0.02;
    const inner = new AbortController();
    const onAbort = () => inner.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    let next = 0;
    let failure: unknown;
    const queue = parts.map((p, i) => ({ p, i }));
    const total = parts.length;
    const skippedParts = new Set<number>();

    const worker = async () => {
      while (!inner.signal.aborted) {
        const item = queue[next++];
        if (!item) return;
        const { p, i } = item;
        try {
          if (fs.existsSync(p.dest)) {
            const size = fs.statSync(p.dest).size;
            this.tracker.addBytes(size);
          } else {
            let transform: ((b: Buffer) => Buffer) | undefined;
            if (p.key) {
              const key = await this.getKey(p.key.url, client, inner.signal);
              const iv = p.key.iv ?? defaultIv(p.key.seq);
              transform = (b) => decryptSegment(b, key, iv);
            }
            await client.downloadToFile({ url: p.url, range: p.range }, p.dest, inner.signal, {
              resume: p.resume,
              transform,
              onBytes: (n) => this.tracker.addBytes(n),
              onTotal: total === 1 ? (t) => (this.tracker.totalBytes = t) : undefined,
            });
          }
          this.tracker.segDone += 1;
          this.emit();
        } catch (e) {
          if (e instanceof AbortedError) return;
          const is404 = e instanceof HttpError && e.status === 404;
          if (is404 && !p.isInit) {
            const wouldSkip = skippedParts.size + 1;
            if (wouldSkip / total <= toleranceRate + 1e-9) {
              skippedParts.add(i);
              const partialFile = `${p.dest}.part`;
              if (fs.existsSync(partialFile)) fs.rmSync(partialFile, { force: true });
              this.tracker.segDone += 1;
              this.emit();
              continue;
            }
          }
          if (failure === undefined) {
            if (is404) {
              const reason = p.isInit
                ? 'Initialization segment is missing (HTTP 404)'
                : `Segment ${i + 1} of ${total} is missing (HTTP 404). Missing segments exceed tolerance (${Math.round(toleranceRate * 100)}%)`;
              failure = new UserFacingError(reason, 'SEGMENT_MISSING');
            } else {
              failure = e;
            }
            inner.abort('failure');
          }
          return;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(conc, Math.max(1, parts.length)) }, worker));
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (failure !== undefined) throw failure;
    if (signal.aborted) throw new AbortedError(String(signal.reason));
    return { skippedParts };
  }
}

function lastLine(s: string): string {
  const lines = s.trim().split('\n');
  return lines[lines.length - 1] ?? '';
}

function stripVttHeader(s: string): string {
  const idx = s.search(/\r?\n\r?\n/);
  const head = idx >= 0 ? s.slice(0, idx) : s;
  return /^\uFEFF?WEBVTT/.test(head) ? s.slice(idx >= 0 ? idx : s.length).trim() : s.trim();
}

function normalizeVtt(s: string): string {
  const t = s.replace(/^\uFEFF/, '');
  if (/^WEBVTT/.test(t)) return t;
  // SRT -> VTT
  return 'WEBVTT\n\n' + t.replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2');
}

export function describeError(e: unknown): { message: string; code: string } {
  if (e instanceof UserFacingError) return { message: e.message, code: e.code };
  if (e instanceof PathError) return { message: e.message, code: e.code };
  if (e instanceof HttpError) {
    const hint =
      e.status === 401 || e.status === 403
        ? ' Your session may have expired: reopen the video page and try again.'
        : '';
    return { message: `${e.message}.${hint}`.replace(/\.\./g, '.'), code: e.code };
  }
  const code = (e as { code?: string }).code;
  if (code === 'ENOSPC') return { message: 'The disk is full.', code: 'DISK_FULL' };
  if (code === 'EACCES' || code === 'EPERM')
    return { message: 'Permission denied writing to the output folder.', code: 'PATH_ERROR' };
  return { message: (e as Error)?.message ?? String(e), code: 'ERROR' };
}
