import type { ServerWebSocket } from "bun";
import { verifyToken } from "../auth/jwt.js";

export type WsData = { userId: string };
type BunWs = ServerWebSocket<WsData>;

const rooms = new Map<string, Set<BunWs>>();
const clientRooms = new WeakMap<BunWs, Set<string>>();

function addToRoom(ws: BunWs, room: string) {
  let set = rooms.get(room);
  if (!set) {
    set = new Set();
    rooms.set(room, set);
  }
  set.add(ws);

  let owned = clientRooms.get(ws);
  if (!owned) {
    owned = new Set();
    clientRooms.set(ws, owned);
  }
  owned.add(room);
}

function removeFromRoom(ws: BunWs, room: string) {
  const set = rooms.get(room);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(room);
  }
  clientRooms.get(ws)?.delete(room);
}

function removeFromAllRooms(ws: BunWs) {
  const owned = clientRooms.get(ws);
  if (!owned) return;
  for (const room of owned) {
    const set = rooms.get(room);
    if (set) {
      set.delete(ws);
      if (set.size === 0) rooms.delete(room);
    }
  }
  clientRooms.delete(ws);
}

export function handleWsUpgrade(req: Request, server: any): Response | undefined {
  const url = new URL(req.url);
  if (url.pathname !== "/ws") return undefined;

  const token = url.searchParams.get("token");
  if (!token) return new Response("Unauthorized", { status: 401 });

  try {
    const payload = verifyToken(token);
    const ok = server.upgrade(req, { data: { userId: payload.userId } });
    if (!ok) return new Response("WebSocket upgrade failed", { status: 500 });
    return undefined;
  } catch {
    return new Response("Invalid token", { status: 401 });
  }
}

export const websocketHandler = {
  open(_ws: BunWs) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[WS] client connected");
    }
  },

  message(ws: BunWs, message: string | Buffer) {
    try {
      const msg = JSON.parse(typeof message === "string" ? message : message.toString());
      if (msg.type === "join" && typeof msg.projectId === "string") {
        addToRoom(ws, `project:${msg.projectId}`);
        if (process.env.NODE_ENV !== "production") {
          console.log(`[WS] client joined project:${msg.projectId}`);
        }
      } else if (msg.type === "leave" && typeof msg.projectId === "string") {
        removeFromRoom(ws, `project:${msg.projectId}`);
      }
    } catch {
      // ignore malformed messages
    }
  },

  close(ws: BunWs) {
    removeFromAllRooms(ws);
    if (process.env.NODE_ENV !== "production") {
      console.log("[WS] client disconnected");
    }
  },
};

export function broadcast(projectId: string, event: string, data: unknown) {
  const room = `project:${projectId}`;
  const clients = rooms.get(room);
  const count = clients?.size ?? 0;
  if (process.env.NODE_ENV !== "production") {
    console.log(`[WS] broadcast ${event} to ${room} (${count} clients)`);
  }
  if (!clients) return;
  const payload = JSON.stringify({ type: event, data });
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(payload);
    }
  }
}
