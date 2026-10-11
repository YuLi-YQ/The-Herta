import { describe, expect, it } from "vitest";
import { MockReadable, MockWritable } from "./mock-streams.js";

describe("MockWritable", () => {
  it("captures every write as a string chunk", () => {
    const w = new MockWritable();
    w.write("hello ");
    w.write("world");
    expect(w.chunks).toEqual(["hello ", "world"]);
    expect(w.full()).toBe("hello world");
  });

  it("captures Buffer writes as utf8 strings", () => {
    const w = new MockWritable();
    w.write(Buffer.from("buf"));
    expect(w.full()).toBe("buf");
  });
});

describe("MockReadable", () => {
  it("plays back fed chunks then EOF", async () => {
    const r = new MockReadable();
    r.feed("first ");
    r.feed("second");
    r.end();
    let out = "";
    for await (const chunk of r) {
      out += String(chunk);
    }
    expect(out).toBe("first second");
  });
});
