import fs from 'node:fs';
import path from 'node:path';
import { isActive, isTerminal } from '@viddock/shared';
import type { NativeDownloadRequest, TaskInfo } from '@viddock/shared';
import { DownloadJob } from './job.ts';
import type { JobContext } from './job.ts';

export class TaskManager {
  private jobs = new Map<string, DownloadJob>();
  private running = new Set<string>();
  maxSimultaneous = 3;

  constructor(private readonly ctx: Omit<JobContext, 'onUpdate'> & { onUpdate: (t: TaskInfo) => void }) {}

  list(): TaskInfo[] {
    return [...this.jobs.values()].map((j) => j.info);
  }

  get(taskId: string): DownloadJob | undefined {
    return this.jobs.get(taskId);
  }

  setMaxSimultaneous(n: number): void {
    this.maxSimultaneous = Math.min(16, Math.max(1, Math.floor(n)));
    this.schedule();
  }

  /** Enqueue (or re-enqueue after failure/cancel/restart) a download. */
  submit(req: NativeDownloadRequest): TaskInfo {
    const existing = this.jobs.get(req.taskId);
    if (existing && (isActive(existing.state) || existing.state === 'queued')) return existing.info;
    const job = new DownloadJob(req, this.ctx);
    this.jobs.set(req.taskId, job);
    job.markQueued();
    this.schedule();
    return job.info;
  }

  pause(taskId: string): TaskInfo {
    const job = this.require(taskId);
    if (job.state === 'queued') job.markPaused();
    else if (isActive(job.state)) job.abort('pause');
    return job.info;
  }

  resume(taskId: string): TaskInfo {
    const job = this.require(taskId);
    if (job.state === 'paused') {
      job.markQueued();
      this.schedule();
    }
    return job.info;
  }

  cancel(taskId: string): TaskInfo {
    const job = this.require(taskId);
    if (isActive(job.state)) job.abort('cancel');
    else if (job.state === 'queued' || job.state === 'paused') {
      job.cleanup();
      job.info = { ...job.info, state: 'cancelled', updatedAt: Date.now() };
      this.ctx.onUpdate(job.info);
    }
    return job.info;
  }

  remove(taskId: string): void {
    const job = this.jobs.get(taskId);
    if (!job) return;
    if (!isTerminal(job.state)) this.cancel(taskId);
    this.jobs.delete(taskId);
    job.cleanup();
  }

  /** Pause everything (used when the browser disconnects); segment caches are kept for resume. */
  async shutdown(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [id, job] of this.jobs) {
      if (isActive(job.state)) {
        job.abort('shutdown');
      } else if (job.state === 'queued') job.markPaused();
      void id;
    }
    const start = Date.now();
    while (this.running.size > 0 && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
    await Promise.all(pending);
  }

  private require(taskId: string): DownloadJob {
    const job = this.jobs.get(taskId);
    if (!job) throw new Error(`Unknown task ${taskId}`);
    return job;
  }

  private schedule(): void {
    for (const job of this.jobs.values()) {
      if (this.running.size >= this.maxSimultaneous) return;
      if (job.state !== 'queued' || this.running.has(job.req.taskId)) continue;
      const id = job.req.taskId;
      this.running.add(id);
      void job.run().finally(() => {
        this.running.delete(id);
        this.schedule();
      });
    }
  }
}

/** Remove stale work directories (older than `maxAgeMs`) that no task refers to. */
export function pruneWorkDirs(workRoot: string, keep: Set<string>, maxAgeMs = 7 * 24 * 3600 * 1000): number {
  let removed = 0;
  if (!fs.existsSync(workRoot)) return 0;
  for (const name of fs.readdirSync(workRoot)) {
    if (keep.has(name)) continue;
    const full = path.join(workRoot, name);
    try {
      const st = fs.statSync(full);
      if (Date.now() - st.mtimeMs > maxAgeMs) {
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}
