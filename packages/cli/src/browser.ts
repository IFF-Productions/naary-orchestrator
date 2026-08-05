/**
 * Best-effort browser launch for `naary auth login`.
 *
 * Best-effort is the whole contract: the device-code flow was chosen partly BECAUSE it works where
 * a browser cannot be launched at all (#1078 §2 — "loopback breaks over SSH, which is exactly where
 * a CLI gets used"). So every failure here is silent and returns `false`; the caller has already
 * printed the URL and the code, which is all the user actually needs.
 */

import { spawn } from "node:child_process";

/**
 * Open `url` in the platform browser. Returns false if we did not even try (bad scheme) or the
 * launcher could not be spawned.
 *
 * The scheme check is not paranoia about our own server: `verificationUri` comes from the API's
 * server-derived `appBaseUrl()`, but `--api-url` is user-supplied and this string reaches an OS
 * launcher, where a `file:`/`vbscript:`/`smb:` URL is a different and much less pleasant program
 * than a browser. Only http(s) is ever handed over. The URL is passed as an ARGV element, never
 * through a shell, so there is no quoting to get wrong.
 */
export function openBrowser(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // `start` is a cmd builtin, so it needs cmd; the empty "" is its title argument, without
          // which cmd treats a quoted URL as the window title and opens nothing.
          ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], {
      stdio: "ignore",
      detached: true,
    });
    // A missing `xdg-open` surfaces asynchronously as an 'error' event, not as a throw. Unhandled,
    // that is an uncaught exception that kills the CLI mid-login on a headless box.
    child.on("error", () => undefined);
    // Don't hold the event loop open: the login finishes when the poll finishes, not when the
    // browser exits.
    child.unref();
    return true;
  } catch {
    return false;
  }
}
