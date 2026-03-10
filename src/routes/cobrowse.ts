import { Hono } from "hono";
import { CobrowseSession } from "../db/models.js";
import { broadcastToRoom } from "../lib/websocket-hub.js";
import mongoose from "mongoose";

const cobrowse = new Hono();

cobrowse.post("/projects/:projectId/cobrowse/request", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await c.req.json<{ sessionId: string; visitorId: string }>();

  const session = await CobrowseSession.findOneAndUpdate(
    {
      projectId: new mongoose.Types.ObjectId(projectId),
      sessionId: body.sessionId,
      status: { $in: ["requested", "active"] },
    },
    {
      $setOnInsert: {
        projectId: new mongoose.Types.ObjectId(projectId),
        sessionId: body.sessionId,
        visitorId: body.visitorId,
        agentId: new mongoose.Types.ObjectId((c as any).get("userId")),
        status: "requested",
        startedAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );

  broadcastToRoom(
    `visitor:${body.sessionId}`,
    JSON.stringify({ type: "cobrowse:request", sessionId: body.sessionId }),
  );

  return c.json({ ok: true, cobrowseSessionId: session._id, status: session.status });
});

cobrowse.post("/projects/:projectId/cobrowse/:sessionId/end", async (c) => {
  const projectId = c.req.param("projectId");
  const sessionId = c.req.param("sessionId");

  await CobrowseSession.findOneAndUpdate(
    {
      projectId: new mongoose.Types.ObjectId(projectId),
      sessionId,
      status: { $in: ["requested", "active"] },
    },
    { $set: { status: "ended", endedAt: new Date() } },
  );

  broadcastToRoom(
    `visitor:${sessionId}`,
    JSON.stringify({ type: "cobrowse:end", sessionId }),
  );

  return c.json({ ok: true });
});

cobrowse.get("/projects/:projectId/cobrowse/active", async (c) => {
  const projectId = c.req.param("projectId");

  const sessions = await CobrowseSession.find({
    projectId: new mongoose.Types.ObjectId(projectId),
    status: { $in: ["requested", "active"] },
  }).lean();

  return c.json(sessions);
});

cobrowse.get("/projects/:projectId/cobrowse/check", async (c) => {
  const projectId = c.req.param("projectId");
  const sessionId = c.req.query("sessionId");

  if (!sessionId) return c.json({ active: false });

  const session = await CobrowseSession.findOne({
    projectId: new mongoose.Types.ObjectId(projectId),
    sessionId,
    status: { $in: ["requested", "active"] },
  }).lean();

  return c.json({ active: !!session, session });
});

export default cobrowse;
