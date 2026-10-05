/**
 * Luck-Cays game embed loader.
 *
 * Drop-in, no build step, no dependencies. Any of our front-ends can include this and mount a
 * game in three lines:
 *
 *   <div id="slot"></div>
 *   <script src="https://games.luck-cays.com/embed.js"></script>
 *   <script>
 *     LuckCays.mount("#slot", {
 *       apiBase: "https://api.luck-cays.com/api",
 *       game: "reef-riches",
 *       brand: "reef",
 *       getAuthToken: () => myApp.accessToken,   // the host's own player session
 *       onBalance: (balance) => myApp.setBalance(balance),
 *     });
 *   </script>
 *
 * What it does: asks the API for a one-shot launch ticket, builds the iframe, and relays
 * `postMessage` traffic to your callbacks. It also handles the one piece of lifecycle that is
 * easy to get wrong - when the game's session expires it mints a fresh ticket and hands it
 * over, rather than reloading the iframe and losing the player's place.
 *
 * It deliberately does NOT hold a player token itself. You pass `getAuthToken`, it is used for
 * the ticket request and nothing else, and it never reaches the iframe.
 *
 * Plain JavaScript on purpose: this file is served as-is to pages that may have no bundler.
 */
(function (global) {
  "use strict";

  var PROTOCOL = "lc-embed/1";

  /** Default height before the game reports its own. Roughly a 5x3 grid plus controls. */
  var INITIAL_HEIGHT = 520;

  function assert(condition, message) {
    if (!condition) throw new Error("LuckCays.mount: " + message);
  }

  /**
   * Mount a game.
   *
   * Returns a handle with `destroy()`, `mute()` and `reload()`. Keep it: a single-page host
   * needs `destroy()` on route change or the iframe and its listener leak.
   */
  function mount(target, options) {
    var element = typeof target === "string" ? global.document.querySelector(target) : target;
    assert(element, "no element matched " + target);
    assert(options && options.game, "`game` is required");
    assert(options.apiBase, "`apiBase` is required");
    assert(typeof options.getAuthToken === "function", "`getAuthToken` must be a function");

    var apiBase = String(options.apiBase).replace(/\/$/, "");
    var brand = options.brand || "luck-cays";
    var onBalance = options.onBalance || function () {};
    var onRound = options.onRound || function () {};
    var onExit = options.onExit || function () {};
    var onError = options.onError || function () {};
    var onReady = options.onReady || function () {};

    var iframe = null;
    var gameOrigin = null;
    var destroyed = false;

    /** Ask our API for a one-shot ticket. The host's player token authorises this call. */
    function requestTicket() {
      return Promise.resolve(options.getAuthToken()).then(function (token) {
        assert(token, "getAuthToken() returned nothing - is the player signed in?");

        return global
          .fetch(apiBase + "/launch", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + token,
            },
            // The ticket request needs the host's session cookie in some setups; the game
            // itself never sends credentials.
            credentials: "include",
            body: JSON.stringify({
              gameSlug: options.game,
              brand: brand,
              origin: global.location.origin,
              returnUrl: options.returnUrl,
            }),
          })
          .then(function (response) {
            return response.text().then(function (text) {
              var payload = text ? JSON.parse(text) : null;
              if (!response.ok) {
                var error = payload && payload.error;
                throw new Error((error && error.message) || "Could not start the game");
              }
              return payload;
            });
          });
      });
    }

    function handleMessage(event) {
      if (destroyed) return;
      // Only the game's own origin, and only our protocol. A host page's window is shared
      // with analytics, chat widgets and other embeds; anything else here is not ours.
      if (gameOrigin && event.origin !== gameOrigin) return;
      if (!event.data || event.data.protocol !== PROTOCOL) return;

      var message = event.data;

      switch (message.type) {
        case "ready":
          onReady(message.gameSlug);
          break;

        case "balance":
          onBalance(message.balance);
          break;

        case "round":
          onRound({
            bet: message.bet,
            win: message.win,
            freeSpinsAwarded: message.freeSpinsAwarded,
          });
          break;

        case "resize":
          if (iframe && !options.fixedHeight) {
            iframe.style.height = message.height + "px";
          }
          break;

        case "exit":
          onExit();
          break;

        case "error":
          // An expired session is recoverable without a reload: mint a ticket and hand it
          // over, so the player keeps their place and any free-spin run continues.
          if (message.code === "GAME_SESSION_EXPIRED") {
            requestTicket()
              .then(function (ticket) {
                var url = new global.URL(ticket.launchUrl);
                send({ protocol: PROTOCOL, type: "resume", token: url.searchParams.get("token") });
              })
              .catch(function (error) {
                onError(error);
              });
            return;
          }
          onError(new Error(message.message || message.code));
          break;
      }
    }

    function send(message) {
      if (iframe && iframe.contentWindow && gameOrigin) {
        iframe.contentWindow.postMessage(message, gameOrigin);
      }
    }

    function build(ticket) {
      if (destroyed) return;

      gameOrigin = new global.URL(ticket.launchUrl).origin;

      iframe = global.document.createElement("iframe");
      iframe.src = ticket.launchUrl;
      iframe.title = "Luck-Cays game";
      iframe.style.width = "100%";
      iframe.style.height = (options.fixedHeight || INITIAL_HEIGHT) + "px";
      iframe.style.border = "0";
      iframe.style.display = "block";
      iframe.style.borderRadius = options.borderRadius || "12px";
      iframe.setAttribute("scrolling", "no");

      // Least privilege. The game needs scripts and same-origin (for its own storage); it is
      // explicitly NOT granted top-level navigation, so it cannot redirect the host page.
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      iframe.setAttribute("allow", "autoplay");

      element.appendChild(iframe);
      global.addEventListener("message", handleMessage);
    }

    requestTicket().then(build).catch(onError);

    return {
      /** Remove the iframe and stop listening. Call this on route change. */
      destroy: function () {
        destroyed = true;
        global.removeEventListener("message", handleMessage);
        if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
        iframe = null;
      },

      mute: function (muted) {
        send({ protocol: PROTOCOL, type: "mute", muted: muted !== false });
      },

      /** Start over with a fresh ticket. Use after a fatal error. */
      reload: function () {
        if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
        iframe = null;
        return requestTicket().then(build).catch(onError);
      },
    };
  }

  global.LuckCays = { mount: mount, PROTOCOL: PROTOCOL };
})(typeof window !== "undefined" ? window : globalThis);
