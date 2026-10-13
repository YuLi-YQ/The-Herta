import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl, isPublicWebUrl, NETDISK_URL } from "./links.js";

it('permits explicit public web links without application protocols or private hosts', () => {
  expect(isPublicWebUrl('https://www.python.org/doc/')).toBe(true);
  for (const url of ['file:///C:/x.exe','javascript:alert(1)','https://secret@python.org','http://127.0.0.1','http://[::1]','http://x.local','https://example.com:9999']) expect(isPublicWebUrl(url)).toBe(false);
});

describe("isAllowedExternalUrl", () => {
  it("admits https links to the allowlisted hosts and nothing else", () => {
    expect(isAllowedExternalUrl(NETDISK_URL)).toBe(true);
    expect(isAllowedExternalUrl("https://github.com/PersonaCLI/Herta")).toBe(
      true,
    );
    expect(isAllowedExternalUrl("http://pan.baidu.com/s/x")).toBe(false);
    expect(isAllowedExternalUrl("https://evil.example/pan.baidu.com")).toBe(
      false,
    );
    expect(isAllowedExternalUrl("https://pan.baidu.com.evil.example/")).toBe(
      false,
    );
    expect(isAllowedExternalUrl("file:///C:/Windows")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
    expect(isAllowedExternalUrl("https://developers.openai.com/api/docs")).toBe(
      true,
    );
    expect(isAllowedExternalUrl("https://platform.claude.com/docs")).toBe(true);
    expect(isAllowedExternalUrl("https://secret@github.com/path")).toBe(false);
  });
});
