/**
 * The game side of the `postMessage` bridge.
 *
 * Two rules, both about not trusting the frame we are inside:
 *
 *  - Outbound messages go to a specific target origin, never `"*"`. A wildcard would hand
 *    the balance and round results to whatever page happened to embed us.
 *  - Inbound messages are parsed with a zod schema and only accepted from the origin that
 *    embedded us. The host can mute us and hand us a new session; it cannot set a balance or
 *    place a bet, because the protocol has no message for either.
 */
import {
  EMBED_PROTOCOL,
  hostToGameSchema,
  type GameToHostMessage,
  type HostToGameMessage,
} from "@luck-cays/shared";

/**
 * Where to send messages.
 *
 * `document.referrer` is the embedding page, which is the only reliable way to learn it from
 * inside an iframe - `window.parent.location` is cross-origin and unreadable. If there is no
 * referrer we are not embedded, and there is nobody to talk to.
 */
function hostOrigin(): string | null {
  if (window.parent === window) return null;
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

const target = hostOrigin();

export function postToHost(message: GameToHostMessage): void {
  if (!target) return;
  window.parent.postMessage(message, target);
}

/** Listen for the small set of things a host is allowed to ask for. */
export function listenToHost(handler: (message: HostToGameMessage) => void): () => void {
  const onMessage = (event: MessageEvent): void => {
    // Only the page that embedded us, and only our own protocol.
    if (target && event.origin !== target) return;

    const payload = event.data as { protocol?: unknown } | null;
    if (!payload || payload.protocol !== EMBED_PROTOCOL) return;

    const parsed = hostToGameSchema.safeParse(event.data);
    if (!parsed.success) return;

    handler(parsed.data);
  };

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
