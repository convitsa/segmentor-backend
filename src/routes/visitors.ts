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
  const filterBrowser = c.req.query("browser") || "";
  const filterOs = c.req.query("os") || "";
  const filterLanguage = c.req.query("language") || "";
  const filterIdentified = c.req.query("identified"); // "true" | "false"
  const filterHasRevenue = c.req.query("hasRevenue"); // "true"
  const filterLive = c.req.query("live"); // "true"
  const filterUtmSource = c.req.query("utmSource") || "";
  const filterUtmMedium = c.req.query("utmMedium") || "";
  const filterUtmCampaign = c.req.query("utmCampaign") || "";
  const filterReferrer = c.req.query("referrer") || "";
  const filterTag = c.req.query("tag") || "";
  const filterSeenAfter = c.req.query("seenAfter") || "";
  const filterSeenBefore = c.req.query("seenBefore") || "";
  const sortBy = c.req.query("sortBy") || "lastSeenAt";
  const sortOrder = c.req.query("sortOrder") === "asc" ? "asc" : "desc";

  const where: Record<string, unknown> = { projectId };

  if (search) {
    where.OR = [
      { email: { contains: search, mode: "insensitive" } },
      { visitorId: { contains: search } },
      { city: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } },
    ];
  }
  if (filterCountry) {
    where.countryCode = filterCountry.toUpperCase();
  }
  if (filterDevice) {
    where.device = filterDevice.toLowerCase();
  }
  if (filterBrowser) {
    where.browser = { contains: filterBrowser, mode: "insensitive" };
  }
  if (filterOs) {
    where.os = { contains: filterOs, mode: "insensitive" };
  }
  if (filterLanguage) {
    where.language = { contains: filterLanguage, mode: "insensitive" };
  }
  if (filterIdentified === "true") {
    where.email = { not: null };
  } else if (filterIdentified === "false") {
    where.email = null;
  }
  if (filterHasRevenue === "true") {
    where.totalRevenue = { gt: 0 };
  }
  if (filterLive === "true") {
    where.lastSeenAt = { gte: new Date(Date.now() - 5 * 60 * 1000) };
  }
  if (filterUtmSource) {
    where.firstUtmSource = { contains: filterUtmSource, mode: "insensitive" };
  }
  if (filterUtmMedium) {
    where.firstUtmMedium = { contains: filterUtmMedium, mode: "insensitive" };
  }
  if (filterUtmCampaign) {
    where.firstUtmCampaign = { contains: filterUtmCampaign, mode: "insensitive" };
  }
  if (filterReferrer) {
    where.firstReferrer = { contains: filterReferrer, mode: "insensitive" };
  }
  if (filterTag) {
    where.tags = { has: filterTag };
  }
  if (filterSeenAfter || filterSeenBefore) {
    const lastSeenFilter: Record<string, Date> = {};
    if (filterSeenAfter) lastSeenFilter.gte = new Date(filterSeenAfter);
    if (filterSeenBefore) lastSeenFilter.lte = new Date(filterSeenBefore);
    if (!where.lastSeenAt) where.lastSeenAt = lastSeenFilter;
  }

  const allowedSorts = ["lastSeenAt", "firstSeenAt", "totalPageviews", "totalSessions", "totalRevenue", "totalEvents", "email"];
  const orderField = allowedSorts.includes(sortBy) ? sortBy : "lastSeenAt";

  const projectWhere = { projectId };

  const [items, total, aggregates] = await Promise.all([
    prisma.visitor.findMany({
      where: where as any,
      orderBy: { [orderField]: sortOrder },
      skip,
      take: limit,
    }),
    prisma.visitor.count({ where: where as any }),
    prisma.visitor.aggregate({
      where: projectWhere,
      _sum: { totalRevenue: true },
      _count: { _all: true },
    }),
  ]);

  const [identifiedCount, paidCount] = await Promise.all([
    prisma.visitor.count({ where: { projectId, email: { not: null } } }),
    prisma.visitor.count({ where: { projectId, totalRevenue: { gt: 0 } } }),
  ]);

  return c.json({
    visitors: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
    stats: {
      totalVisitors: aggregates._count._all,
      identifiedVisitors: identifiedCount,
      paidVisitors: paidCount,
      totalRevenue: aggregates._sum.totalRevenue ?? 0,
    },
  });
});

// Distinct filter values for populating dropdowns
visitors.get("/projects/:projectId/visitors/filters", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const all = await prisma.visitor.findMany({
    where: { projectId },
    select: {
      countryCode: true,
      country: true,
      language: true,
      browser: true,
      os: true,
      device: true,
      firstReferrer: true,
      firstUtmSource: true,
      firstUtmMedium: true,
      firstUtmCampaign: true,
      tags: true,
    },
  });

  function distinct(arr: (string | null | undefined)[]): string[] {
    return [...new Set(arr.filter((v): v is string => !!v))].sort();
  }

  return c.json({
    countries: distinct(all.map((v) => v.countryCode ? `${v.countryCode}|${v.country || v.countryCode}` : null)),
    languages: distinct(all.map((v) => v.language)),
    browsers: distinct(all.map((v) => v.browser)),
    os: distinct(all.map((v) => v.os)),
    devices: distinct(all.map((v) => v.device)),
    referrers: distinct(all.map((v) => v.firstReferrer)),
    utmSources: distinct(all.map((v) => v.firstUtmSource)),
    utmMediums: distinct(all.map((v) => v.firstUtmMedium)),
    utmCampaigns: distinct(all.map((v) => v.firstUtmCampaign)),
    tags: distinct(all.flatMap((v) => v.tags)),
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

export default visitors;
