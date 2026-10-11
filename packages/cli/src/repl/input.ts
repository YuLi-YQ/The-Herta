import { createInterface, type Interface } from "node:readline";

export class Input {
  private rl: Interface;
  private closed = false;

  constructor(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) {
    this.rl = createInterface({
      input: stdin,
      output: stdout,
      terminal: false,
    });
    this.rl.on("close", () => {
      this.closed = true;
    });
  }

  readLine(prompt: string): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      let onLine: ((line: string) => void) | null = null;
      let onClose: (() => void) | null = null;

      onLine = (line: string): void => {
        if (onClose) this.rl.off("close", onClose);
        resolve(line);
      };
      onClose = (): void => {
        if (onLine) this.rl.off("line", onLine);
        resolve(null);
      };

      this.rl.once("line", onLine);
      this.rl.once("close", onClose);
      this.rl.setPrompt(prompt);
      try {
        this.rl.prompt();
      } catch {
        // readline was closed mid-prompt; treat as EOF.
        if (onLine) this.rl.off("line", onLine);
        if (onClose) this.rl.off("close", onClose);
        resolve(null);
      }
    });
  }

  pause(): void {
    this.rl.pause();
  }

  resume(): void {
    this.rl.resume();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rl.close();
  }
}
