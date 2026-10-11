import { describe, expect, it } from "vitest";
import {
  classifyStatus,
  cloneVoice,
  type FetchLike,
  listClones,
  MiniMaxError,
  makeVoiceId,
  probeHost,
  synthesizePcm,
  uploadReference,
} from "./minimax-api.js";

/** A fake MiniMax: answers per (host, path) with a body, records calls. */
function fake(
  routes: Record<string, (init: Parameters<FetchLike>[1]) => unknown>,
): {
  fetch: FetchLike;
  calls: { url: string; init: Parameters<FetchLike>[1] }[];
} {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) return new Response("nope", { status: 404 });
    const out = route(init);
    return new Response(typeof out === "string" ? out : JSON.stringify(out), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

const ok = { base_resp: { status_code: 0, status_msg: "success" } };
const badKey = {
  base_resp: { status_code: 2049, status_msg: "invalid api key" },
};

describe("classifyStatus", () => {
  it("maps the codes and messages the app acts on", () => {
    expect(classifyStatus(2049, "invalid api key")).toBe("invalid_key");
    expect(classifyStatus(1004, "authentication failed")).toBe("auth");
    expect(classifyStatus(1002, "rate limit exceeded")).toBe("rate");
    expect(classifyStatus(1039, "TPM rate limit exceeded")).toBe("rate");
    expect(classifyStatus(1008, "insufficient balance")).toBe("quota");
    expect(classifyStatus(2013, "voice_id not found")).toBe("voice_missing");
    expect(classifyStatus(2054, "voice id not exist")).toBe("voice_missing");
    expect(classifyStatus(2013, "invalid params")).toBe("invalid");
    expect(classifyStatus(1000, "unknown error")).toBe("other");
  });
});

describe("probeHost", () => {
  it("returns the host whose answer proves the key authenticated — a parameter complaint counts", async () => {
    const { fetch, calls } = fake({
      "https://a.example/v1/get_voice": () => badKey,
      "https://b.example/v1/get_voice": () => ({
        base_resp: { status_code: 2013, status_msg: "invalid params" },
      }),
    });
    await expect(
      probeHost(fetch, "k", undefined, [
        "https://a.example",
        "https://b.example",
      ]),
    ).resolves.toBe("https://b.example");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init.headers?.Authorization).toBe("Bearer k");
  });

  it("throws invalid_key when neither platform accepts the key", async () => {
    const { fetch } = fake({
      "https://a.example/v1/get_voice": () => badKey,
      "https://b.example/v1/get_voice": () => badKey,
    });
    await expect(
      probeHost(fetch, "k", undefined, [
        "https://a.example",
        "https://b.example",
      ]),
    ).rejects.toMatchObject({ reason: "invalid_key" });
  });

  // A key that is nobody's gets 1004 "login fail" from BOTH platforms
  // (measured against the real hosts 2026-09-08). The first cut read that
  // as "authenticated, whatever else it disliked" and stored the wrong key
  // as 已连接 — the owner typed a wrong key and watched it happen.
  it("a 1004 login failure is not authentication: both hosts → invalid_key; one host → the other", async () => {
    const loginFail = {
      base_resp: {
        status_code: 1004,
        status_msg:
          "login fail: Please carry the API secret key in the 'Authorization' field of the request header",
      },
    };
    const both = fake({
      "https://a.example/v1/get_voice": () => loginFail,
      "https://b.example/v1/get_voice": () => loginFail,
    });
    await expect(
      probeHost(both.fetch, "k", undefined, [
        "https://a.example",
        "https://b.example",
      ]),
    ).rejects.toMatchObject({ reason: "invalid_key" });
    expect(both.calls).toHaveLength(2);
    const one = fake({
      "https://a.example/v1/get_voice": () => loginFail,
      "https://b.example/v1/get_voice": () => ok,
    });
    await expect(
      probeHost(one.fetch, "k", undefined, [
        "https://a.example",
        "https://b.example",
      ]),
    ).resolves.toBe("https://b.example");
  });

  it("a host that is unreachable is skipped, and reported only if none answered", async () => {
    const failing: FetchLike = async (url, init) => {
      if (url.startsWith("https://a.example"))
        throw new TypeError("ECONNRESET");
      return fake({ "https://b.example/v1/get_voice": () => ok }).fetch(
        url,
        init,
      );
    };
    await expect(
      probeHost(failing, "k", undefined, [
        "https://a.example",
        "https://b.example",
      ]),
    ).resolves.toBe("https://b.example");
    const dead: FetchLike = async () => {
      throw new TypeError("ECONNRESET");
    };
    await expect(
      probeHost(dead, "k", undefined, ["https://a.example"]),
    ).rejects.toMatchObject({ reason: "network" });
  });
});

describe("listClones + makeVoiceId", () => {
  it("lists the account's clones as get_voice reports them, skipping malformed rows", async () => {
    const { fetch, calls } = fake({
      "https://b.example/v1/get_voice": () => ({
        ...ok,
        voice_cloning: [
          { voice_id: "herta_vhj9giztqy", created_time: "2026-09-08" },
          { voice_id: "herta-b1a43133-x7k2p9q1m4" },
          { created_time: "2026-09-01" },
          { voice_id: 42 },
        ],
      }),
    });
    await expect(listClones(fetch, "https://b.example", "k")).resolves.toEqual([
      { voiceId: "herta_vhj9giztqy", createdTime: "2026-09-08" },
      { voiceId: "herta-b1a43133-x7k2p9q1m4", createdTime: "" },
    ]);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      voice_type: "voice_cloning",
    });
    // No list field at all is an empty account, not an error.
    const empty = fake({ "https://b.example/v1/get_voice": () => ok });
    await expect(
      listClones(empty.fetch, "https://b.example", "k"),
    ).resolves.toEqual([]);
  });

  it("a tagged id names the reference it came from; untagged is the legacy shape", () => {
    expect(makeVoiceId(() => "abc123def4", "b1a43133")).toBe(
      "herta-b1a43133-abc123def4",
    );
    expect(makeVoiceId(() => "abc123def4")).toBe("herta_abc123def4");
    // MiniMax's shape: a letter first, letters/digits/-/_, 8–256 chars.
    expect(makeVoiceId(undefined, "b1a43133")).toMatch(
      /^[a-z][a-z0-9_-]{7,255}$/,
    );
  });
});

describe("uploadReference + cloneVoice", () => {
  it("uploads as multipart with purpose voice_clone and keeps the int64 file id exact", async () => {
    const big = "439506357502365999"; // past 2^53 — a JS number would round it
    const { fetch, calls } = fake({
      "https://h/v1/files/upload": () =>
        `{"file":{"file_id":${big},"bytes":10},"base_resp":{"status_code":0,"status_msg":"success"}}`,
      "https://h/v1/voice_clone": () => ({ ...ok, input_sensitive: false }),
    });
    const id = await uploadReference(
      fetch,
      "https://h",
      "k",
      new Uint8Array([1, 2, 3]),
      "reference.wav",
    );
    expect(id).toBe(big);
    const form = calls[0]?.init.body as FormData;
    expect(form.get("purpose")).toBe("voice_clone");
    expect((form.get("file") as File).name).toBe("reference.wav");

    await cloneVoice(fetch, "https://h", "k", id, "herta_abc123def4");
    // The digits went into the JSON body as a bare number, unrounded.
    expect(calls[1]?.init.body).toContain(`"file_id":${big},`);
    expect(calls[1]?.init.body).toContain('"need_noise_reduction":false');
  });

  it("a reference that fails the content check is `sensitive`", async () => {
    const { fetch } = fake({
      "https://h/v1/voice_clone": () => ({ ...ok, input_sensitive: true }),
    });
    await expect(
      cloneVoice(fetch, "https://h", "k", "1", "herta_abc123def4"),
    ).rejects.toMatchObject({
      reason: "sensitive",
    });
  });

  it("makeVoiceId obeys MiniMax's rules", () => {
    const id = makeVoiceId();
    expect(id).toMatch(/^[a-z][a-z0-9_]{7,}$/);
    expect(id.endsWith("_")).toBe(false);
    expect(makeVoiceId(() => "abc123def4")).toBe("herta_abc123def4");
  });
});

describe("synthesizePcm", () => {
  it("asks for raw 24 kHz mono PCM as hex and decodes it little-endian", async () => {
    const pcm = Buffer.alloc(6);
    pcm.writeInt16LE(1, 0);
    pcm.writeInt16LE(-2, 2);
    pcm.writeInt16LE(32767, 4);
    const { fetch, calls } = fake({
      "https://h/v1/t2a_v2": () => ({
        ...ok,
        data: { audio: pcm.toString("hex"), status: 2 },
        extra_info: { usage_characters: 12, audio_sample_rate: 24000 },
      }),
    });
    const out = await synthesizePcm(fetch, "https://h", "k", {
      voiceId: "v",
      text: "行。我知道了。",
    });
    expect([...out.samples]).toEqual([1, -2, 32767]);
    expect(out.sampleRate).toBe(24000);
    expect(out.billedChars).toBe(12);
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.audio_setting).toEqual({
      sample_rate: 24000,
      format: "pcm",
      channel: 1,
    });
    expect(body.voice_setting.voice_id).toBe("v");
    expect(body.output_format).toBe("hex");
  });

  it("a missing voice, a rate limit and a cancelled request are told apart", async () => {
    const { fetch } = fake({
      "https://h/v1/t2a_v2": () => ({
        base_resp: { status_code: 2013, status_msg: "voice_id not found" },
      }),
    });
    await expect(
      synthesizePcm(fetch, "https://h", "k", { voiceId: "v", text: "x" }),
    ).rejects.toMatchObject({
      reason: "voice_missing",
    });
    const limited = fake({
      "https://h/v1/t2a_v2": () => ({
        base_resp: { status_code: 1002, status_msg: "rate limit exceeded" },
      }),
    });
    await expect(
      synthesizePcm(limited.fetch, "https://h", "k", {
        voiceId: "v",
        text: "x",
      }),
    ).rejects.toMatchObject({
      reason: "rate",
    });
    const ac = new AbortController();
    ac.abort();
    const aborting: FetchLike = async (_u, init) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("{}");
    };
    const err = await synthesizePcm(aborting, "https://h", "k", {
      voiceId: "v",
      text: "x",
      signal: ac.signal,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MiniMaxError);
    expect((err as MiniMaxError).reason).toBe("cancelled");
  });
});
