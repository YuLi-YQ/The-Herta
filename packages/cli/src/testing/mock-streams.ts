import { Readable, Writable } from "node:stream";

export class MockWritable extends Writable {
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(
      typeof chunk === "string" ? chunk : chunk.toString("utf8"),
    );
    callback();
  }

  full(): string {
    return this.chunks.join("");
  }
}

export class MockReadable extends Readable {
  private queue: (string | null)[] = [];

  override _read(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === null) {
        this.push(null);
        return;
      }
      if (next === undefined) return;
      if (!this.push(next)) return;
    }
  }

  feed(chunk: string): void {
    this.queue.push(chunk);
    // biome-ignore lint/suspicious/noExplicitAny: Readable's internal buffer kick
    (this as any)._read();
  }

  end(): void {
    this.queue.push(null);
    // biome-ignore lint/suspicious/noExplicitAny: Readable's internal buffer kick
    (this as any)._read();
  }
}
