/**
 * The Socket.IO client.
 *
 * One connection per tab, shared by the wallet (live balance) and poker. It authenticates
 * with the in-memory access token, and because that token expires every 15 minutes the
 * connect handler re-reads it on each attempt rather than capturing it once.
 */
import { io, type Socket } from "socket.io-client";
import { WALLET_EVENTS } from "@luck-cays/shared";
import { getAccessToken } from "./client";
import { useWalletStore } from "@/stores/wallet";

let socket: Socket | null = null;

export function getSocket(): Socket | null {
  return socket;
}

export function connectSocket(): Socket {
  if (socket?.connected) return socket;
  if (socket) {
    socket.connect();
    return socket;
  }

  socket = io({
    // Same origin: Vite proxies /socket.io through to the API, so the browser sees one host.
    path: "/socket.io",
    transports: ["websocket", "polling"],
    // A function, not a value: the token rotates, and a captured one would be stale on
    // the first reconnect after it expires.
    auth: (callback) => callback({ token: getAccessToken() }),
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
  });

  socket.on(WALLET_EVENTS.balance, (payload: { balance: string }) => {
    useWalletStore().setBalance(payload.balance);
  });

  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
