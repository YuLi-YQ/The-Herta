import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPathInside } from "@herta/core";
import { PLUGIN_NETWORK_DEFAULT_CONFIG, parsePluginNetworkConfig } from "../../shared/plugin-network-settings.js";
import { PluginNetworkSettingsStore, PLUGIN_NETWORK_SETTINGS_FILE } from "./plugin-network-settings-store.js";

const roots: string[] = [];
async function fixture() { const profile = await fs.mkdtemp(join(tmpdir(), "herta-network-settings-")); roots.push(profile); return { profile, file: join(profile, PLUGIN_NETWORK_SETTINGS_FILE), store: new PluginNetworkSettingsStore(profile) }; }
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) { const absolute = resolve(root);
  if (!isPathInside(resolve(tmpdir()), absolute, { strict: true }) || !basename(absolute).startsWith("herta-network-settings-") || (await fs.lstat(absolute)).isSymbolicLink()) throw Error("Unsafe fixture cleanup");
  await fs.rm(absolute, { recursive: true, force: true });
} });

describe("R147 network settings", () => {
  it("R147 settings persist canonical explicit endpoints and reject stale or unsafe changes", async () => {
    const f = await fixture();
    expect(await f.store.load()).toEqual({ revision: 0, config: PLUGIN_NETWORK_DEFAULT_CONFIG }); expect(await fs.readdir(f.profile)).toEqual([]);
    const config = parsePluginNetworkConfig({ ...PLUGIN_NETWORK_DEFAULT_CONFIG, mode: "proxy", proxyUrl: "http://127.0.0.1:8080/", resolver: "doh", dohUrl: "https://dns.fixture.invalid/query", dohBootstrapAddress: "1.1.1.1" });
    const unlink = vi.spyOn(fs, "unlink").mockRejectedValueOnce(Error("synthetic temporary cleanup failure"));
    const saved = await f.store.save(0, config); expect(saved).toMatchObject({ revision: 1, config: { proxyUrl: "http://127.0.0.1:8080" } });
    unlink.mockRestore(); expect((await fs.stat(f.file)).nlink).toBe(2);
    expect(await new PluginNetworkSettingsStore(f.profile).load()).toEqual(saved); expect(await f.store.save(1, config)).toEqual(saved);
    const original = await fs.readFile(f.file, "utf8");
    await expect(f.store.save(0, PLUGIN_NETWORK_DEFAULT_CONFIG)).rejects.toMatchObject({ reason: "conflict" });
    for (const change of [{ proxyUrl: "http://localhost:8080" }, { proxyUrl: "http://127.0.0.1:0" }, { proxyUrl: "http://user:secret@127.0.0.1:8080" },
      { dohUrl: "https://dns.fixture.invalid/query?name=anything" }, { dohBootstrapAddress: "198.18.0.22" }]) {
      await expect(f.store.save(1, { ...config, ...change })).rejects.toMatchObject({ reason: "invalid" });
    }
    expect(await fs.readFile(f.file, "utf8")).toBe(original); expect(f.store.current()).toEqual(saved);
    await fs.unlink(f.file); const vanished = await f.store.load(); expect(vanished.loadError).toBeTruthy();
    const explicitlyReset = await f.store.save(vanished.revision, PLUGIN_NETWORK_DEFAULT_CONFIG); expect(explicitlyReset.loadError).toBeUndefined();
  });

  it("R147 settings keep corrupt data blocked and archive it before explicit bounded repair", async () => {
    const f = await fixture(), original = "{synthetic broken config"; await fs.writeFile(f.file, original);
    const damaged = await f.store.load(); expect(damaged.loadError).toBeTruthy(); expect(damaged.config).toEqual(PLUGIN_NETWORK_DEFAULT_CONFIG);
    expect(await fs.readdir(f.profile)).toEqual([PLUGIN_NETWORK_SETTINGS_FILE]);
    const repaired = await f.store.save(damaged.revision, PLUGIN_NETWORK_DEFAULT_CONFIG);
    expect(repaired.loadError).toBeUndefined(); expect(repaired.revision).toBeGreaterThan(damaged.revision);
    const archive = join(f.profile, "plugin-network-settings-archives"), archived = createHash("sha256").update(original).digest("hex") + ".json";
    expect(await fs.readFile(join(archive, archived), "utf8")).toBe(original);
    for (let i = 0; i < 7; i++) await fs.writeFile(join(archive, `preserved-${i}.json`), "synthetic retained record");
    await fs.writeFile(f.file, "{another damaged config"); const again = await f.store.load();
    await expect(f.store.save(again.revision, PLUGIN_NETWORK_DEFAULT_CONFIG)).rejects.toMatchObject({ reason: "archive" });
    expect(await fs.readFile(f.file, "utf8")).toBe("{another damaged config"); expect(f.store.current().loadError).toBeTruthy();
    expect(await fs.readdir(archive)).toHaveLength(8);
  });
});
