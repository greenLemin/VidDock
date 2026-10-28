import type { HelloData, HostMessage, HostRequest } from '@viddock/shared';
import { NATIVE_HOST_NAME } from '@viddock/shared';
import type { NativeStatus } from '@viddock/shared';
import type { TaskInfo } from '@viddock/shared';

export type TaskUpdateListener = (task: TaskInfo) => void;
export type StatusUpdateListener = (status: NativeStatus) => void;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type HostRequestBody = DistributiveOmit<HostRequest, 'id'>;

export class NativeClient {
  private port: chrome.runtime.Port | null = null;
  private backoffMs = 1000;
  private readonly MAX_BACKOFF = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private status: NativeStatus = { connected: false };
  private taskListeners = new Set<TaskUpdateListener>();
  private statusListeners = new Set<StatusUpdateListener>();

  constructor() {
    this.connect();
  }

  getStatus(): NativeStatus {
    return { ...this.status };
  }

  onTaskUpdate(listener: TaskUpdateListener): () => void {
    this.taskListeners.add(listener);
    return () => this.taskListeners.delete(listener);
  }

  onStatusChange(listener: StatusUpdateListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  connect(): void {
    if (this.port) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      this.port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      this.port.onMessage.addListener((msg: HostMessage) => this.handleMessage(msg));
      this.port.onDisconnect.addListener(() => this.handleDisconnect());

      // Perform handshake
      this.sendRequest<HelloData>({ type: 'hello' }, 10000)
        .then((hello) => {
          this.status = {
            connected: true,
            version: hello.version,
            ffmpeg: hello.ffmpeg,
            ffprobe: hello.ffprobe,
            platform: hello.platform,
            defaultOutputDir: hello.defaultOutputDir,
          };
          this.backoffMs = 1000;
          this.broadcastStatus();
        })
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.status = { connected: false, error: errMsg };
          this.broadcastStatus();
        });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Connection failed';
      this.status = { connected: false, error: errMsg };
      this.broadcastStatus();
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      this.pendingRequests.delete(id);
    }
    if (this.port) {
      try {
        this.port.disconnect();
      } catch {}
      this.port = null;
    }
    this.status = { connected: false };
    this.broadcastStatus();
  }

  private handleDisconnect(): void {
    const lastError = chrome.runtime.lastError?.message || 'Native host disconnected';
    this.port = null;
    this.status = { connected: false, error: lastError };

    // Reject all pending requests
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error(lastError));
      this.pendingRequests.delete(id);
    }

    this.broadcastStatus();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const jitter = 0.8 + Math.random() * 0.4; // 80% to 120%
    const delay = Math.round(this.backoffMs * jitter);
    this.backoffMs = Math.min(this.backoffMs * 1.5, this.MAX_BACKOFF);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private broadcastStatus(): void {
    const current = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(current);
      } catch {}
    }
  }

  private handleMessage(msg: HostMessage): void {
    if (msg.type === 'reply') {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.data);
        } else {
          pending.reject(new Error(msg.error));
        }
      }
    } else if (msg.type === 'task.update') {
      for (const listener of this.taskListeners) {
        try {
          listener(msg.task);
        } catch {}
      }
    }
  }

  sendRequest<T = unknown>(req: HostRequestBody, timeoutMs = 15000): Promise<T> {
    if (!this.port) {
      this.connect();
      if (!this.port) {
        return Promise.reject(new Error('Native companion not connected'));
      }
    }

    const id = (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)) as string;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Host request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (val: unknown) => resolve(val as T),
        reject,
        timer,
      });

      try {
        this.port!.postMessage({ id, ...req });
      } catch (err: unknown) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }
}

export const nativeClient = new NativeClient();
