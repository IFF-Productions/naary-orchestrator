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

  // The second half of #1032: `NON_URL_TYPES` is what exempts a database connection from the
  // https-URL rule, so an engine missing from it still 400s — on `serverUrl` instead of `type`.
  // A DB connection's serverUrl is a non-secret display host; the DSN rides in `token`.
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
});
