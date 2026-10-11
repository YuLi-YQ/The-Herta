export interface Style {
  dim(s: string): string;
  bright(s: string): string;
  cyan(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  bold(s: string): string;
  reset: string;
  enabled: boolean;
}

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

function wrap(code: string, enabled: boolean): (s: string) => string {
  if (!enabled) return (s) => s;
  return (s) => `${ESC}${code}${s}${RESET}`;
}

export function makeStyle(opts: { enabled: boolean }): Style {
  const e = opts.enabled;
  return {
    dim: wrap("2m", e),
    bright: wrap("96m", e),
    cyan: wrap("36m", e),
    red: wrap("31m", e),
    green: wrap("32m", e),
    yellow: wrap("33m", e),
    bold: wrap("1m", e),
    reset: e ? RESET : "",
    enabled: e,
  };
}
