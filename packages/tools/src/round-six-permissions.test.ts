import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  InMemoryToolRegistry,
  type PermissionModeState,
  RulePermissionEngine,
  withPermissionMode,
} from "@herta/core";
import { afterEach, expect, it } from "vitest";
import { readFileTool } from "./read-file/index.js";
import { classifyCommand } from "./run-command/classifier.js";
import { runCommandTool } from "./run-command/index.js";
import { registerRunCommandRule } from "./run-command/rule.js";
import { mkTmpWorkspace, type TmpWorkspace } from "./testing/tmp-workspace.js";
import { mkToolContext } from "./testing/tool-context.js";
import { writeNewFileTool } from "./write-new-file/index.js";
import { registerWriteNewFileRule } from "./write-new-file/rule.js";

let tmp: TmpWorkspace | undefined;
it("full-access permits ordinary managed-workspace files and git policy paths while protecting its own state", async () => {
  const s = await setup();
  s.set("full-access");
  const workspaceRoot = join(s.outside, ".herta", "workspaces", "isolated");
  await mkdir(workspaceRoot, { recursive: true });
  const ctx = { ...s.ctx, workspaceRoot };
  const call = (path: string) => ({
    id: path,
    tool: "write_new_file",
    input: { path, content: "synthetic-only\n" },
  });
  expect((await s.registry.run(call("ordinary.txt"), ctx, () => {})).ok).toBe(
    true,
  );
  expect(
    (await s.registry.run(call(".git/synthetic-policy.txt"), ctx, () => {})).ok,
  ).toBe(true);
  expect(
    (await s.registry.run(call(".herta/permissions.json"), ctx, () => {})).error
      ?.code,
  ).toBe("path_denied");
  expect(await readFile(join(workspaceRoot, "ordinary.txt"), "utf8")).toBe(
    "synthetic-only\n",
  );
});
afterEach(async () => {
  await tmp?.cleanup();
  tmp = undefined;
});

it("network requests require workspace approval, are denied read-only, and execute without per-step approval in full-access", async () => {
  const s = await setup();
  const server = createServer((_request, response) =>
    response.end("local-network-confirmed"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");
    const call = {
      id: "network",
      tool: "run_command",
      input: {
        argv: [
          process.execPath,
          "-e",
          `fetch('http://127.0.0.1:${address.port}').then(r=>r.text()).then(t=>process.stdout.write(t))`,
        ],
        timeoutMs: 5000,
      },
    };
    s.set("read-only");
    expect((await s.permissions.check(call, s.ctx)).kind).toBe("deny");
    s.set("workspace-edit");
    const networkApproval = await s.permissions.check(call, s.ctx);
    expect(networkApproval.kind).toBe("ask");
    if (networkApproval.kind === "ask") await networkApproval.decision;
    s.set("full-access");
    expect((await s.permissions.check(call, s.ctx)).kind).toBe("allow");
    const result = await s.registry.run(call, s.ctx, () => {});
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).toContain("local-network-confirmed");
    expect(s.asks()).toBe(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("full-access removes general root-path policy but never executes destructive test commands", async () => {
  const s = await setup();
  s.set("workspace-edit");
  expect(
    withPermissionMode(s.ctx, () => classifyCommand(["rm", "-rf", "/"])).kind,
  ).toBe("block");
  s.set("full-access");
  expect(
    withPermissionMode(s.ctx, () => classifyCommand(["rm", "-rf", "/"])).kind,
  ).toBe("ask");
  // Pure classification only: no real destructive command is spawned.
  expect(
    withPermissionMode(s.ctx, () =>
      classifyCommand(["cmd", "/c", "echo x > .herta/permissions.json"], {
        writeGuard: {
          path: () => null,
          body: () => "harness state is protected",
        },
      }),
    ).kind,
  ).toBe("block");
});

it("full-access keeps host permission/credential storage protected through realpath aliases and direct commands", async () => {
  const s = await setup();
  const protectedRoot = join(s.outside, "isolated-application-data");
  await mkdir(protectedRoot);
  const file = join(protectedRoot, "project-navigation.json");
  await writeFile(file, "owner-choice");
  const ctx = { ...s.ctx, permissionProtectedPaths: [protectedRoot] };
  s.set("full-access");
  await symlink(
    protectedRoot,
    join(ctx.workspaceRoot, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(
    (
      await s.registry.run(
        {
          id: "protected-read",
          tool: "read_file",
          input: { path: "alias/project-navigation.json" },
        },
        ctx,
        () => {},
      )
    ).error?.code,
  ).toBe("path_denied");
  expect(
    (
      await s.permissions.check(
        {
          id: "protected-write",
          tool: "write_new_file",
          input: { path: join(protectedRoot, "new-file"), content: "fake" },
        },
        ctx,
      )
    ).kind,
  ).toBe("deny");
  const command = {
    id: "protected-command",
    tool: "run_command",
    input: {
      argv: [
        process.execPath,
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(file)},'fake')`,
      ],
    },
  };
  expect((await s.permissions.check(command, ctx)).kind).toBe("deny");
  expect((await s.registry.run(command, ctx, () => {})).ok).toBe(false);
  expect(await readFile(file, "utf8")).toBe("owner-choice");
});
async function setup() {
  tmp = await mkTmpWorkspace({});
  const root = join(tmp.root, "project");
  const outside = join(tmp.root, "second-isolated-directory");
  await mkdir(root);
  await mkdir(outside);
  let state: PermissionModeState = { mode: "workspace-edit", revision: 1 };
  const ctx = {
    ...mkToolContext({ workspaceRoot: root }),
    getPermissionMode: () => state,
  };
  const registry = new InMemoryToolRegistry();
  registry.register(writeNewFileTool());
  registry.register(readFileTool());
  registry.register(runCommandTool());
  let asks = 0;
  const permissions = new RulePermissionEngine({
    ask: {
      async present() {
        asks++;
        return "allow";
      },
    },
  });
  registerWriteNewFileRule(permissions);
  registerRunCommandRule(permissions);
  return {
    ctx,
    registry,
    permissions,
    outside,
    asks: () => asks,
    set(mode: PermissionModeState["mode"]) {
      state = { mode, revision: state.revision + 1 };
    },
  };
}
it("three modes genuinely write or refuse isolated files, including full-access outside the project", async () => {
  const s = await setup();
  const call = (path: string) => ({
    id: path,
    tool: "write_new_file",
    input: { path, content: "verified\n" },
  });
  s.set("read-only");
  expect((await s.permissions.check(call("read-only.txt"), s.ctx)).kind).toBe(
    "deny",
  );
  expect(
    (await s.registry.run(call("read-only.txt"), s.ctx, () => {})).ok,
  ).toBe(false);
  s.set("workspace-edit");
  expect((await s.permissions.check(call("inside.txt"), s.ctx)).kind).toBe(
    "allow",
  );
  expect((await s.registry.run(call("inside.txt"), s.ctx, () => {})).ok).toBe(
    true,
  );
  expect(await readFile(join(s.ctx.workspaceRoot, "inside.txt"), "utf8")).toBe(
    "verified\n",
  );
  const external = join(s.outside, "outside.txt");
  const boundary = await s.permissions.check(call(external), s.ctx);
  expect(boundary.kind).toBe("ask");
  if (boundary.kind === "ask") expect(await boundary.decision).toBe("allow");
  expect((await s.registry.run(call(external), s.ctx, () => {})).ok).toBe(true);
  const externalFull = join(s.outside, "outside-full.txt");
  s.set("full-access");
  expect((await s.permissions.check(call(externalFull), s.ctx)).kind).toBe(
    "allow",
  );
  expect((await s.registry.run(call(externalFull), s.ctx, () => {})).ok).toBe(
    true,
  );
  expect(await readFile(externalFull, "utf8")).toBe("verified\n");
  expect(s.asks()).toBe(1);
  s.set("read-only");
  expect(
    (await s.registry.run(call("after-downgrade.txt"), s.ctx, () => {})).ok,
  ).toBe(false);
});
it("real commands cannot mutate in read-only, execute outside in full-access and keep input/environment integrity", async () => {
  const s = await setup();
  const call = {
    id: "command",
    tool: "run_command",
    input: {
      argv: [
        process.execPath,
        "-e",
        "require('fs').writeFileSync('command.txt','done')",
      ],
      cwd: s.outside,
      timeoutMs: 5000,
    },
  };
  s.set("read-only");
  expect((await s.permissions.check(call, s.ctx)).kind).toBe("deny");
  expect((await s.registry.run(call, s.ctx, () => {})).ok).toBe(false);
  s.set("full-access");
  expect((await s.permissions.check(call, s.ctx)).kind).toBe("allow");
  expect((await s.registry.run(call, s.ctx, () => {})).ok).toBe(true);
  expect(await readFile(join(s.outside, "command.txt"), "utf8")).toBe("done");
  expect(s.asks()).toBe(0);
  expect(
    (
      await s.registry.run(
        {
          ...call,
          input: { ...call.input, env: { NODE_OPTIONS: "--inspect" } },
        },
        s.ctx,
        () => {},
      )
    ).error?.code,
  ).toBe("env_key_denied");
  await writeFile(join(s.outside, ".env"), "synthetic-non-secret\n");
  expect(
    (
      await s.permissions.check(
        { ...call, input: { ...call.input, permissionMode: "full-access" } },
        s.ctx,
      )
    ).kind,
  ).toBe("deny");
  expect(
    (
      await s.registry.run(
        {
          id: "synthetic-env",
          tool: "read_file",
          input: { path: join(s.outside, ".env") },
        },
        s.ctx,
        () => {},
      )
    ).ok,
  ).toBe(true);
});
