# Embedding Luck-Cays slots in our sites

Any Luck-Cays front-end can mount a playable slot in an iframe. The game runs on our game
origin, decides nothing locally, and talks to the host page over `postMessage`.

This is for **our own front-ends**. Letting a third party embed games is a different and much
larger job — see [Not supported yet](#not-supported-yet).

---

## Quick start

```html
<div id="slot"></div>
<script src="https://games.luck-cays.com/embed.js"></script>
<script>
  const game = LuckCays.mount("#slot", {
    apiBase: "https://api.luck-cays.com/api",
    game: "reef-riches",
    brand: "reef",

    // Your page's own player session. Used for the ticket request and nothing else;
    // it never reaches the iframe.
    getAuthToken: () => myApp.accessToken,

    onBalance: (balance) => myApp.setBalance(balance),
    onRound: ({ bet, win }) => console.log("round settled", bet, win),
    onExit: () => myApp.closeGameModal(),
    onError: (error) => myApp.showError(error.message),
  });

  // Single-page host? Call this on route change or the iframe and its listener leak.
  // game.destroy();
</script>
```

Locally, `apiBase` is `/api` and the loader is at <http://localhost:5173/embed.js>.

---

## How a launch works

```
host page                     api                          game iframe
─────────                     ───                          ───────────
POST /api/launch ───────────→ mint one-shot ticket
  (player's token)            (60s, single use,
                               pinned to game + origin)
      ←─────────────────────── { launchUrl }

build <iframe src=launchUrl> ──────────────────────────────→ loads
                              POST /api/launch/exchange ←─── redeems ticket (once)
                              ───────────────────────────→ { sessionToken, balance }
                                                            game-scoped, 2h

                              POST /api/slots/spin    ←──── plays
```

Four properties worth understanding, because the design exists for them:

**The host page never holds a game credential.** It holds its own player token, trades it for
a ticket, and passes the ticket in a URL. A page that cannot hold the game's session cannot
leak it.

**The ticket is single use and lives 60 seconds.** URLs leak — into browser history, proxy
logs, `Referer` headers, screenshots. A ticket found anywhere is already spent or expired.
Enforced by a guarded update, so two frames racing the same ticket cannot both redeem it.

**The game session is not an account.** It is a JWT on a different audience
(`luck-cays-game`), carrying only a user id, a game slug and a brand — **no role**. It cannot
claim a bonus, read the ledger, change a password or reach a staff route. The audience check is
done by the JWT library, not by remembering to check a claim at each call site. This matters
because the game runs in an iframe: if its session were a full account token, an XSS anywhere
in that frame would be an account takeover.

**A session can play exactly one game.** The slug is inside the token, not just the URL, so a
session minted for `reef-riches` cannot spin `krakens-depths`. Enforced on every spin by
`assertGameAllowed`.

---

## `postMessage` protocol

Namespaced `lc-embed/1`, because a host page's `window` is shared with analytics, chat widgets
and other embeds.

### Game → host

| Message   | Meaning                                                            |
| --------- | ------------------------------------------------------------------ |
| `ready`   | Loaded and session redeemed                                        |
| `balance` | Balance changed; mirror it in your header if you show one          |
| `round`   | A round settled: `bet`, `win`, `freeSpinsAwarded`                  |
| `resize`  | Desired height; the loader applies it unless you set `fixedHeight` |
| `exit`    | The player closed the game — navigate or close your modal          |
| `error`   | Something failed, with a `code`                                    |

### Host → game

| Message  | Meaning                                          |
| -------- | ------------------------------------------------ |
| `mute`   | Mute or unmute                                   |
| `resume` | Hand over a fresh ticket after a session expired |

The host-to-game set is deliberately tiny, and deliberately contains **nothing that could
influence an outcome or a balance**. There is no "set balance" and no "place bet" message. If
there were, every embedding page would become part of the trust boundary.

Both directions check origin, and outbound messages always name a target origin rather than
`"*"`.

---

## Session expiry

A game session lasts two hours. When it lapses the game emits
`error` with code `GAME_SESSION_EXPIRED` rather than silently failing.

`embed.js` handles this for you: it mints a fresh ticket and sends `resume`, so the player keeps
their place and any free-spin run continues. Reloading the iframe would work too but would
throw away the UI state for no reason.

---

## Options

| Option                                                     | Required | Notes                                                                     |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `apiBase`                                                  | yes      | e.g. `https://api.luck-cays.com/api`                                      |
| `game`                                                     | yes      | Slug: `reef-riches`, `krakens-depths`, `sunken-temple`                    |
| `getAuthToken`                                             | yes      | Returns the host's player token; may return a promise                     |
| `brand`                                                    |          | `luck-cays` (default), `reef`, `abyss`, `temple` — sets the accent colour |
| `returnUrl`                                                |          | Where to send the player on exit; must be an allowed origin               |
| `fixedHeight`                                              |          | Pin the height in px and ignore `resize`                                  |
| `borderRadius`                                             |          | Defaults to `12px`                                                        |
| `onReady` / `onBalance` / `onRound` / `onExit` / `onError` |          | Callbacks                                                                 |

Returns `{ destroy(), mute(muted), reload() }`.

---

## Configuration

Server side:

```bash
GAME_ORIGIN=https://games.luck-cays.com     # where game.html is served
EMBED_ORIGINS=https://reef.example,https://abyss.example   # our other front-ends
```

`WEB_ORIGIN` is always allowed. Both the CORS allowlist and the launch origin check read these,
so adding a brand is one environment change.

**In production, serve the game from a different origin to the host sites.** That is what makes
the iframe a real boundary — same-origin would let an XSS in a host page reach the game's
session and vice versa. In development both are the same Vite server, which loses the isolation
but keeps setup to one command.

The game host should also send `Content-Security-Policy: frame-ancestors` listing your embedding
origins, so nobody else can frame it. The API already sends `frame-ancestors 'none'` for itself.

---

## Why an iframe rather than an npm package

The engine would be safe to publish — reel strips are already public in the API, and knowing a
strip tells you nothing about the next stop, which comes from `crypto.randomInt` on the server.
But the RNG and round settlement cannot leave the server, so a package would **still** need the
same game server. You would just also inherit version skew across every embedding site and lose
origin isolation.

A component package is a reasonable addition later if a site wants deep visual integration. It
is a worse default.

---

## Not supported yet

**Third-party operators.** Letting someone else's site embed these games, where _they_ hold the
player and the wallet, needs considerably more: per-operator credentials, HMAC-signed
server-to-server wallet callbacks, cross-system idempotency and reconciliation (you cannot run a
two-phase commit against someone else's wallet), per-operator RTP configs, and the certification
conversation that comes with being a game supplier.

The seam that work would hook into is `wallet.service.ts`, whose `transact()` is already the
single chokepoint every chip movement in a spin passes through. That is a deliberate property,
not a coincidence — but no abstraction has been built over it, because one interface with one
implementation is speculative generality.

**Games other than slots.** Poker needs a persistent socket and a seat, so it does not fit the
one-shot launch model without more thought. Sports betting is a browsing experience rather than
a game and belongs in a page, not a frame.
