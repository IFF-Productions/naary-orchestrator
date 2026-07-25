import { describe, expect, it, vi } from "vitest";
import {
  assertEgressAllowed,
  assertHostPublic,
  BlockedEgressError,
  isBlockedIp,
  resolvePinnedHost,
} from "../src/egress";

// A fake DNS resolver so the URL guard is exercised without real network.
const resolvesTo =
  (addr: string) => async (): Promise<{ address: string }[]> => [
    { address: addr },
  ];

describe("isBlockedIp", () => {
  it("blocks private / loopback / link-local / reserved addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.3.4",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "0.0.0.0",
      "100.64.0.1", // CGNAT
      "224.0.0.1", // multicast
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12::3",
      "::ffff:127.0.0.1", // v4-mapped loopback
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "2606:2800:220:1:248:1893:25c8:1946",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

describe("assertEgressAllowed", () => {
  it("rejects non-https URLs", async () => {
    await expect(
      assertEgressAllowed("http://example.com", resolvesTo("8.8.8.8")),
    ).rejects.toBeInstanceOf(BlockedEgressError);
  });

  it("rejects a host that resolves to a private IP (DNS rebinding)", async () => {
    await expect(
      assertEgressAllowed(
        "https://evil.example",
        resolvesTo("169.254.169.254"),
      ),
    ).rejects.toBeInstanceOf(BlockedEgressError);
  });

  it("blocks an IP-literal loopback URL (no DNS needed)", async () => {
    await expect(
      assertEgressAllowed("https://127.0.0.1/x"),
    ).rejects.toBeInstanceOf(BlockedEgressError);
  });

  it("allows https to a public host", async () => {
    const url = await assertEgressAllowed(
      "https://mcp.example.com/v1/mcp",
      resolvesTo("93.184.216.34"),
    );
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("mcp.example.com");
  });
});

describe("assertHostPublic (SMTP / non-HTTP SSRF guard)", () => {
  it("passes for a host that resolves to a public address", async () => {
    await expect(
      assertHostPublic("smtp.example.com", resolvesTo("93.184.216.34")),
    ).resolves.toBeUndefined();
  });

  it("passes for a public IP literal (no DNS)", async () => {
    await expect(assertHostPublic("8.8.8.8")).resolves.toBeUndefined();
  });

  it("blocks private/loopback/link-local IP literals", async () => {
    for (const host of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "[::1]"]) {
      await expect(assertHostPublic(host), host).rejects.toBeInstanceOf(
        BlockedEgressError,
      );
    }
  });

  it("blocks a hostname that RESOLVES to a private address (DNS-rebinding class)", async () => {
    await expect(
      assertHostPublic("evil.example.com", resolvesTo("169.254.169.254")),
    ).rejects.toBeInstanceOf(BlockedEgressError);
  });

  it("blocks a host that does not resolve, and an empty host", async () => {
    await expect(
      assertHostPublic("nope.example.com", async () => []),
    ).rejects.toBeInstanceOf(BlockedEgressError);
    await expect(assertHostPublic("")).rejects.toBeInstanceOf(
      BlockedEgressError,
    );
  });
});

describe("resolvePinnedHost (connect-pinning for SQL/SMTP, #597)", () => {
  it("returns the validated address so the caller connects to THAT, not the hostname", async () => {
    await expect(
      resolvePinnedHost("db.example.com", resolvesTo("93.184.216.34")),
    ).resolves.toBe("93.184.216.34");
  });

  it("resolves EXACTLY ONCE — the pin is why rebinding can't win", async () => {
    // A resolver that answers public first and private after: the classic rebinding
    // sequence. One lookup means the second answer never happens, so what the driver
    // connects to is what we checked. (Two lookups = the bug this closes.)
    const answers = ["93.184.216.34", "169.254.169.254"];
    let calls = 0;
    const flipFlop = async () => {
      calls += 1;
      return [{ address: answers[Math.min(calls - 1, answers.length - 1)] }];
    };
    expect(await resolvePinnedHost("rebind.example.com", flipFlop)).toBe(
      "93.184.216.34",
    );
    expect(calls).toBe(1);
  });

  it("returns a public IP literal unchanged (no DNS at all)", async () => {
    const resolve = vi.fn();
    expect(await resolvePinnedHost("8.8.8.8", resolve)).toBe("8.8.8.8");
    expect(await resolvePinnedHost("[2606:4700:4700::1111]", resolve)).toBe(
      "2606:4700:4700::1111",
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("throws (never returns a pin) for private literals, private answers, and no answer", async () => {
    await expect(resolvePinnedHost("10.0.0.5")).rejects.toBeInstanceOf(
      BlockedEgressError,
    );
    await expect(
      resolvePinnedHost("evil.example.com", resolvesTo("169.254.169.254")),
    ).rejects.toBeInstanceOf(BlockedEgressError);
    await expect(
      resolvePinnedHost("nope.example.com", async () => []),
    ).rejects.toBeInstanceOf(BlockedEgressError);
  });

  it("rejects a MIXED record set rather than cherry-picking the public address", async () => {
    // A public+private answer pair is what a rebinding attack looks like; returning the
    // public one would let the attacker keep retrying until the driver got the private one.
    await expect(
      resolvePinnedHost("mixed.example.com", async () => [
        { address: "93.184.216.34" },
        { address: "127.0.0.1" },
      ]),
    ).rejects.toBeInstanceOf(BlockedEgressError);
  });
});

describe("isBlockedIp — IPv4-mapped/embedded IPv6 forms (#590)", () => {
  it("blocks HEX-COMPRESSED IPv4-mapped literals (the URL-parser normalized form)", () => {
    // `new URL("https://[::ffff:127.0.0.1]/")`.hostname → "[::ffff:7f00:1]" — the
    // dotted-decimal regex never saw these before the fix.
    for (const ip of [
      "::ffff:7f00:1", // 127.0.0.1
      "::ffff:a9fe:a9fe", // 169.254.169.254 (cloud metadata)
      "::ffff:a00:5", // 10.0.0.5
      "0:0:0:0:0:ffff:7f00:1", // uncompressed spelling
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("blocks DOTTED IPv4-mapped literals (regression)", () => {
    for (const ip of [
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:10.0.0.5",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows IPv4-mapped forms of PUBLIC addresses", () => {
    for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks NAT64/6to4/Teredo embeddings of private addresses", () => {
    for (const ip of [
      "64:ff9b::7f00:1", // NAT64 → 127.0.0.1
      "64:ff9b::a9fe:a9fe", // NAT64 → cloud metadata
      "2002:7f00:1::", // 6to4 → 127.0.0.1
      "2002:a9fe:a9fe::", // 6to4 → 169.254.169.254
      "2001:0:503:236e::", // Teredo (obfuscated v4 → reject outright)
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("keeps blocking classic v6 special ranges and zone-indexed literals", () => {
    for (const ip of [
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12::1",
      "ff02::1",
      "fe80::1%eth0",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("still allows normal public v6", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false); // Cloudflare DNS
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false); // Google DNS (2001:: but NOT 2001:0::/32)
  });
});
