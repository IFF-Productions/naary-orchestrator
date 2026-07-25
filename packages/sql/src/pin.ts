import net from "node:net";

/**
 * Connect-pinning for the SQL drivers (audit #597).
 *
 * The activity resolves the DSN host ONCE and validates the address (SSRF guard, in
 * @naary/connections), but pg/mysql2/tedious then resolve the hostname AGAIN themselves —
 * so DNS can answer public for the guard and private for the driver (rebinding TOCTOU).
 * These helpers give each driver a socket that is already aimed at the validated address,
 * so no lookup happens at connect time and the connected address is exactly the checked one.
 *
 * The DSN keeps its ORIGINAL hostname in every case, which is deliberate: each driver
 * derives its TLS servername from the configured host (pg `upgradeToSSL`, mysql2
 * `base/connection.js`, tedious `config.server`), so certificate validation still checks
 * the hostname — pinning changes where we connect, never what we trust.
 *
 * `pinnedHost` is a bare IP address. It is optional throughout: absent ⇒ the driver connects
 * exactly as before (used for DSNs with no parseable host, e.g. a unix socket path).
 */

/** Open a socket to the pinned address on `port` — the one place we bypass DNS. */
export function connectPinned(port: number, pinnedHost: string): net.Socket {
  return net.connect({ port, host: pinnedHost });
}

/**
 * A `stream` factory for pg. pg builds its own socket and calls `stream.connect(port, host)`
 * with the DSN host, so we hand it a real `net.Socket` whose `connect` redirects the HOST to
 * the pinned address. (pg has no `lookup`/connector option; `stream` is its documented seam.)
 * A single-argument call is a unix-socket path — passed straight through, never pinned.
 */
export function pinnedPgStream(pinnedHost: string): () => net.Socket {
  return () => {
    const socket = new net.Socket();
    const connect = socket.connect.bind(socket);
    socket.connect = ((...args: unknown[]) => {
      const [port, host] = args;
      if (typeof port !== "number" || typeof host !== "string") {
        return (connect as (...a: unknown[]) => net.Socket)(...args);
      }
      return connect({ port, host: pinnedHost });
    }) as typeof socket.connect;
    return socket;
  };
}

/**
 * A tedious `options.connector` (mssql passes unknown `config.options` straight through).
 * tedious calls it with the host it intends to dial and expects a CONNECTED socket back,
 * honoring the abort signal it uses for its connect timeout.
 *
 * Fails closed when tedious asks for a DIFFERENT host than the one we pinned: that only
 * happens on an Azure SQL routing (ROUTING_CHANGE) redirect, where the server names the next
 * hop. Following it would connect to a server-supplied host that never passed the SSRF guard
 * — i.e. it would hand the redirect an SSRF primitive — so it is rejected instead. Effect:
 * an Azure SQL Database with the `Redirect` connection policy cannot be reached while pinning
 * is on; `Proxy` policy (the default for outside-Azure clients) is unaffected.
 */
export function pinnedTediousConnector(
  dsnHost: string,
  pinnedHost: string,
): (
  opts: { host: string; port: number },
  lookup?: unknown,
  signal?: AbortSignal,
) => Promise<net.Socket> {
  return (opts, _lookup, signal) =>
    new Promise<net.Socket>((resolve, reject) => {
      signal?.throwIfAborted();
      if (opts.host !== dsnHost) {
        reject(
          new Error(
            "Refusing a server-directed connection redirect (host is not the validated one)",
          ),
        );
        return;
      }
      const socket = connectPinned(opts.port, pinnedHost);
      const onAbort = () => {
        cleanup();
        socket.destroy();
        reject(signal?.reason ?? new Error("aborted"));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onConnect = () => {
        cleanup();
        resolve(socket);
      };
      const cleanup = () => {
        socket.removeListener("error", onError);
        socket.removeListener("connect", onConnect);
        signal?.removeEventListener("abort", onAbort);
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
}
