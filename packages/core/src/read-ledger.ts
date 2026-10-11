export interface ReadLedgerEntry {
  sha256: string;
  atTs: Date;
}

export class ReadLedger {
  private readonly entries = new Map<string, ReadLedgerEntry>();

  record(absPath: string, sha256: string, atTs?: Date): void {
    this.entries.set(absPath, { sha256, atTs: atTs ?? new Date() });
  }

  get(absPath: string): ReadLedgerEntry | undefined {
    return this.entries.get(absPath);
  }

  clear(absPath?: string): void {
    if (absPath === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(absPath);
  }
}
