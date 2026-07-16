import { describe, expect, it } from "vitest";
import { parseCurl } from "../src/curl-import";

describe("parseCurl", () => {
  it("parses a simple GET (bare url, no flags)", () => {
    const { config, warnings } = parseCurl(
      "curl https://api.example.com/users",
    );
    expect(config).toEqual({
      method: "GET",
      url: "https://api.example.com/users",
    });
    expect(warnings).toEqual([]);
  });

  it("defaults to POST when there's a data body and no -X", () => {
    const { config } = parseCurl(
      `curl https://api.example.com/x -H 'Content-Type: application/json' -d '{"a":1,"b":"two"}'`,
    );
    expect(config.method).toBe("POST");
    expect(config.headers).toEqual({ "Content-Type": "application/json" });
    expect(config.body).toEqual({ a: 1, b: "two" }); // JSON body parsed to an object
  });

  it("honors an explicit -X and multiple -H", () => {
    const { config } = parseCurl(
      `curl -X PUT https://h/x -H 'Accept: application/json' -H 'X-Trace: abc'`,
    );
    expect(config.method).toBe("PUT");
    expect(config.headers).toEqual({
      Accept: "application/json",
      "X-Trace": "abc",
    });
  });

  it("splits the URL query string into the query map", () => {
    const { config } = parseCurl(
      "curl 'https://h/search?q=hello+world&page=2'",
    );
    expect(config.url).toBe("https://h/search");
    expect(config.query).toEqual({ q: "hello world", page: "2" });
  });

  it("STRIPS an Authorization header with a warning (never in the graph)", () => {
    const { config, warnings } = parseCurl(
      `curl https://h/x -H 'Authorization: Bearer sk-secret' -H 'Accept: application/json'`,
    );
    expect(config.headers).toEqual({ Accept: "application/json" });
    expect(config.headers?.Authorization).toBeUndefined();
    expect(warnings.some((w) => /Authorization/.test(w))).toBe(true);
  });

  it("STRIPS -u basic-auth credentials with a warning", () => {
    const { config, warnings } = parseCurl("curl -u admin:hunter2 https://h/x");
    expect(config.url).toBe("https://h/x");
    expect(JSON.stringify(config)).not.toContain("hunter2");
    expect(warnings.some((w) => /basic-auth/.test(w))).toBe(true);
  });

  it("handles backslash line continuations + quoted values", () => {
    const curl = `curl -X POST 'https://h/x' \\
      -H "Content-Type: application/json" \\
      -d '{"name":"a b"}'`;
    const { config } = parseCurl(curl);
    expect(config.method).toBe("POST");
    expect(config.url).toBe("https://h/x");
    expect(config.body).toEqual({ name: "a b" });
  });

  it("-G moves the data into query params (not a body)", () => {
    const { config } = parseCurl("curl -G https://h/x -d 'q=abc' -d 'n=2'");
    expect(config.method).toBe("GET");
    expect(config.query).toEqual({ q: "abc", n: "2" });
    expect(config.body).toBeUndefined();
  });

  it("keeps a non-JSON body as a raw string", () => {
    const { config } = parseCurl("curl -X POST https://h/x -d 'name=a&age=3'");
    expect(config.body).toBe("name=a&age=3");
  });

  it("clamps an unsupported method to GET with a warning", () => {
    const { config, warnings } = parseCurl("curl -X HEAD https://h/x");
    expect(config.method).toBe("GET");
    expect(warnings.some((w) => /HEAD/.test(w))).toBe(true);
  });

  it("maps --url and ignores transport flags (-s, --compressed, -L)", () => {
    const { config, warnings } = parseCurl(
      "curl -s --compressed -L --url https://h/x",
    );
    expect(config.url).toBe("https://h/x");
    expect(warnings).toEqual([]);
  });

  it("drops a body on an explicit GET (-X GET -d) with a warning (GET has no body)", () => {
    const { config, warnings } = parseCurl("curl -X GET https://h/x -d 'a=1'");
    expect(config.method).toBe("GET");
    expect(config.body).toBeUndefined();
    expect(warnings.some((w) => /GET requests don't send a body/.test(w))).toBe(
      true,
    );
  });

  it("drops -b/--cookie with a warning (session material, not imported)", () => {
    const { config, warnings } = parseCurl(
      "curl https://h/x -b 'session=abc123'",
    );
    expect(JSON.stringify(config)).not.toContain("abc123");
    expect(warnings.some((w) => /cookie/i.test(w))).toBe(true);
  });

  it("throws when there is no URL", () => {
    expect(() =>
      parseCurl("curl -X POST -H 'Accept: application/json'"),
    ).toThrow(/No URL/);
  });
});
