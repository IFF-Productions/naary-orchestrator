import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import type { ConnectionType } from "@naary/connections";
import type { SqlEngine } from "@naary/sql";
import { CreateConnectionDto } from "../src/connections/create-connection.dto";

/**
 * The request DTO's accepted `type` list is hand-written, and #1032 is what happens when it
 * drifts from the domain: `mysql` was a first-class `ConnectionType` with a shipped adapter and
 * a canvas picker entry, but `POST /connections` 400'd on it.
 *
 * These maps are the guard. They are annotated `Record<ConnectionType, true>` /
 * `Record<SqlEngine, true>`, so adding a member to either union fails the BUILD here until
 * someone adds the key — and the tests below then fail until the DTO actually accepts it.
 * Deriving the list this way (rather than re-typing it) is the whole point: a hand-written
 * list in the test would drift in lockstep with the one in the DTO.
 */
const ALL_CONNECTION_TYPES: Record<ConnectionType, true> = {
  github: true,
  atlassian: true,
  custom: true,
  postgres: true,
  mssql: true,
  mysql: true,
  firestore: true,
  kafka: true,
  mqtt: true,
  signing: true,
  smtp: true,
};

const ALL_SQL_ENGINES: Record<SqlEngine, true> = {
  postgres: true,
  mssql: true,
  mysql: true,
};

const CONNECTION_TYPES = Object.keys(ALL_CONNECTION_TYPES) as ConnectionType[];
const SQL_ENGINES = Object.keys(ALL_SQL_ENGINES) as SqlEngine[];

/** Compile-time: every SQL engine must BE a connection type (they name the same values). */
const _enginesAreConnectionTypes: ConnectionType[] = SQL_ENGINES;
void _enginesAreConnectionTypes;

function dto(over: Partial<CreateConnectionDto>): CreateConnectionDto {
  return Object.assign(new CreateConnectionDto(), {
    type: "github",
    label: "Test connection",
    serverUrl: "https://api.example.com",
    authMode: "pat",
    ...over,
  });
}

describe("CreateConnectionDto", () => {
  // Guards the guard: if the decorators ever stop being applied under the test transform,
  // every assertion below would pass vacuously.
  it("rejects a type that is not a connection type", async () => {
    const errors = await validate(dto({ type: "totally-bogus" as never }));
    expect(errors.map((e) => e.property)).toContain("type");
  });

  it.each(CONNECTION_TYPES)("accepts type=%s", async (type) => {
    const errors = await validate(dto({ type }));
    expect(errors.filter((e) => e.property === "type")).toEqual([]);
  });

  // The second half of #1032: `NON_URL_TYPES` is what exempts a connection whose serverUrl is a
  // display label rather than an address we dial, so an engine missing from that list still 400s —
  // on `serverUrl` instead of `type`. A SQL connection's serverUrl is a non-secret display host;
  // the DSN rides in `token`. (The list is wider than the SQL engines — smtp and signing are in it
  // too — but the engines are what #1032 was about, and what SQL_ENGINES derives.)
  it.each(SQL_ENGINES)(
    "accepts a %s connection whose serverUrl is a bare host",
    async (engine) => {
      const errors = await validate(
        dto({
          type: engine,
          serverUrl: "db.internal",
          authMode: "connection_string",
        }),
      );
      expect(errors.map((e) => e.property)).toEqual([]);
    },
  );

  // The exemption is NOT "the databases" — the validator's message used to say so, and it was
  // wrong: a signing key has no host at all, and smtp is not a database. Both are label-only
  // types, so both must be accepted without an https URL.
  it.each([
    ["signing", "Prod signing key"],
    ["smtp", "smtp.example.com"],
  ] as const)(
    "accepts a %s connection whose serverUrl is a label",
    async (type, label) => {
      const errors = await validate(dto({ type, serverUrl: label }));
      expect(errors.map((e) => e.property)).toEqual([]);
    },
  );

  /**
   * NO create path accepts an empty Server URL — for ANY type, including the label-only ones
   * (#1110). The PostHog fix leans on this: `defaultBaseUrl` is documented as a compatibility
   * fallback for rows that predate the field rather than as "leave it blank", and that sentence is
   * only true while this holds. If the DTO ever starts accepting `""`, the fallback becomes a
   * reachable path and the guides are wrong.
   */
  it.each(CONNECTION_TYPES)(
    "rejects an EMPTY serverUrl for type=%s",
    async (type) => {
      const errors = await validate(dto({ type, serverUrl: "" }));
      expect(errors.map((e) => e.property)).toContain("serverUrl");
    },
  );

  it("still requires an https URL for connections it calls over HTTP", async () => {
    const errors = await validate(
      dto({
        type: "custom",
        serverUrl: "http://169.254.169.254/latest/meta-data",
      }),
    );
    expect(errors.map((e) => e.property)).toContain("serverUrl");
  });
});
