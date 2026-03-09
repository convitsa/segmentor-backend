import { Hono } from "hono";
import { gunzipSync } from "zlib";
import { requireAuth } from "../auth/middleware.js";
import { requireProjectOwnership } from "../lib/ownership.js";
import { Recording, RecordingChunk, Visitor, SegiConversation, SegiMessage } from "../db/models.js";
import { friendlyName } from "../lib/friendly-name.js";
import { analyzeAndStore } from "../services/journeyAnalyzer.js";

type Env = { Variables: { userId: string } };

const replays = new Hono<Env>();

replays.use("/*", requireAuth);

replays.get("/projects/:projectId/replays", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));
  const skip = (page - 1) * limit;

  const filterDevice = c.req.query("device") || "";
  const filterCountry = c.req.query("country") || "";
  const filterMinDuration = parseInt(c.req.query("minDuration") || "0", 10);
  const filterVisitor = c.req.query("visitor") || "";
  const filterAfter = c.req.query("after") || "";
  const filterBefore = c.req.query("before") || "";
  const sortBy = c.req.query("sortBy") || "startedAt";
  const sortOrder = c.req.query("sortOrder") === "asc" ? 1 : -1;

  const where: Record<string, unknown> = { projectId };

  if (filterDevice) where.device = filterDevice;
  if (filterCountry) where.country = filterCountry;
  if (filterMinDuration > 0) where.duration = { $gte: filterMinDuration };
  if (filterVisitor) {
    where.$or = [
      { visitorId: { $regex: filterVisitor, $options: "i" } },
    ];
  }
  if (filterAfter || filterBefore) {
    const dateRange: Record<string, Date> = {};
    if (filterAfter) dateRange.$gte = new Date(filterAfter);
    if (filterBefore) dateRange.$lte = new Date(filterBefore);
    where.startedAt = dateRange;
  }

  const [recordings, total] = await Promise.all([
    Recording.find(where)
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(limit)
      .lean(),
    Recording.countDocuments(where),
  ]);

  const visitorIds = [...new Set(recordings.map((r: any) => r.visitorId))];
  const visitors = await Visitor.find(
    { projectId, visitorId: { $in: visitorIds } },
    { visitorId: 1, email: 1, name: 1, isRandomName: 1 },
  ).lean();
  const visitorMap = new Map(visitors.map((v: any) => [v.visitorId, v]));

  const items = recordings.map((r: any) => {
    const v = visitorMap.get(r.visitorId);
    const start = r.startedAt ? new Date(r.startedAt).getTime() : 0;
    const end = r.endedAt ? new Date(r.endedAt).getTime() : Date.now();
    const computedDuration = start ? Math.max(0, Math.round((end - start) / 1000)) : 0;
    return {
      id: r._id?.toString(),
      sessionId: r.sessionId,
      visitorId: r.visitorId,
      visitorName: v?.name || v?.email || friendlyName(r.visitorId),
      visitorEmail: v?.email || null,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      duration: computedDuration,
      pageCount: r.pageCount,
      clickCount: r.clickCount,
      entryUrl: r.entryUrl,
      device: r.device,
      browser: r.browser,
      os: r.os,
      country: r.country,
      countryCode: r.countryCode,
      chunkCount: r.chunkCount,
      totalSize: r.totalSize,
    };
  });

  return c.json({
    replays: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

replays.get("/projects/:projectId/replays/:sessionId", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const sessionId = c.req.param("sessionId");
  await requireProjectOwnership(projectId, userId);

  const recording = await Recording.findOne({ projectId, sessionId }).lean();
  if (!recording) return c.json({ error: "Replay not found" }, 404);

  const chunks = await RecordingChunk.find({ projectId, sessionId })
    .sort({ seqNum: 1 })
    .lean();

  const events: unknown[] = [];
  for (const chunk of chunks) {
    try {
      const raw = (chunk as any).events;
      const buf = Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw.buffer ?? raw);
      const decompressed = gunzipSync(buf);
      const parsed = JSON.parse(decompressed.toString("utf-8"));
      if (Array.isArray(parsed)) {
        events.push(...parsed);
      }
    } catch (err) {
      console.error("Chunk decompression error:", err);
    }
  }

  let computedDuration = 0;
  if (events.length >= 2) {
    const firstTs = (events[0] as any).timestamp;
    const lastTs = (events[events.length - 1] as any).timestamp;
    if (typeof firstTs === "number" && typeof lastTs === "number") {
      computedDuration = Math.max(0, Math.round((lastTs - firstTs) / 1000));
    }
  }
  if (!computedDuration) {
    const start = (recording as any).startedAt ? new Date((recording as any).startedAt).getTime() : 0;
    const end = (recording as any).endedAt ? new Date((recording as any).endedAt).getTime() : Date.now();
    computedDuration = start ? Math.max(0, Math.round((end - start) / 1000)) : 0;
  }

  const v = await Visitor.findOne(
    { projectId, visitorId: (recording as any).visitorId },
    { visitorId: 1, email: 1, name: 1, isRandomName: 1 },
  ).lean();

  return c.json({
    id: (recording as any)._id?.toString(),
    sessionId: (recording as any).sessionId,
    visitorId: (recording as any).visitorId,
    visitorName: v?.name || v?.email || friendlyName((recording as any).visitorId),
    visitorEmail: v?.email || null,
    status: (recording as any).status,
    startedAt: (recording as any).startedAt,
    endedAt: (recording as any).endedAt,
    duration: computedDuration,
    pageCount: (recording as any).pageCount,
    clickCount: (recording as any).clickCount,
    entryUrl: (recording as any).entryUrl,
    device: (recording as any).device,
    browser: (recording as any).browser,
    os: (recording as any).os,
    country: (recording as any).country,
    countryCode: (recording as any).countryCode,
    journeySummary: (recording as any).journeySummary || null,
    events,
  });
});

replays.post("/projects/:projectId/replays/:sessionId/analyze", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const sessionId = c.req.param("sessionId");
  await requireProjectOwnership(projectId, userId);

  const recording = await Recording.findOne({ projectId, sessionId }).lean();
  if (!recording) return c.json({ error: "Replay not found" }, 404);

  const summary = await analyzeAndStore(projectId, sessionId);
  if (!summary) return c.json({ error: "Analysis failed — AI may not be configured" }, 503);

  return c.json({ journeySummary: summary });
});

replays.post("/projects/:projectId/replays/:sessionId/analyze-chat", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const sessionId = c.req.param("sessionId");
  await requireProjectOwnership(projectId, userId);

  const recording = await Recording.findOne({ projectId, sessionId }).lean() as any;
  if (!recording) return c.json({ error: "Recording not found" }, 404);

  const existing = await SegiConversation.findOne({ projectId, recordingSessionId: sessionId }).lean() as any;
  if (existing) {
    const aiResponse = await SegiMessage.findOne({
      conversationId: existing._id,
      role: "assistant",
    }).lean();
    if (!aiResponse) {
      await SegiMessage.deleteMany({ conversationId: existing._id });
    }
    return c.json({ conversationId: existing._id.toString() });
  }

  const v = await Visitor.findOne(
    { projectId, visitorId: recording.visitorId },
    { visitorId: 1, email: 1, name: 1 },
  ).lean() as any;
  const visitorName = v?.name || v?.email || friendlyName(recording.visitorId);

  const conversation = await SegiConversation.create({
    projectId,
    title: `Session Analysis — ${visitorName}`,
    recordingSessionId: sessionId,
  });

  return c.json({ conversationId: conversation._id.toString() });
});

replays.delete("/projects/:projectId/replays/:sessionId", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const sessionId = c.req.param("sessionId");
  await requireProjectOwnership(projectId, userId);

  const recording = await Recording.findOne({ projectId, sessionId });
  if (!recording) return c.json({ error: "Replay not found" }, 404);

  await Promise.all([
    Recording.deleteOne({ projectId, sessionId }),
    RecordingChunk.deleteMany({ projectId, sessionId }),
  ]);

  return c.json({ ok: true });
});

export default replays;
