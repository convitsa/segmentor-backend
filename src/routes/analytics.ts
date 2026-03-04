import { Hono } from "hono";
import mongoose from "mongoose";
import { requireAuth } from "../auth/middleware.js";
import { requireProjectOwnership } from "../lib/ownership.js";
import { CustomerEvent, Event, PageView, Session, Visitor } from "../db/models.js";

type Env = { Variables: { userId: string } };

const analytics = new Hono<Env>();

analytics.use("/*", requireAuth);

analytics.get("/projects/:projectId/analytics", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const rawDays = parseInt(c.req.query("days") || "7", 10);
  const days = Math.max(1, Math.min(isNaN(rawDays) ? 7 : rawDays, 90));
  const since = new Date();
  since.setDate(since.getDate() - days);

  const filterCountry = c.req.query("country") || "";
  const filterDevice = c.req.query("device") || "";
  const filterUrl = c.req.query("url") || "";
  const filterElement = c.req.query("elementId") || "";
  const filterRule = c.req.query("ruleId") || "";

  const prevSince = new Date(since);
  prevSince.setDate(prevSince.getDate() - days);

  const projectIdObj = new mongoose.Types.ObjectId(projectId);

  const matchConditions: Record<string, unknown>[] = [
    { projectId: projectIdObj },
    { timestamp: { $gte: since } },
    { type: "impression" },
  ];
  if (filterCountry) {
    const codes = filterCountry.split(",").map((s) => s.trim().toUpperCase());
    matchConditions.push({
      $or: [
        { countryCode: { $in: codes } },
        { country: { $in: codes } },
      ],
    });
  }
  if (filterDevice) {
    const devices = filterDevice.split(",").map((s) => s.trim().toLowerCase());
    matchConditions.push({
      $expr: { $in: [{ $toLower: { $ifNull: ["$device", ""] } }, devices] },
    });
  }
  if (filterUrl) {
    matchConditions.push({
      url: filterUrl === "/" ? { $in: ["/", null, ""] } : filterUrl,
    });
  }
  if (filterElement) matchConditions.push({ elementId: filterElement });
  if (filterRule) matchConditions.push({ ruleId: filterRule });

  const matchBase = matchConditions.length === 3
    ? Object.assign({}, ...matchConditions)
    : { $and: matchConditions };

  const pipeline: Record<string, unknown>[] = [{ $match: matchBase }];
  const facetStage: Record<string, unknown[]> = {
    byVariant: [
      { $group: { _id: "$variantId", count: { $sum: 1 }, visitors: { $addToSet: "$visitorId" } } },
    ],
    byDay: [
      { $addFields: { day: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } } } },
      { $group: { _id: "$day", count: { $sum: 1 }, visitors: { $addToSet: "$visitorId" } } },
    ],
    byElement: [
      { $group: { _id: "$elementId", count: { $sum: 1 } } },
    ],
    byCountry: [
      { $match: { country: { $exists: true, $ne: null, $ne: "" } } },
      { $group: {
        _id: { $ifNull: ["$countryCode", "$country"] },
        count: { $sum: 1 },
        visitors: { $addToSet: "$visitorId" },
        countryCode: { $last: { $ifNull: ["$countryCode", "$country"] } },
      } },
    ],
    byDevice: [
      { $match: { device: { $exists: true, $ne: null, $ne: "" } } },
      { $group: { _id: "$device", count: { $sum: 1 } } },
    ],
    byPage: [
      { $addFields: { pageUrl: { $ifNull: ["$url", "/"] } } },
      { $group: { _id: "$pageUrl", count: { $sum: 1 }, visitors: { $addToSet: "$visitorId" } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ],
    byRule: [
      { $match: { ruleId: { $exists: true, $ne: null, $ne: "" } } },
      { $group: { _id: "$ruleId", count: { $sum: 1 }, visitors: { $addToSet: "$visitorId" } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ],
    totals: [
      { $group: {
        _id: null,
        totalImpressions: { $sum: 1 },
        uniqueVisitors: { $addToSet: "$visitorId" },
      } },
    ],
  };
  pipeline.push({ $facet: facetStage });

  const filterOptionsMatch = {
    projectId: projectIdObj,
    timestamp: { $gte: since },
    type: "impression",
  };

  const [result, prevResult, filterOptionsResult] = await Promise.all([
    Event.aggregate(pipeline),
    Event.aggregate([
      { $match: {
        projectId: projectIdObj,
        timestamp: { $gte: prevSince, $lt: since },
        type: "impression",
      } },
      { $group: {
        _id: null,
        count: { $sum: 1 },
        visitors: { $addToSet: "$visitorId" },
      } },
    ]),
    Event.aggregate([
      { $match: filterOptionsMatch },
      { $facet: {
        countries: [
          { $group: { _id: { $ifNull: ["$countryCode", "$country"] } } },
          { $match: { _id: { $nin: [null, ""] } } },
        ],
        devices: [
          { $group: { _id: "$device" } },
          { $match: { _id: { $nin: [null, ""] } } },
        ],
        urls: [
          { $group: { _id: { $ifNull: ["$url", "/"] } } },
          { $match: { _id: { $nin: [null, ""] } } },
        ],
        elements: [
          { $group: { _id: "$elementId" } },
          { $match: { _id: { $nin: [null, ""] } } },
        ],
        rules: [
          { $group: { _id: "$ruleId" } },
          { $match: { _id: { $nin: [null, ""] } } },
        ],
      } },
    ]),
  ]);

  const data = result[0] as Record<string, unknown[]>;
  const totals = (data.totals as { totalImpressions: number; uniqueVisitors: string[] }[])?.[0];
  const totalImpressions = totals?.totalImpressions ?? 0;
  const uniqueVisitors = totals?.uniqueVisitors?.length ?? 0;

  const prev = prevResult[0] as { count: number; visitors: string[] } | undefined;
  const prevImpressions = prev?.count ?? 0;
  const prevUniqueVisitors = prev?.visitors?.length ?? 0;

  const variantStats = ((data.byVariant as { _id: string; count: number; visitors: string[] }[]) || []).map((v) => ({
    variantId: v._id,
    impressions: v.count,
    uniqueVisitors: v.visitors?.length ?? 0,
  }));

  const byDayRaw = (data.byDay as { _id: string; count: number; visitors: string[] }[]) || [];
  const dailyStats = byDayRaw
    .sort((a, b) => a._id.localeCompare(b._id))
    .map((d) => ({ date: d._id, impressions: d.count, visitors: d.visitors?.length ?? 0 }));

  const elementStats = ((data.byElement as { _id: string; count: number }[]) || []).map((e) => ({
    elementId: e._id,
    impressions: e.count,
  }));

  const byCountryRaw = (data.byCountry as { _id: string; count: number; visitors: string[]; countryCode: string }[]) || [];
  const countryStats = byCountryRaw
    .map((c) => ({
      countryCode: c.countryCode || c._id,
      country: c._id,
      impressions: c.count,
      uniqueVisitors: c.visitors?.length ?? 0,
    }))
    .sort((a, b) => b.impressions - a.impressions);

  const byDeviceRaw = (data.byDevice as { _id: string; count: number }[]) || [];
  const deviceStats = byDeviceRaw
    .map((d) => ({ device: d._id, impressions: d.count }))
    .sort((a, b) => b.impressions - a.impressions);

  const pageStats = ((data.byPage as { _id: string; count: number; visitors: string[] }[]) || []).map((p) => ({
    url: p._id,
    impressions: p.count,
    uniqueVisitors: p.visitors?.length ?? 0,
  }));

  const ruleStats = ((data.byRule as { _id: string; count: number; visitors: string[] }[]) || []).map((r) => ({
    ruleId: r._id,
    impressions: r.count,
    uniqueVisitors: r.visitors?.length ?? 0,
  }));

  const fo = filterOptionsResult[0] as Record<string, { _id: string }[]>;
  const availableCountries = (fo?.countries?.map((x) => x._id).filter(Boolean) ?? []).sort();
  const availableDevices = (fo?.devices?.map((x) => x._id).filter(Boolean) ?? []).sort();
  const availableUrls = (fo?.urls?.map((x) => x._id).filter(Boolean) ?? []).sort();
  const availableElements = (fo?.elements?.map((x) => x._id).filter(Boolean) ?? []).sort();
  const availableRules = (fo?.rules?.map((x) => x._id).filter(Boolean) ?? []).sort();

  const hasFilters = !!(filterCountry || filterDevice || filterUrl || filterElement || filterRule);

  return c.json({
    period: { days, since: since.toISOString() },
    totalImpressions,
    uniqueVisitors,
    previousPeriod: {
      totalImpressions: prevImpressions,
      uniqueVisitors: prevUniqueVisitors,
    },
    variantStats,
    dailyStats,
    elementStats,
    countryStats,
    deviceStats,
    pageStats,
    ruleStats,
    hasFilters,
    filterOptions: {
      countries: availableCountries,
      devices: availableDevices,
      urls: availableUrls,
      elements: availableElements,
      rules: availableRules,
    },
  });
});

// User-centric analytics overview (new journey-based metrics)
analytics.get("/projects/:projectId/analytics/overview", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const rawDays = parseInt(c.req.query("days") || "7", 10);
  const days = Math.max(1, Math.min(isNaN(rawDays) ? 7 : rawDays, 90));
  const since = new Date();
  since.setDate(since.getDate() - days);

  const prevSince = new Date(since);
  prevSince.setDate(prevSince.getDate() - days);

  const projectIdObj = new mongoose.Types.ObjectId(projectId);

  const visitorMatch = { projectId: projectIdObj, lastSeenAt: { $gte: since } };
  const prevVisitorMatch = { projectId: projectIdObj, lastSeenAt: { $gte: prevSince, $lt: since } };
  const sessionMatch = { projectId: projectIdObj, startedAt: { $gte: since } };
  const prevSessionMatch = { projectId: projectIdObj, startedAt: { $gte: prevSince, $lt: since } };
  const pageViewMatch = { projectId: projectIdObj, timestamp: { $gte: since } };
  const revenueMatch = { projectId: projectIdObj, timestamp: { $gte: since }, type: "purchase" };

  const [
    visitorAggResult,
    prevVisitorCount,
    sessionAggResult,
    prevSessionCount,
    pageViewAggResult,
    revenueResult,
    topPagesResult,
  ] = await Promise.all([
    Visitor.aggregate([
      { $match: visitorMatch },
      { $facet: {
        list: [
          { $project: { visitorId: 1, firstSeenAt: 1, totalRevenue: 1, countryCode: 1, country: 1, device: 1 } },
        ],
        countryStats: [
          { $group: {
            _id: { $ifNull: [{ $ifNull: ["$countryCode", "$country"] }, "Unknown"] },
            visitors: { $sum: 1 },
            revenue: { $sum: { $ifNull: ["$totalRevenue", 0] } },
          } },
          { $sort: { visitors: -1 } },
          { $limit: 20 },
        ],
        deviceStats: [
          { $group: {
            _id: { $ifNull: ["$device", "unknown"] },
            visitors: { $sum: 1 },
          } },
          { $sort: { visitors: -1 } },
        ],
        newVisitorCount: [
          { $match: { firstSeenAt: { $gte: since } } },
          { $count: "count" },
        ],
      } },
    ]),
    Visitor.countDocuments(prevVisitorMatch),
    Session.aggregate([
      { $match: sessionMatch },
      { $facet: {
        list: [
          { $project: { sessionId: 1, visitorId: 1, duration: 1, pageviews: 1, startedAt: 1 } },
        ],
        totals: [
          { $group: {
            _id: null,
            totalDuration: { $sum: { $ifNull: ["$duration", 0] } },
            count: { $sum: 1 },
            bounceCount: { $sum: { $cond: [{ $lte: [{ $ifNull: ["$pageviews", 0] }, 1] }, 1, 0] } },
          } },
        ],
      } },
    ]),
    Session.countDocuments(prevSessionMatch),
    PageView.aggregate([
      { $match: pageViewMatch },
      { $addFields: { day: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } } } },
      { $group: {
        _id: "$day",
        pageviews: { $sum: 1 },
        visitors: { $addToSet: "$visitorId" },
      } },
    ]),
    CustomerEvent.aggregate([
      { $match: revenueMatch },
      { $group: {
        _id: null,
        totalRevenue: { $sum: { $ifNull: ["$amount", 0] } },
        totalOrders: { $sum: 1 },
      } },
    ]),
    PageView.aggregate([
      { $match: pageViewMatch },
      { $group: { _id: "$url", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]),
  ]);

  const visitorData = visitorAggResult[0] as Record<string, unknown[]>;
  const visitors = (visitorData.list as { visitorId: string; firstSeenAt: Date; totalRevenue?: number; countryCode?: string; country?: string; device?: string }[]) || [];
  const totalVisitors = visitors.length;
  const prevTotalVisitors = prevVisitorCount;
  const newVisitorsData = visitorData.newVisitorCount as { count: number }[] | undefined;
  const newVisitors = newVisitorsData?.[0]?.count ?? 0;
  const returningVisitors = totalVisitors - newVisitors;

  const sessionData = sessionAggResult[0] as Record<string, unknown[]>;
  const sessions = (sessionData.list as { sessionId: string; visitorId: string; duration: number; pageviews: number; startedAt: Date }[]) || [];
  const sessionTotals = (sessionData.totals as { totalDuration: number; count: number; bounceCount: number }[])?.[0];
  const totalSessions = sessionTotals?.count ?? sessions.length;
  const prevTotalSessions = prevSessionCount;
  const totalPageviews = (pageViewAggResult as { _id: string; pageviews: number }[]).reduce((sum, d) => sum + d.pageviews, 0);
  const totalRevenue = (revenueResult[0] as { totalRevenue: number } | undefined)?.totalRevenue ?? 0;
  const totalOrders = (revenueResult[0] as { totalOrders: number } | undefined)?.totalOrders ?? 0;

  const avgSessionDuration = totalSessions > 0 && sessionTotals
    ? Math.round(sessionTotals.totalDuration / totalSessions)
    : 0;
  const bounceSessions = sessionTotals?.bounceCount ?? 0;
  const bounceRate = totalSessions > 0 ? Math.round((bounceSessions / totalSessions) * 100) : 0;

  const pageViewByDay = new Map((pageViewAggResult as { _id: string; pageviews: number; visitors: string[] }[]).map((d) => [d._id, d]));

  const visitorsWithFirstSeen = new Map(visitors.map((v) => [v.visitorId, v.firstSeenAt]));

  const byDay: Record<string, { visitors: number; newVisitors: number; sessions: number; pageviews: number }> = {};
  for (let d = 0; d < days; d++) {
    const date = new Date(since);
    date.setDate(date.getDate() + d);
    const key = date.toISOString().slice(0, 10);
    byDay[key] = { visitors: 0, newVisitors: 0, sessions: 0, pageviews: 0 };
  }

  for (const [day, pvData] of pageViewByDay) {
    if (byDay[day]) {
      byDay[day].pageviews = pvData.pageviews;
      byDay[day].visitors = pvData.visitors?.length ?? 0;
      for (const vid of pvData.visitors || []) {
        const firstSeen = visitorsWithFirstSeen.get(vid);
        if (firstSeen && new Date(firstSeen) >= since) {
          byDay[day].newVisitors++;
        }
      }
    }
  }

  for (const s of sessions) {
    const day = s.startedAt.toISOString().slice(0, 10);
    if (byDay[day]) byDay[day].sessions++;
  }

  const dailyStats = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      visitors: d.visitors,
      newVisitors: d.newVisitors,
      returningVisitors: d.visitors - d.newVisitors,
      sessions: d.sessions,
      pageviews: d.pageviews,
    }));

  const countryStats = ((visitorData.countryStats as { _id: string; visitors: number; revenue: number }[]) || [])
    .map((c) => ({ countryCode: c._id, visitors: c.visitors, revenue: c.revenue }));

  const deviceStats = ((visitorData.deviceStats as { _id: string; visitors: number }[]) || [])
    .map((d) => ({ device: d._id, visitors: d.visitors }));

  const pageStats = (topPagesResult as { _id: string; count: number }[]).map((p) => ({
    url: p._id,
    pageviews: p.count,
  }));

  return c.json({
    period: { days, since: since.toISOString() },
    totalVisitors,
    previousPeriod: { totalVisitors: prevTotalVisitors, totalSessions: prevTotalSessions },
    newVisitors,
    returningVisitors,
    totalSessions,
    totalPageviews,
    avgSessionDuration,
    bounceRate,
    totalRevenue,
    totalOrders,
    dailyStats,
    countryStats,
    deviceStats,
    pageStats,
  });
});

export default analytics;
