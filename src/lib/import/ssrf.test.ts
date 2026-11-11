import { describe, expect, test } from "bun:test";

import { ImportError, assertPublicUrl, isBlockedIp } from "./ssrf";

describe("isBlockedIp", () => {
  const blocked = [
    "127.0.0.1", // loopback
    "0.0.0.0", // this-host
    "10.1.2.3", // private A
    "172.16.5.4", // private B
    "172.31.255.255", // private B upper
    "192.168.0.1", // private C
    "169.254.169.254", // link-local / cloud metadata
    "100.64.1.1", // CGNAT
    "192.0.0.1", // IETF protocol assignments
    "198.18.0.1", // benchmarking
    "224.0.0.1", // multicast
    "240.0.0.1", // reserved
    "255.255.255.255", // broadcast
    "::1", // IPv6 loopback
    "fe80::1", // IPv6 link-local
    "fc00::1", // IPv6 ULA
    "fd12:3456::1", // IPv6 ULA
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1", // IPv4-mapped private
  ];
  for (const ip of blocked) {
    test(`blocks ${ip}`, () => {
      expect(isBlockedIp(ip)).toBe(true);
    });
  }

  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "140.82.121.3", // a public host
    "172.15.0.1", // just below private B
    "172.32.0.1", // just above private B
    "100.63.255.255", // just below CGNAT
    "100.128.0.1", // just above CGNAT
    "2606:4700:4700::1111", // public IPv6 (Cloudflare)
  ];
  for (const ip of allowed) {
    test(`allows public ${ip}`, () => {
      expect(isBlockedIp(ip)).toBe(false);
    });
  }
});

describe("assertPublicUrl", () => {
  const publicResolver = async () => ["93.184.216.34"];

  test("accepts an https URL that resolves to a public IP", async () => {
    const url = await assertPublicUrl(
      "https://example.com/icon.svg",
      publicResolver,
    );
    expect(url.hostname).toBe("example.com");
  });

  test("rejects a non-http(s) scheme", async () => {
    await expect(
      assertPublicUrl("file:///etc/passwd", publicResolver),
    ).rejects.toBeInstanceOf(ImportError);
  });

  test("rejects embedded credentials", async () => {
    await expect(
      assertPublicUrl("https://user:pass@example.com/x.svg", publicResolver),
    ).rejects.toBeInstanceOf(ImportError);
  });

  test("rejects a literal private-IP host without resolving", async () => {
    await expect(
      assertPublicUrl("http://169.254.169.254/latest/meta-data", async () => {
        throw new Error("resolver must not be consulted for a literal IP");
      }),
    ).rejects.toBeInstanceOf(ImportError);
  });

  test("rejects a hostname that resolves to any private IP (DNS rebind guard)", async () => {
    await expect(
      assertPublicUrl("https://evil.example/x.svg", async () => [
        "8.8.8.8",
        "127.0.0.1",
      ]),
    ).rejects.toBeInstanceOf(ImportError);
  });

  test("rejects when the host does not resolve", async () => {
    await expect(
      assertPublicUrl("https://nope.example/x.svg", async () => []),
    ).rejects.toBeInstanceOf(ImportError);
  });
});
