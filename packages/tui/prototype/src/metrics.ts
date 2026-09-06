export interface RunMetrics {
  impl: string;
  layout: string;
  frames: number;
  fullRedraws: number;
  bytesWritten: number;
  writeCalls: number;
  frameMs: number[];
  approvalLatencyMs: number | null;
  cancelLatencyMs: number | null;
  resizes: number;
  scrollActions: number;
  changedRows: number;
  candidateRows: number;
  durationMs: number;
  notes: string[];
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

export class Metrics {
  frames = 0;
  fullRedraws = 0;
  frameMs: number[] = [];
  approvalLatencyMs: number | null = null;
  cancelLatencyMs: number | null = null;
  resizes = 0;
  scrollActions = 0;
  changedRows = 0;
  candidateRows = 0;
  notes: string[] = [];

  private frameStart = 0;
  private readonly startedAt = performance.now();
  private approvalShownAt: number | null = null;
  private cancelPressedAt: number | null = null;

  beginFrame(): void {
    this.frameStart = performance.now();
  }

  endFrame(full = false): void {
    this.frames += 1;
    if (full) this.fullRedraws += 1;
    this.frameMs.push(performance.now() - this.frameStart);
  }

  approvalShown(): void {
    this.approvalShownAt ??= performance.now();
  }

  approvalAnswered(): void {
    if (this.approvalShownAt !== null && this.approvalLatencyMs === null) {
      this.approvalLatencyMs = performance.now() - this.approvalShownAt;
    }
  }

  cancelPressed(): void {
    this.cancelPressedAt ??= performance.now();
  }

  cancelAcknowledged(): void {
    if (this.cancelPressedAt !== null && this.cancelLatencyMs === null) {
      this.cancelLatencyMs = performance.now() - this.cancelPressedAt;
    }
  }

  note(text: string): void {
    this.notes.push(text);
  }

  finish(impl: string, layout: string, io: { bytes: number; writes: number }): RunMetrics {
    return {
      impl,
      layout,
      frames: this.frames,
      fullRedraws: this.fullRedraws,
      bytesWritten: io.bytes,
      writeCalls: io.writes,
      frameMs: this.frameMs,
      approvalLatencyMs: this.approvalLatencyMs,
      cancelLatencyMs: this.cancelLatencyMs,
      resizes: this.resizes,
      scrollActions: this.scrollActions,
      changedRows: this.changedRows,
      candidateRows: this.candidateRows,
      durationMs: performance.now() - this.startedAt,
      notes: this.notes,
    };
  }
}

export interface StdoutCounter {
  bytes: number;
  writes: number;
  reset(): void;
  restore(): void;
}

export function countStdout(): StdoutCounter {
  const stream = process.stdout;
  const original = stream.write.bind(stream);
  const counter: StdoutCounter = {
    bytes: 0,
    writes: 0,
    reset() {
      counter.bytes = 0;
      counter.writes = 0;
    },
    restore() {
      stream.write = original as typeof stream.write;
    },
  };

  // biome-ignore lint/suspicious/noExplicitAny: throwaway shim over the Writable.write overloads
  stream.write = ((chunk: any, encoding?: any, callback?: any) => {
    counter.writes += 1;
    counter.bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : (chunk?.length ?? 0);
    return original(chunk, encoding, callback);
  }) as typeof stream.write;

  return counter;
}
