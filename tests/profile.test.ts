import { describe, it, expect } from "vitest";
import { normalizeBaseUrl, sameProfile, toProfile } from "../src/runtime/profile";

describe("normalizeBaseUrl", () => {
  it("canonicalizes a trailing slash", () => {
    const a = normalizeBaseUrl("http://127.0.0.1:8642");
    const b = normalizeBaseUrl("http://127.0.0.1:8642/");
    expect(a?.key).toBe(b?.key);
    expect(a?.baseUrl).toBe("http://127.0.0.1:8642");
  });

  it("treats localhost and 127.0.0.1 as different profiles (no DNS canonicalization)", () => {
    expect(sameProfile("http://127.0.0.1:8642", "http://localhost:8642")).toBe(
      false,
    );
  });

  it("keeps an explicit path prefix in the key", () => {
    const p = normalizeBaseUrl("https://hermes.example.com/proxy/");
    expect(p?.baseUrl).toBe("https://hermes.example.com/proxy");
    expect(p?.hostShort).toBe("hermes.example.com");
  });

  it("drops default ports from the key", () => {
    const http = normalizeBaseUrl("http://hermes.example.com:80");
    const https = normalizeBaseUrl("https://hermes.example.com:443");
    expect(http?.baseUrl).toBe("http://hermes.example.com");
    expect(https?.baseUrl).toBe("https://hermes.example.com");
  });

  it("rejects non-http(s) schemes", () => {
    expect(normalizeBaseUrl("ftp://hermes.example.com")).toBeNull();
    expect(normalizeBaseUrl("not a url")).toBeNull();
    expect(normalizeBaseUrl("")).toBeNull();
  });

  it("toProfile falls back on unparseable input", () => {
    const p = toProfile("not a url");
    expect(p.baseUrl).toBe("not a url");
    expect(p.hostShort).toBe("not a url");
  });
});
