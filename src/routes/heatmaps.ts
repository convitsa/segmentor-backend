import { Hono } from "hono";
import { HeatmapEvent } from "../db/models.js";
import mongoose from "mongoose";

const heatmaps = new Hono();

heatmaps.get("/projects/:projectId/heatmaps/pages", async (c) => {
  const projectId = c.req.param("projectId");

  const pages = await HeatmapEvent.aggregate([
    { $match: { projectId: new mongoose.Types.ObjectId(projectId) } },
    {
      $group: {
        _id: "$url",
        total: { $sum: 1 },
        clicks: { $sum: { $cond: [{ $eq: ["$type", "click"] }, 1, 0] } },
        moves: { $sum: { $cond: [{ $eq: ["$type", "move"] }, 1, 0] } },
        scrolls: { $sum: { $cond: [{ $eq: ["$type", "scroll"] }, 1, 0] } },
        lastEvent: { $max: "$timestamp" },
      },
    },
    { $sort: { total: -1 } },
    { $limit: 100 },
  ]);

  return c.json(
    pages.map((p) => ({
      url: p._id,
      total: p.total,
      clicks: p.clicks,
      moves: p.moves,
      scrolls: p.scrolls,
      lastEvent: p.lastEvent,
    })),
  );
});

heatmaps.get("/projects/:projectId/heatmaps/data", async (c) => {
  const projectId = c.req.param("projectId");
  const url = c.req.query("url");
  const type = c.req.query("type") || "click";
  const device = c.req.query("device");
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (!url) return c.json({ error: "url parameter required" }, 400);

  const match: Record<string, unknown> = {
    projectId: new mongoose.Types.ObjectId(projectId),
    url,
    type,
  };

  if (device && device !== "all") match.device = device;

  const dateFilter: Record<string, unknown> = {};
  if (from) dateFilter.$gte = new Date(from);
  if (to) dateFilter.$lte = new Date(to);
  if (Object.keys(dateFilter).length) match.timestamp = dateFilter;

  if (type === "scroll") {
    const BAND = 5;

    const sessionMaxDepths = await HeatmapEvent.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$sessionId",
          maxDepth: { $max: "$scrollDepth" },
        },
      },
    ]);

    const total = sessionMaxDepths.length || 1;
    const depths = sessionMaxDepths.map((s) => (s.maxDepth as number) ?? 0);

    const bands: Array<{ depth: number; count: number; reach: number; dropOff: number }> = [];
    let prevReach = 100;

    for (let d = 0; d <= 100; d += BAND) {
      const count = d === 0 ? total : depths.filter((md) => md >= d).length;
      const reach = Math.round((count / total) * 100);
      const dropOff = Math.max(prevReach - reach, 0);
      bands.push({ depth: d, count, reach, dropOff });
      prevReach = reach;
    }

    return c.json({ type: "scroll", total, bands });
  }

  const GRID = 100;

  const points = await HeatmapEvent.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          gx: { $floor: { $multiply: ["$x", GRID] } },
          gy: { $floor: { $multiply: ["$y", GRID] } },
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 5000 },
  ]);

  return c.json({
    type,
    points: points.map((p) => ({
      x: (p._id.gx + 0.5) / GRID,
      y: (p._id.gy + 0.5) / GRID,
      weight: p.count,
    })),
  });
});

export default heatmaps;
