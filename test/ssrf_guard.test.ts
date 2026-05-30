import { describe, it, expect } from "vitest";
import { isBlockedAddress, validateOutboundUrl, SsrfBlockedError } from "../src/lib/ssrf_guard.js";

describe("isBlockedAddress — IPv4", () => {
  it("blocks loopback 127.0.0.0/8", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("127.1.2.3")).toBe(true);
  });
  it("blocks the cloud-metadata link-local 169.254.169.254", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("169.254.0.1")).toBe(true);
  });
  it("blocks RFC-1918 private ranges", () => {
    expect(isBlockedAddress("10.0.0.1")).toBe(true);
    expect(isBlockedAddress("172.16.0.1")).toBe(true);
    expect(isBlockedAddress("172.31.255.255")).toBe(true);
    expect(isBlockedAddress("192.168.1.1")).toBe(true);
  });
  it("does NOT block 172.15 / 172.32 (just outside the /12)", () => {
    expect(isBlockedAddress("172.15.0.1")).toBe(false);
    expect(isBlockedAddress("172.32.0.1")).toBe(false);
  });
  it("blocks 0.0.0.0/8 and CGNAT 100.64/10", () => {
    expect(isBlockedAddress("0.0.0.0")).toBe(true);
    expect(isBlockedAddress("100.64.0.1")).toBe(true);
    expect(isBlockedAddress("100.127.255.255")).toBe(true);
  });
  it("does NOT block 100.63 / 100.128 (just outside CGNAT)", () => {
    expect(isBlockedAddress("100.63.0.1")).toBe(false);
    expect(isBlockedAddress("100.128.0.1")).toBe(false);
  });
  it("blocks multicast/reserved 224.0.0.0+ and broadcast", () => {
    expect(isBlockedAddress("224.0.0.1")).toBe(true);
    expect(isBlockedAddress("240.0.0.1")).toBe(true);
    expect(isBlockedAddress("255.255.255.255")).toBe(true);
  });
  it("allows ordinary public IPv4", () => {
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("1.1.1.1")).toBe(false);
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
  });
  it("fails closed on non-IP garbage", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("isBlockedAddress — IPv6", () => {
  it("blocks loopback and unspecified", () => {
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("::")).toBe(true);
  });
  it("blocks link-local fe80::/10 and unique-local fc00::/7", () => {
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("fd00::1")).toBe(true);
    expect(isBlockedAddress("fc00::1")).toBe(true);
  });
  it("blocks multicast ff00::/8", () => {
    expect(isBlockedAddress("ff02::1")).toBe(true);
  });
  it("blocks IPv4-mapped forms that wrap an internal v4", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
  });
  it("allows ordinary public IPv6", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
  });
});

describe("validateOutboundUrl — protocol & credential checks (no DNS needed)", () => {
  it("rejects non-http(s) protocols", async () => {
    await expect(validateOutboundUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(validateOutboundUrl("gopher://x/1")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(validateOutboundUrl("ftp://host/x")).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it("rejects URLs with embedded credentials", async () => {
    await expect(validateOutboundUrl("http://user:pass@8.8.8.8/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it("rejects unparseable URLs", async () => {
    await expect(validateOutboundUrl("http://")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(validateOutboundUrl("not a url")).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it("rejects http to a literal internal IP without any DNS lookup", async () => {
    await expect(validateOutboundUrl("http://127.0.0.1/admin")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(validateOutboundUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(validateOutboundUrl("http://192.168.0.5:8080/")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(validateOutboundUrl("http://[::1]/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it("allows a literal internal IP when allowPrivate=true (operator opt-in)", async () => {
    const u = await validateOutboundUrl("http://192.168.0.5/feed.ics", true);
    expect(u.hostname).toBe("192.168.0.5");
  });
  it("passes through a literal public IP", async () => {
    const u = await validateOutboundUrl("https://8.8.8.8/cal.ics");
    expect(u.protocol).toBe("https:");
    expect(u.hostname).toBe("8.8.8.8");
  });
});
