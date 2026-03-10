import type { ServerWebSocket } from "bun";
import { verifyToken } from "../auth/jwt.js";

export type WsData = {
  userId?: string;
  role?: "agent" | "visitor";
  sessionId?: string;
  projectId?: string;
};
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

  if (url.pathname === "/ws") {
    const token = url.searchParams.get("token");
    if (!token) return new Response("Unauthorized", { status: 401 });

    try {
      const payload = verifyToken(token);
      const ok = server.upgrade(req, { data: { userId: payload.userId, role: "agent" as const } });
      if (!ok) return new Response("WebSocket upgrade failed", { status: 500 });
      return undefined;
    } catch {
      return new Response("Invalid token", { status: 401 });
    }
  }

  if (url.pathname === "/ws/visitor") {
    const sessionId = url.searchParams.get("sessionId");
    const projectKey = url.searchParams.get("projectKey");
    if (!sessionId || !projectKey) return new Response("Missing params", { status: 400 });

    const ok = server.upgrade(req, {
      data: { role: "visitor" as const, sessionId, projectId: projectKey },
    });
    if (!ok) return new Response("WebSocket upgrade failed", { status: 500 });
    return undefined;
  }

  return undefined;
}

export const websocketHandler = {
  open(ws: BunWs) {
    if (ws.data.role === "visitor" && ws.data.sessionId) {
      addToRoom(ws, `visitor:${ws.data.sessionId}`);
    }
    if (process.env.NODE_ENV !== "production") {
      console.log(`[WS] ${ws.data.role || "unknown"} connected${ws.data.sessionId ? ` (session:${ws.data.sessionId})` : ""}`);
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
      } else if (msg.type === "cb_join" && typeof msg.sessionId === "string") {
        const room = `cobrowse:${msg.sessionId}`;
        addToRoom(ws, room);
        broadcastToRoom(room, JSON.stringify({ type: "cb_agent_joined" }), ws);
      } else if (msg.type === "cb_visitor_ready") {
        const sid = ws.data.sessionId;
        if (sid) {
          const room = `cobrowse:${sid}`;
          addToRoom(ws, room);
          broadcastToRoom(room, JSON.stringify({ type: "cb_visitor_ready", sessionId: sid }), ws);
        }
      } else if (msg.type === "cb_rrweb" || msg.type === "cb_cursor" || msg.type === "cb_highlight") {
        const sid = ws.data.sessionId || msg.sessionId;
        if (sid) {
          const room = `cobrowse:${sid}`;
          broadcastToRoom(room, typeof message === "string" ? message : message.toString(), ws);
        }
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

export function broadcastToRoom(room: string, payload: string, exclude?: BunWs) {
  const clients = rooms.get(room);
  if (!clients) return;
  for (const ws of clients) {
    if (ws !== exclude && ws.readyState === 1) {
      ws.send(payload);
    }
  }
}

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
