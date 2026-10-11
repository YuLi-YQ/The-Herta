import { basename } from "node:path";
import { getCurrentPermissionProtectedPaths } from "@herta/core";
import { classifyCommand } from "./run-command/classifier.js";

/** Conservative: test runners/interpreters can write even when their old tier allows. */
export function isReadOnlyArgv(argv: readonly string[]): boolean {
  const program = basename(argv[0] ?? "")
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (
    ![
      "cat",
      "head",
      "tail",
      "ls",
      "pwd",
      "wc",
      "grep",
      "rg",
      "stat",
      "echo",
      "printf",
      "git",
    ].includes(program)
  )
    return false;
  if (argv.some((a) => a.includes(String.fromCharCode(0)) || /[\r\n]/.test(a)))
    return false;
  if (
    program === "git" &&
    !["status", "diff", "log", "show", "rev-parse", "ls-files"].includes(
      argv[1] ?? "",
    )
  )
    return false;
  return classifyCommand(argv).kind === "allow";
}

export function isReadOnlyShell(command: string): boolean {
  // A single literal reader only. No substitutions, redirects or persisted shell state.
  if (/[;|&<>`$\n\r{}()\\]/.test(command)) return false;
  const words =
    command
      .match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)
      ?.map((word) => word.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
  return isReadOnlyArgv(words);
}

export function namesNetworkAccess(argv: readonly string[]): boolean {
  const program = basename(argv[0] ?? "")
    .toLowerCase()
    .replace(/\.exe$/, "");
  return (
    ["curl", "wget", "ssh", "scp", "sftp", "ping", "nc", "ncat"].includes(
      program,
    ) ||
    argv.some((a) =>
      /https?:\/\/|\bfetch\s*\(|https?\.(get|request)|Invoke-WebRequest|Invoke-RestMethod/i.test(
        a,
      ),
    )
  );
}

export function namesProtectedApplicationPath(text: string): boolean {
  const normalize = (value: string) => value.replace(/\\+/g, "/").toLowerCase();
  const normalized = normalize(text);
  return getCurrentPermissionProtectedPaths().some((root) =>
    normalized.includes(normalize(root)),
  );
}
