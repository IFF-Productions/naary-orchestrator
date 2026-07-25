import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// NOTE: no vi.mock here (unlike adapters.spec) — these tests drive the REAL pg/mysql2/mssql
// drivers against a local socket, because the thing under test is precisely whether each
// driver connects where we tell it to instead of resolving the DSN host itself (#597).
import { __mssqlDeps } from "../src/mssql";
import { __mysqlDeps } from "../src/mysql";
import {
  connectPinned,
  pinnedPgStream,
  pinnedTediousConnector,
} from "../src/pin";
import { __pgDeps } from "../src/postgres";

/** A hostname guaranteed NOT to resolve (RFC 6761 `.invalid`): if a driver ever resolved the
 *  DSN host instead of using the pin, the connection fails and the assertions below catch it. */
const UNRESOLVABLE = "pinned-host.invalid";

let server: net.Server;
let port: number;
let seen: number;
let notify: (() => void) | undefined;

/** Resolves once the local server has ACCEPTED a connection. The client-side `connect`
 *  event can fire a tick before the server's handler runs, so tests await this rather
 *  than reading `seen` straight after connecting. */
const connectionSeen = () =>
  new Promise<void>((resolve) => {
    if (seen > 0) return resolve();
    notify = resolve;
  });

beforeEach(async () => {
  seen = 0;
  notify = undefined;
  server = net.createServer((socket) => {
    seen += 1;
    notify?.();
    socket.destroy(); // we only care THAT the pinned address was dialed
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("pinnedPgStream", () => {
  it("connects to the pinned address, ignoring the host pg asks for", async () => {
    const socket = pinnedPgStream("127.0.0.1")();
    const connected = new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.connect(port, UNRESOLVABLE); // pg's call shape
    await connected;
    await connectionSeen();
    socket.destroy();
    expect(seen).toBe(1);
  });

  it("forwards the (port, host, connectListener) callback overload while still pinning", async () => {
    // net.Socket.connect's documented 3-arg form takes a connect callback; dropping it would
    // silently swallow a caller's notification (Copilot review, #597).
    const socket = pinnedPgStream("127.0.0.1")();
    const called = new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(port, UNRESOLVABLE, () => resolve()); // cb must fire…
    });
    await called;
    await connectionSeen(); // …and the connection still went to the PIN, not the bad host
    socket.destroy();
    expect(seen).toBe(1);
  });

  it("passes a unix-socket path straight through (never pinned)", () => {
    // pg calls connect() with ONE argument for a socket-path DSN; redirecting that to an
    // IP would break local-socket connections outright.
    const socket = pinnedPgStream("127.0.0.1")();
    socket.connect("/tmp/naary-nonexistent-socket.sock");
    expect(socket.destroyed).toBe(false); // it tried the path, not the pin
    socket.destroy();
  });
});

describe("connectPinned", () => {
  it("opens a socket to the pinned address", async () => {
    const socket = connectPinned(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    await connectionSeen();
    socket.destroy();
    expect(seen).toBe(1);
  });
});

describe("pinnedTediousConnector", () => {
  it("returns a CONNECTED socket for the host it validated", async () => {
    const connector = pinnedTediousConnector(UNRESOLVABLE, "127.0.0.1");
    const socket = await connector(
      { host: UNRESOLVABLE, port },
      undefined,
      AbortSignal.timeout(5000),
    );
    expect(socket).toBeInstanceOf(net.Socket);
    await connectionSeen();
    socket.destroy();
    expect(seen).toBe(1);
  });

  it("fails closed when tedious asks for a DIFFERENT host (Azure routing redirect)", async () => {
    // A ROUTING_CHANGE names the next hop; following it would connect to a
    // server-supplied host that never passed the SSRF guard.
    const connector = pinnedTediousConnector(UNRESOLVABLE, "127.0.0.1");
    await expect(
      connector({ host: "redirect.internal", port }, undefined),
    ).rejects.toThrow(/redirect/i);
    expect(seen).toBe(0);
  });

  it("rejects an already-aborted connect (tedious' connect timeout)", async () => {
    const connector = pinnedTediousConnector(UNRESOLVABLE, "127.0.0.1");
    await expect(
      connector({ host: UNRESOLVABLE, port }, undefined, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(seen).toBe(0);
  });
});

describe("driver-level pinning (real pg / mysql2 / mssql)", () => {
  it("pg connects to the pin even though the DSN host cannot resolve", async () => {
    const client = __pgDeps.createClient(
      `postgres://u:p@${UNRESOLVABLE}:${port}/app`,
      1000,
      "127.0.0.1",
    );
    // The server hangs up immediately, so connect() rejects — the assertion is that pg got
    // as far as opening a socket to the PINNED address (a DNS lookup would have failed first).
    await client.connect().catch(() => undefined);
    await client.end().catch(() => undefined);
    expect(seen).toBe(1);
  });

  it("mysql2 connects to the pin even though the DSN host cannot resolve", async () => {
    await __mysqlDeps
      .createConnection(
        `mysql://u:p@${UNRESOLVABLE}:${port}/app`,
        1000,
        "127.0.0.1",
      )
      .catch(() => undefined);
    expect(seen).toBe(1);
  });

  it("mssql/tedious connects to the pin even though the DSN host cannot resolve", async () => {
    const pool = __mssqlDeps.createPool(
      `Server=${UNRESOLVABLE},${port};Database=app;User Id=u;Password=p`,
      1000,
      "127.0.0.1",
    );
    await pool.connect().catch(() => undefined);
    await pool.close().catch(() => undefined);
    expect(seen).toBe(1);
  });

  it("without a pin, the driver resolves the DSN host itself and never reaches us", async () => {
    // The pre-#597 behavior, kept as the contrast: no pin ⇒ pg does its own lookup, which
    // fails for an unresolvable host, so nothing dials the local server.
    const client = __pgDeps.createClient(
      `postgres://u:p@${UNRESOLVABLE}:${port}/app`,
      1000,
    );
    await client.connect().catch(() => undefined);
    await client.end().catch(() => undefined);
    expect(seen).toBe(0);
  });
});
