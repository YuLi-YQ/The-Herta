import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderPromptFrame,
} from "../types/provider.js";

export type ScriptedTurn =
  | ProviderEvent[]
  | ((frame: ProviderPromptFrame) => ProviderEvent[]);

export interface FakeProviderScript {
  turns: ScriptedTurn[];
}

class AbortError extends Error {
  override readonly name = "AbortError";
  constructor() {
    super("aborted");
  }
}

export class FakeProvider implements ProviderAdapter {
  private turnIndex = 0;

  constructor(private readonly script: FakeProviderScript) {}

  async *streamChat(
    frame: ProviderPromptFrame,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    if (signal.aborted) throw new AbortError();
    if (this.turnIndex >= this.script.turns.length) {
      throw new Error("FakeProvider script exhausted");
    }
    const next = this.script.turns[this.turnIndex];
    this.turnIndex += 1;
    if (next === undefined) throw new Error("FakeProvider script exhausted");
    const events = typeof next === "function" ? next(frame) : next;
    for (const event of events) {
      if (signal.aborted) throw new AbortError();
      yield event;
    }
  }
}
