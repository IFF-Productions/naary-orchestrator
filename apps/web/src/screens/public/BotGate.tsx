// The public form/chat bot gate — one component, two providers
// (docs/design/TENANT-BOT-GATE-PROVIDERS.md, slice 2).
//
// The pages no longer know which gate they are showing: they read `botGate` off the public
// definition, hand it here, and get a token back. Turnstile renders the existing interactive
// widget; App Check renders NOTHING and mints an invisible attestation token.
//
// Three signals, because "no token yet" and "no token ever" must not look the same to the
// caller. Turnstile's script being blocked by an extension, or App Check being absent from
// this build, has to leave the page usable — the server is the only side that knows whether
// it can enforce, and it fails open when it can't. Blocking submit on a token we will never
// get would strand the visitor with a permanently greyed-out button and no explanation.
import { useEffect, useRef } from "react";
import type { BotGate as BotGateDescriptor } from "../../lib/api/types";
import { TurnstileWidget } from "./TurnstileWidget";

export interface BotGateProps {
  gate: BotGateDescriptor;
  /** A fresh, single-use token. */
  onToken: (token: string) => void;
  /** The token was cleared (spent/expired/re-armed) — stop allowing submit. */
  onReset?: () => void;
  /**
   * This gate cannot produce a token here at all. Callers should STOP gating submit and let
   * the server decide, rather than blocking forever.
   */
  onUnavailable?: () => void;
  /** Bump to re-arm after a token was spent. App Check tokens are single-use, so every
   *  submission needs this — Turnstile's already did. */
  resetSignal?: number;
}

export function BotGate({
  gate,
  onToken,
  onReset,
  onUnavailable,
  resetSignal = 0,
}: BotGateProps) {
  if (gate.provider === "turnstile") {
    return (
      <TurnstileWidget
        siteKey={gate.siteKey}
        onToken={onToken}
        onReset={onReset}
        onUnavailable={onUnavailable}
        resetSignal={resetSignal}
      />
    );
  }
  return (
    <AppCheckGate
      onToken={onToken}
      onReset={onReset}
      onUnavailable={onUnavailable}
      resetSignal={resetSignal}
    />
  );
}

/**
 * Invisible App Check gate: fetch a limited-use token on mount and on every re-arm.
 *
 * The Firebase modules are pulled in by DYNAMIC import, so a tenant on Turnstile (or on no
 * gate at all) never ships firebase/app + firebase/app-check to an anonymous visitor. It also
 * guarantees `initAppCheck` has run — importing lib/firebase is what initializes it, and this
 * component may be the first thing on the page to need it.
 */
function AppCheckGate({
  onToken,
  onReset,
  onUnavailable,
  resetSignal,
}: Omit<BotGateProps, "gate">) {
  // Keep callbacks current without re-triggering the fetch (which would spend a token).
  const cb = useRef({ onToken, onReset, onUnavailable });
  useEffect(() => {
    cb.current = { onToken, onReset, onUnavailable };
  });

  useEffect(() => {
    let cancelled = false;
    // Re-arming means the old token is gone; say so before the async gap so submit can't fire
    // with a spent token in hand.
    if (resetSignal) cb.current.onReset?.();
    void (async () => {
      try {
        const { mintBotGateToken } = await import("../../lib/firebase");
        const token = await mintBotGateToken();
        if (cancelled) return;
        if (token) cb.current.onToken(token);
        else cb.current.onUnavailable?.();
      } catch {
        // The chunk itself failed to load (offline, stale deploy). Same conclusion.
        if (!cancelled) cb.current.onUnavailable?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resetSignal]);

  return null;
}
