import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalPolicy, commandArgv, commandCwd } from "./approval-policy.js";
import {
  ProjectCommandRuleStore,
  ruleDisplay,
} from "./project-command-rules.js";
import { SessionApprovalCache } from "./session-approval-cache.js";
import type { PermissionRequest } from "./types/events.js";

function writeReq(
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    id: "p1",
    call: { id: "c1", tool: "edit_file", input: { path: "x.txt" } },
    reason: "writes file",
    risk: "workspace_write",
    files: ["x.txt"],
    ...overrides,
  };
}

function cmdReq(
  argv: string[],
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    id: "p2",
    call: { id: "c2", tool: "run_command", input: { argv } },
    reason: "unknown command",
    risk: "workspace_write",
    code: "command_ask_unknown",
    ...overrides,
  };
}

const tmpDirs: string[] = [];
function mkRules(): ProjectCommandRuleStore {
  const dir = mkdtempSync(join(tmpdir(), "herta-approval-policy-"));
  tmpDirs.push(dir);
  return new ProjectCommandRuleStore(() => dir);
}
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

describe("ApprovalPolicy.preflight", () => {
  it("asks for a cacheable write and offers remember", () => {
    const policy = new ApprovalPolicy(new SessionApprovalCache());
    const pre = policy.preflight(writeReq());
    expect(pre.kind).toBe("ask");
    if (pre.kind !== "ask") throw new Error("unreachable");
    expect(pre.showRemember).toBe(true);
    expect(pre.projectRule).toBeUndefined();
  });

  it("does not offer remember for a destructive risk", () => {
    const policy = new ApprovalPolicy(new SessionApprovalCache());
    const pre = policy.preflight(writeReq({ risk: "workspace_destructive" }));
    expect(pre.kind).toBe("ask");
    if (pre.kind !== "ask") throw new Error("unreachable");
    expect(pre.showRemember).toBe(false);
  });

  it("auto-allows via the cache after a session commit", () => {
    const cache = new SessionApprovalCache();
    const policy = new ApprovalPolicy(cache);
    policy.commit(writeReq(), "session");
    const pre = policy.preflight(writeReq({ files: ["other.txt"] }));
    expect(pre).toMatchObject({ kind: "auto", via: "cache", scope: "task" });
  });

  it("a 'once' commit writes nothing", () => {
    const cache = new SessionApprovalCache();
    const policy = new ApprovalPolicy(cache);
    policy.commit(writeReq(), "once");
    expect(cache.size()).toBe(0);
    expect(policy.preflight(writeReq()).kind).toBe("ask");
  });

  it("offers the project rule only when one is derivable and a store exists", () => {
    const noRules = new ApprovalPolicy(new SessionApprovalCache());
    const pre1 = noRules.preflight(cmdReq(["npm", "run", "build"]));
    if (pre1.kind !== "ask") throw new Error("unreachable");
    expect(pre1.projectRule).toBeUndefined();

    const withRules = new ApprovalPolicy(new SessionApprovalCache(), mkRules());
    const pre2 = withRules.preflight(cmdReq(["npm", "run", "build"]));
    if (pre2.kind !== "ask") throw new Error("unreachable");
    expect(pre2.projectRule).toBe("npm run:*");
  });

  it("an 'always' commit persists the rule, cwd-scoped, and later matches", () => {
    const rules = mkRules();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules);
    policy.commit(
      cmdReq(["node", "scripts/x.mjs"], {
        call: {
          id: "c3",
          tool: "run_command",
          input: { argv: ["node", "scripts/x.mjs"], cwd: "sub" },
        },
      }),
      "always",
    );
    const sameCwd = policy.preflight(
      cmdReq(["node", "scripts/x.mjs", "--flag"], {
        call: {
          id: "c4",
          tool: "run_command",
          input: { argv: ["node", "scripts/x.mjs", "--flag"], cwd: "sub" },
        },
      }),
    );
    expect(sameCwd).toMatchObject({ kind: "auto", via: "project_rule" });
    // Audit BL15: the grant is scoped to the directory it was granted in.
    const otherCwd = policy.preflight(cmdReq(["node", "scripts/x.mjs"]));
    expect(otherCwd.kind).toBe("ask");
  });

  it("never lets a rule cover a non-rule-eligible ask code", () => {
    const rules = mkRules();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules);
    policy.commit(cmdReq(["npm", "run", "build"]), "always");
    expect(policy.preflight(cmdReq(["npm", "run", "build"]))).toMatchObject({
      kind: "auto",
      via: "project_rule",
    });
    const networkAsk = policy.preflight(
      cmdReq(["npm", "run", "build"], {
        code: "command_ask_network",
        risk: "network",
      }),
    );
    expect(networkAsk.kind).toBe("ask");
    // And an "always" on an ineligible code writes nothing.
    policy.commit(
      cmdReq(["curl", "http://x"], { code: "command_ask_network" }),
      "always",
    );
    expect(rules.list().map((r) => ruleDisplay(r))).toEqual(["npm run:*"]);
  });

  it("bash (minimal contract) uses the rule-derived argv", () => {
    const rules = mkRules();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules);
    const bashReq: PermissionRequest = {
      id: "p5",
      call: { id: "c5", tool: "bash", input: { command: "npm run build" } },
      reason: "unknown command",
      risk: "workspace_write",
      code: "command_ask_unknown",
      argv: ["npm", "run", "build"],
    };
    const pre = policy.preflight(bashReq);
    if (pre.kind !== "ask") throw new Error("unreachable");
    expect(pre.projectRule).toBe("npm run:*");
    policy.commit(bashReq, "always");
    expect(policy.preflight(bashReq)).toMatchObject({
      kind: "auto",
      via: "project_rule",
    });
  });
});

describe("commandArgv / commandCwd", () => {
  it("reads run_command argv and cwd, fail-closed on bad shapes", () => {
    expect(commandArgv(cmdReq(["git", "status"]))).toEqual(["git", "status"]);
    expect(
      commandArgv(
        cmdReq([], {
          call: { id: "c", tool: "run_command", input: { argv: ["a", 1] } },
        }),
      ),
    ).toBeNull();
    expect(commandArgv(writeReq())).toBeNull();
    expect(
      commandCwd(
        cmdReq([], {
          call: {
            id: "c",
            tool: "run_command",
            input: { argv: ["a"], cwd: "d" },
          },
        }),
      ),
    ).toBe("d");
    expect(commandCwd(cmdReq(["a"]))).toBeUndefined();
  });
});

describe("ApprovalPolicy — workspace trust (ADR 0064)", () => {
  const covered = (code: string, over: Partial<PermissionRequest> = {}) =>
    cmdReq(["git", "commit", "-m", "x"], { code, ...over });

  it("does not trust by default, and offers the grant on a covered class only", () => {
    const rules = mkRules();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules);
    expect(policy.workspaceTrusted()).toBe(false);
    const vcs = policy.preflight(covered("command_ask_vcs"));
    expect(vcs.kind).toBe("ask");
    if (vcs.kind !== "ask") throw new Error("unreachable");
    expect(vcs.showTrust).toBe(true);
    // Not covered: network, destructive, outside, unknown, unresolved.
    for (const [code, risk] of [
      ["command_ask_network", "network"],
      ["command_ask_destructive", "workspace_destructive"],
      ["command_ask_outside", "workspace_write"],
      ["command_ask_unknown", "workspace_write"],
      ["command_ask_unresolved", "workspace_write"],
      ["command_ask_interpreter_inline", "workspace_write"],
      ["command_ask_process", "workspace_write"],
    ] as const) {
      const pre = policy.preflight(covered(code, { risk }));
      expect(pre.kind, code).toBe("ask");
      if (pre.kind !== "ask") throw new Error("unreachable");
      expect(pre.showTrust, code).toBe(false);
    }
    // A chained line: every class must be covered.
    const mixed = policy.preflight(
      covered("command_ask_vcs", {
        codes: ["command_ask_vcs", "command_ask_network"],
      }),
    );
    if (mixed.kind !== "ask") throw new Error("unreachable");
    expect(mixed.showTrust).toBe(false);
    // Without a rule store there is nowhere to record the choice.
    const bare = new ApprovalPolicy(new SessionApprovalCache());
    const b = bare.preflight(covered("command_ask_vcs"));
    if (b.kind !== "ask") throw new Error("unreachable");
    expect(b.showTrust).toBe(false);
  });

  it("a 'trust' commit persists workspace trust; covered asks then auto-allow, the rest still ask", () => {
    const rules = mkRules();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules);
    policy.commit(covered("command_ask_vcs"), "trust");
    expect(rules.trust()).toBe("workspace");
    expect(policy.workspaceTrusted()).toBe(true);
    expect(policy.preflight(covered("command_ask_vcs"))).toMatchObject({
      kind: "auto",
      via: "workspace_trust",
    });
    expect(policy.preflight(writeReq({ code: "edit_file_ask" }))).toMatchObject(
      { kind: "auto", via: "workspace_trust", scope: "task" },
    );
    expect(
      policy.preflight(
        covered("command_ask_recursive_read", { risk: "workspace_read" }),
      ),
    ).toMatchObject({ kind: "auto", via: "workspace_trust" });
    const net = policy.preflight(
      covered("command_ask_network", { risk: "network" }),
    );
    expect(net.kind).toBe("ask");
    if (net.kind !== "ask") throw new Error("unreachable");
    expect(net.showTrust).toBe(false); // already trusted — nothing to offer
    // An ask with NO class is never covered (the tier is earned, not assumed).
    expect(policy.preflight(writeReq()).kind).toBe("ask");
  });

  it("a 'trust' commit on an uncovered request writes nothing", () => {
    const rules = mkRules();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules);
    policy.commit(covered("command_ask_network", { risk: "network" }), "trust");
    expect(rules.trust()).toBeNull();
    expect(policy.workspaceTrusted()).toBe(false);
  });

  it("the host's default applies until the owner chooses; an explicit choice beats it either way", () => {
    const rules = mkRules();
    let sandbox = true;
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules, {
      defaultTrust: () => sandbox,
    });
    expect(policy.workspaceTrusted()).toBe(true);
    expect(policy.preflight(covered("command_ask_fs"))).toMatchObject({
      kind: "auto",
      via: "workspace_trust",
    });
    // The workspace moved to a real project: the default flips with it.
    sandbox = false;
    expect(policy.workspaceTrusted()).toBe(false);
    // The owner turned trust OFF on the sandbox: explicit wins.
    sandbox = true;
    rules.setTrust("ask");
    expect(policy.workspaceTrusted()).toBe(false);
    const pre = policy.preflight(covered("command_ask_fs"));
    if (pre.kind !== "ask") throw new Error("unreachable");
    expect(pre.showTrust).toBe(true);
    rules.setTrust(null);
    expect(policy.workspaceTrusted()).toBe(true);
  });
});
