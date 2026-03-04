import { Hono } from "hono";
import { z } from "zod";
import { Project, SessionRecording, Visitor } from "../db/models.js";
import { requireAuth } from "../auth/middleware.js";
import { requireProjectOwnership } from "../lib/ownership.js";
import { analyzeRecording } from "../services/recording-analyzer.js";
import { existsSync, mkdirSync, unlinkSync, readFileSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";

const UPLOADS_DIR = join(import.meta.dir, "../../uploads/recordings");

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── Public endpoint (called by tracker script) ─────────────────────

const recordingBodySchema = z.object({
  projectKey: z.string().min(1),
  visitorId: z.string().min(1),
  sessionId: z.string().min(1),
  chunk: z.array(z.any()),
  chunkIndex: z.number(),
  isFinal: z.boolean(),
});

export const publicRecordingRoute = new Hono();

publicRecordingRoute.post("/recording", async (c) => {
  try {
    const raw = await c.req.json();
    const parsed = recordingBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ ok: false, error: "Invalid payload" }, 400);
    }

    const { projectKey, visitorId, sessionId, chunk, chunkIndex, isFinal } = parsed.data;

    const project = await Project.findOne({ publicKey: projectKey }).select("id recordingEnabled");
    if (!project || !project.recordingEnabled) {
      return c.json({ ok: false }, 404);
    }

    const pid = project.id;
    const projectDir = join(UPLOADS_DIR, pid);
    ensureDir(projectDir);

    const eventsFilePath = join(projectDir, `${sessionId}.json`);
    const relPath = `recordings/${pid}/${sessionId}.json`;

    if (chunk.length > 0) {
      if (chunkIndex === 0) {
        writeFileSync(eventsFilePath, JSON.stringify(chunk));
      } else {
        let existing: any[] = [];
        try {
          existing = JSON.parse(readFileSync(eventsFilePath, "utf-8"));
        } catch {}
        existing.push(...chunk);
        writeFileSync(eventsFilePath, JSON.stringify(existing));
      }
    }

    const pages = new Set<string>();
    for (const evt of chunk) {
      if (evt.type === 4 && evt.data?.href) {
        try {
          pages.add(new URL(evt.data.href).pathname);
        } catch {}
      }
    }

    const now = new Date();

    await SessionRecording.findOneAndUpdate(
      { projectId: pid, sessionId },
      {
        $setOnInsert: {
          projectId: pid,
          visitorId,
          sessionId,
          startedAt: now,
        },
        $set: {
          eventsFile: relPath,
          ...(isFinal ? { status: "ready", endedAt: now } : { status: "recording" }),
        },
        $inc: { eventsCount: chunk.length },
        $addToSet: { pagesVisited: { $each: [...pages] } },
      },
      { upsert: true, returnDocument: "after" }
    );

    if (isFinal) {
      const rec = await SessionRecording.findOne({ projectId: pid, sessionId });
      if (rec) {
        const startMs = rec.startedAt.getTime();
        const endMs = now.getTime();
        const durationSec = Math.round((endMs - startMs) / 1000);
        await SessionRecording.findByIdAndUpdate(rec.id, { duration: durationSec }, { returnDocument: "after" });

        analyzeRecording(rec.id).catch((err: unknown) =>
          console.error("[Recording] Analysis failed:", (err as Error)?.message || err)
        );
      }
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("[Recording] Ingest error:", err);
    return c.json({ ok: false }, 500);
  }
});

// ─── Protected endpoints ────────────────────────────────────────────

type Env = { Variables: { userId: string } };
const recordings = new Hono<Env>();
recordings.use("/*", requireAuth);

recordings.get("/projects/:projectId/recordings", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const skip = (page - 1) * limit;

  const mongoWhere: Record<string, unknown> = { projectId };

  const status = c.req.query("status");
  if (status) mongoWhere.status = status;

  const sentiment = c.req.query("sentiment");
  if (sentiment) mongoWhere.sentiment = sentiment;

  const visitorId = c.req.query("visitorId");
  if (visitorId) mongoWhere.visitorId = { $regex: visitorId, $options: "i" };

  const dateFrom = c.req.query("dateFrom");
  const dateTo = c.req.query("dateTo");
  if (dateFrom || dateTo) {
    mongoWhere.startedAt = {};
    if (dateFrom) (mongoWhere.startedAt as Record<string, Date>).$gte = new Date(dateFrom);
    if (dateTo) (mongoWhere.startedAt as Record<string, Date>).$lte = new Date(dateTo);
  }

  const [total, items] = await Promise.all([
    SessionRecording.countDocuments(mongoWhere),
    SessionRecording.find(mongoWhere)
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("visitorId sessionId status eventsCount duration pagesVisited startedAt endedAt summary sentiment analyzedAt"),
  ]);

  const visitorIds = [...new Set(items.map((r) => r.visitorId))];
  const visitors = await Visitor.find({ projectId, visitorId: { $in: visitorIds } }).select(
    "visitorId name email country countryCode device"
  );
  const visitorMap = new Map(visitors.map((v) => [v.visitorId, v]));

  const enriched = items.map((r) => ({
    ...r,
    visitor: visitorMap.get(r.visitorId) || null,
  }));

  return c.json({
    recordings: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

recordings.get("/projects/:projectId/recordings/:id", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  await requireProjectOwnership(projectId, userId);

  const rec = await SessionRecording.findOne({ _id: id, projectId });
  if (!rec) return c.json({ error: "Recording not found" }, 404);

  const visitor = await Visitor.findOne({ projectId, visitorId: rec.visitorId }).select(
    "visitorId name email country countryCode city device browser os"
  );

  return c.json({ recording: { ...rec, visitor } });
});

recordings.get("/projects/:projectId/recordings/:id/events", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  await requireProjectOwnership(projectId, userId);

  const rec = await SessionRecording.findOne({ _id: id, projectId }).select("eventsFile");
  if (!rec || !rec.eventsFile) return c.json({ error: "Recording not found" }, 404);

  const fullPath = join(UPLOADS_DIR, "..", rec.eventsFile);
  if (!existsSync(fullPath)) return c.json({ error: "Events file not found" }, 404);

  const data = readFileSync(fullPath, "utf-8");
  c.header("Content-Type", "application/json");
  return c.body(data);
});

recordings.delete("/projects/:projectId/recordings/:id", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  await requireProjectOwnership(projectId, userId);

  const rec = await SessionRecording.findOne({ _id: id, projectId });
  if (!rec) return c.json({ error: "Recording not found" }, 404);

  if (rec.eventsFile) {
    const fullPath = join(UPLOADS_DIR, "..", rec.eventsFile);
    try { unlinkSync(fullPath); } catch {}
  }

  await SessionRecording.findByIdAndDelete(id);
  return c.json({ ok: true });
});

recordings.post("/projects/:projectId/recordings/:id/analyze", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  await requireProjectOwnership(projectId, userId);

  const rec = await SessionRecording.findOne({ _id: id, projectId });
  if (!rec) return c.json({ error: "Recording not found" }, 404);

  await SessionRecording.findByIdAndUpdate(id, { status: "analyzing" }, { returnDocument: "after" });

  analyzeRecording(id).catch((err: unknown) =>
    console.error("[Recording] Re-analysis failed:", (err as Error)?.message || err)
  );

  return c.json({ ok: true, message: "Analysis started" });
});

recordings.patch("/projects/:projectId/settings/recording", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const body = await c.req.json<{ enabled: boolean }>();
  await Project.findByIdAndUpdate(projectId, { recordingEnabled: !!body.enabled }, { returnDocument: "after" });

  return c.json({ ok: true, recordingEnabled: !!body.enabled });
});

export default recordings;
