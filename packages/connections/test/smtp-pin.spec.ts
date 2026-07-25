import { describe, expect, it, vi } from "vitest";
// The REAL nodemailer connection-URL parser: these tests assert the pinned URI still
// produces the transport options nodemailer would build from the original — that's the
// whole contract, and it lives in nodemailer, not in our code.
import shared from "nodemailer/lib/shared";
import { BlockedEgressError } from "../src/egress";
import { pinnedSmtpUri } from "../src/smtp-pin";

const resolvesTo =
  (addr: string) => async (): Promise<{ address: string }[]> => [
    { address: addr },
  ];

const parse = (uri: string) =>
  (
    shared as unknown as {
      parseConnectionUrl: (u: string) => Record<string, unknown>;
    }
  ).parseConnectionUrl(uri);

describe("pinnedSmtpUri (#597)", () => {
  it("dials the validated ADDRESS while TLS keeps checking the hostname", async () => {
    const out = await pinnedSmtpUri(
      "smtps://mailer:s3cret@smtp.example.com:465",
      resolvesTo("93.184.216.34"),
    );
    expect(parse(out)).toMatchObject({
      host: "93.184.216.34", // no lookup left for nodemailer to do
      servername: "smtp.example.com", // …but the cert is still validated as the hostname
      port: 465,
      secure: true,
      auth: { user: "mailer", pass: "s3cret" },
    });
  });

  it("preserves percent-encoded credentials and existing query options", async () => {
    const uri =
      "smtp://user%40corp.com:p%40ss%2Fword@smtp.example.com:587?requireTLS=true&tls.rejectUnauthorized=false";
    const out = await pinnedSmtpUri(uri, resolvesTo("93.184.216.34"));
    const before = parse(uri);
    const after = parse(out);
    expect(after).toMatchObject({
      auth: before.auth, // credentials survive the URL round-trip byte-for-byte
      requireTLS: true,
      tls: { rejectUnauthorized: false },
      host: "93.184.216.34",
      servername: "smtp.example.com",
    });
  });

  it("keeps an operator-supplied servername (their cert intent wins)", async () => {
    const out = await pinnedSmtpUri(
      "smtp://smtp.example.com:587?servername=mail.corp.example",
      resolvesTo("93.184.216.34"),
    );
    expect(parse(out)).toMatchObject({
      host: "93.184.216.34",
      servername: "mail.corp.example",
    });
  });

  it("brackets a pinned IPv6 address so the URI stays parseable", async () => {
    const out = await pinnedSmtpUri(
      "smtp://u:p@smtp.example.com:587",
      resolvesTo("2606:4700:4700::1111"),
    );
    expect(out).toContain("[2606:4700:4700::1111]");
    expect(parse(out)).toMatchObject({
      host: "2606:4700:4700::1111",
      servername: "smtp.example.com",
      port: 587,
    });
  });

  it("returns an IP-literal URI untouched (nothing to pin, no servername invented)", async () => {
    const resolve = vi.fn();
    const uri = "smtp://u:p@93.184.216.34:587";
    expect(await pinnedSmtpUri(uri, resolve)).toBe(uri);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a private/reserved host — literal or resolved — so no transport is built", async () => {
    await expect(
      pinnedSmtpUri("smtp://u:p@127.0.0.1:25"),
    ).rejects.toBeInstanceOf(BlockedEgressError);
    await expect(
      pinnedSmtpUri(
        "smtp://u:p@evil.example.com:25",
        resolvesTo("169.254.169.254"),
      ),
    ).rejects.toBeInstanceOf(BlockedEgressError);
  });

  it("resolves the host EXACTLY ONCE (the pin, not a re-check, is the fix)", async () => {
    const resolve = vi.fn(resolvesTo("93.184.216.34"));
    await pinnedSmtpUri("smtp://smtp.example.com:587", resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
