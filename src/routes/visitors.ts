import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { requireProjectOwnership } from "../lib/ownership.js";
import { prisma } from "../db/index.js";

type Env = { Variables: { userId: string } };

const visitors = new Hono<Env>();

visitors.use("/*", requireAuth);

// Paginated visitors list with search/filter/sort
visitors.get("/projects/:projectId/visitors", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));
  const skip = (page - 1) * limit;

  const search = c.req.query("search") || "";
  const filterCountry = c.req.query("country") || "";
  const filterDevice = c.req.query("device") || "";
  const filterIdentified = c.req.query("identified"); // "true" | "false"
  const filterHasRevenue = c.req.query("hasRevenue"); // "true"
  const sortBy = c.req.query("sortBy") || "lastSeenAt";
  const sortOrder = c.req.query("sortOrder") === "asc" ? "asc" : "desc";

  const where: Record<string, unknown> = { projectId };

  if (search) {
    where.OR = [
      { email: { contains: search, mode: "insensitive" } },
      { visitorId: { contains: search } },
      { city: { contains: search, mode: "insensitive" } },
    ];
  }
  if (filterCountry) {
    where.countryCode = filterCountry.toUpperCase();
  }
  if (filterDevice) {
    where.device = filterDevice.toLowerCase();
  }
  if (filterIdentified === "true") {
    where.email = { not: null };
  } else if (filterIdentified === "false") {
    where.email = null;
  }
  if (filterHasRevenue === "true") {
    where.totalRevenue = { gt: 0 };
  }

  const allowedSorts = ["lastSeenAt", "firstSeenAt", "totalPageviews", "totalSessions", "totalRevenue", "totalEvents"];
  const orderField = allowedSorts.includes(sortBy) ? sortBy : "lastSeenAt";

  const [items, total] = await Promise.all([
    prisma.visitor.findMany({
      where: where as any,
      orderBy: { [orderField]: sortOrder },
      skip,
      take: limit,
    }),
    prisma.visitor.count({ where: where as any }),
  ]);

  return c.json({
    visitors: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// Visitor detail
visitors.get("/projects/:projectId/visitors/:visitorId", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const visitorId = c.req.param("visitorId");
  await requireProjectOwnership(projectId, userId);

  const visitor = await prisma.visitor.findUnique({
    where: { projectId_visitorId: { projectId, visitorId } },
  });

  if (!visitor) return c.json({ error: "Visitor not found" }, 404);

  const recentSessions = await prisma.session.findMany({
    where: { projectId, visitorId },
    orderBy: { startedAt: "desc" },
    take: 10,
  });

  const purchases = await prisma.customerEvent.findMany({
    where: { projectId, visitorId },
    orderBy: { timestamp: "desc" },
    take: 20,
  });

  return c.json({ visitor, recentSessions, purchases });
});

// Visitor timeline (all event types merged chronologically)
visitors.get("/projects/:projectId/visitors/:visitorId/timeline", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const visitorId = c.req.param("visitorId");
  await requireProjectOwnership(projectId, userId);

  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));
  const skip = (page - 1) * limit;

  const [pageviews, trackEvents, impressions, customerEvents] = await Promise.all([
    prisma.pageView.findMany({
      where: { projectId, visitorId },
      orderBy: { timestamp: "desc" },
    }),
    prisma.trackEvent.findMany({
      where: { projectId, visitorId },
      orderBy: { timestamp: "desc" },
    }),
    prisma.event.findMany({
      where: { projectId, visitorId },
      orderBy: { timestamp: "desc" },
    }),
    prisma.customerEvent.findMany({
      where: { projectId, visitorId },
      orderBy: { timestamp: "desc" },
    }),
  ]);

  type TimelineEntry = {
    kind: string;
    timestamp: Date;
    data: Record<string, unknown>;
  };

  const timeline: TimelineEntry[] = [];

  for (const pv of pageviews) {
    timeline.push({
      kind: "pageview",
      timestamp: pv.timestamp,
      data: {
        url: pv.url, title: pv.title,
        duration: pv.duration, scrollDepth: pv.scrollDepth,
        sessionId: pv.sessionId,
      },
    });
  }
  for (const te of trackEvents) {
    timeline.push({
      kind: te.name,
      timestamp: te.timestamp,
      data: {
        properties: te.properties, url: te.url,
        sessionId: te.sessionId,
      },
    });
  }
  for (const imp of impressions) {
    timeline.push({
      kind: "impression",
      timestamp: imp.timestamp,
      data: {
        elementId: imp.elementId, variantId: imp.variantId,
        ruleId: imp.ruleId, url: imp.url,
      },
    });
  }
  for (const ce of customerEvents) {
    timeline.push({
      kind: "purchase",
      timestamp: ce.timestamp,
      data: {
        type: ce.type, amount: ce.amount, currency: ce.currency,
        productName: ce.productName, provider: ce.provider,
        externalId: ce.externalId,
      },
    });
  }

  timeline.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  const paginated = timeline.slice(skip, skip + limit);

  return c.json({
    timeline: paginated,
    pagination: { page, limit, total: timeline.length, totalPages: Math.ceil(timeline.length / limit) },
  });
});

// Sessions for a visitor
visitors.get("/projects/:projectId/visitors/:visitorId/sessions", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const visitorId = c.req.param("visitorId");
  await requireProjectOwnership(projectId, userId);

  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
  const skip = (page - 1) * limit;

  const [sessions, total] = await Promise.all([
    prisma.session.findMany({
      where: { projectId, visitorId },
      orderBy: { startedAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.session.count({ where: { projectId, visitorId } }),
  ]);

  return c.json({
    sessions,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// All sessions for project
visitors.get("/projects/:projectId/sessions", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));
  const skip = (page - 1) * limit;

  const [sessions, total] = await Promise.all([
    prisma.session.findMany({
      where: { projectId },
      orderBy: { startedAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.session.count({ where: { projectId } }),
  ]);

  return c.json({
    sessions,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// Live visitors (active within last 5 minutes)
visitors.get("/projects/:projectId/live", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

  const [activeVisitors, recentPageviews] = await Promise.all([
    prisma.visitor.findMany({
      where: { projectId, lastSeenAt: { gte: fiveMinAgo } },
      orderBy: { lastSeenAt: "desc" },
      take: 100,
    }),
    prisma.pageView.findMany({
      where: { projectId, timestamp: { gte: fiveMinAgo } },
      orderBy: { timestamp: "desc" },
      take: 50,
    }),
  ]);

  return c.json({
    count: activeVisitors.length,
    visitors: activeVisitors,
    recentPageviews,
  });
});

export default visitors;
