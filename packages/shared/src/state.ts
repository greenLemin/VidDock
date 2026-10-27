/** Task state machine. */
import type { TaskState } from './types.ts';

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ['preparing', 'downloading', 'paused', 'cancelled', 'failed'],
  preparing: ['downloading', 'processing', 'paused', 'cancelled', 'failed', 'queued'],
  downloading: ['processing', 'completed', 'paused', 'cancelled', 'failed', 'queued', 'preparing'],
  processing: ['verifying', 'completed', 'paused', 'cancelled', 'failed', 'queued'],
  verifying: ['completed', 'failed', 'cancelled', 'queued'],
  completed: [],
  paused: ['queued', 'preparing', 'downloading', 'cancelled', 'failed'],
  failed: ['queued'],
  cancelled: ['queued'],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function isTerminal(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

export function isActive(state: TaskState): boolean {
  return state === 'preparing' || state === 'downloading' || state === 'processing' || state === 'verifying';
}

/** States that count against the "max simultaneous downloads" limit. */
export function occupiesSlot(state: TaskState): boolean {
  return isActive(state);
}

export function emptyProgress() {
  return {
    bytesDownloaded: 0,
    bytesPerSec: 0,
    segmentsDone: 0,
    segmentsTotal: 0,
    percent: 0,
    elapsedMs: 0,
  };
}
