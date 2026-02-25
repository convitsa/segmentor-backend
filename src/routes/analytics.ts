import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { requireProjectOwnership } from "../lib/ownership.js";
import { prisma } from "../db/index.js";

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

  // Previous period for comparison
  const prevSince = new Date(since);
  prevSince.setDate(prevSince.getDate() - days);

  const [events, prevEvents] = await Promise.all([
    prisma.event.findMany({
      where: { projectId, timestamp: { gte: since } },
      select: {
        elementId: true,
        variantId: true,
        ruleId: true,
        type: true,
        visitorId: true,
        timestamp: true,
        url: true,
        country: true,
        countryCode: true,
        device: true,
      },
    }),
    prisma.event.findMany({
      where: { projectId, timestamp: { gte: prevSince, lt: since } },
      select: { type: true, visitorId: true },
    }),
  ]);

  let filtered = events.filter((e) => e.type === "impression");

  if (filterCountry) {
    const codes = filterCountry.split(",").map((s) => s.trim().toUpperCase());
    filtered = filtered.filter((e) => {
      const cc = (e.countryCode || e.country || "").toUpperCase();
      return codes.includes(cc);
    });
  }
  if (filterDevice) {
    const devices = filterDevice.split(",").map((s) => s.trim().toLowerCase());
    filtered = filtered.filter((e) => devices.includes((e.device || "").toLowerCase()));
  }
  if (filterUrl) {
    filtered = filtered.filter((e) => (e.url || "/") === filterUrl);
  }
  if (filterElement) {
    filtered = filtered.filter((e) => e.elementId === filterElement);
  }
  if (filterRule) {
    filtered = filtered.filter((e) => e.ruleId === filterRule);
  }

  const impressions = filtered;
  const totalImpressions = impressions.length;
  const uniqueVisitors = new Set(impressions.map((e) => e.visitorId)).size;

  const prevImpressions = prevEvents.filter((e) => e.type === "impression").length;
  const prevUniqueVisitors = new Set(prevEvents.map((e) => e.visitorId)).size;

  const allImpressions = events.filter((e) => e.type === "impression");
  const availableCountries = [...new Set(allImpressions.map((e) => e.countryCode || e.country).filter(Boolean))].sort();
  const availableDevices = [...new Set(allImpressions.map((e) => e.device).filter(Boolean))].sort();
  const availableUrls = [...new Set(allImpressions.map((e) => e.url || "/"))].sort();
  const availableElements = [...new Set(allImpressions.map((e) => e.elementId).filter(Boolean))].sort();
  const availableRules = [...new Set(allImpressions.map((e) => e.ruleId).filter(Boolean))].sort();

  const byVariant: Record<string, { impressions: number; visitors: Set<string> }> = {};
  const byDay: Record<string, { impressions: number; visitors: Set<string> }> = {};
  const byElement: Record<string, number> = {};
  const byCountry: Record<string, { impressions: number; visitors: Set<string>; countryCode: string }> = {};
  const byDevice: Record<string, number> = {};
  const byPage: Record<string, { impressions: number; visitors: Set<string> }> = {};
  const byRule: Record<string, { impressions: number; visitors: Set<string> }> = {};

  for (const e of impressions) {
    // Variant
    if (!byVariant[e.variantId]) byVariant[e.variantId] = { impressions: 0, visitors: new Set() };
    byVariant[e.variantId].impressions++;
    byVariant[e.variantId].visitors.add(e.visitorId);

    // Daily (impressions + visitors)
    const day = e.timestamp.toISOString().slice(0, 10);
    if (!byDay[day]) byDay[day] = { impressions: 0, visitors: new Set() };
    byDay[day].impressions++;
    byDay[day].visitors.add(e.visitorId);

    // Element
    byElement[e.elementId] = (byElement[e.elementId] || 0) + 1;

    // Country
    if (e.country) {
      const cc = e.countryCode || e.country;
      if (!byCountry[cc]) byCountry[cc] = { impressions: 0, visitors: new Set(), countryCode: cc };
      byCountry[cc].impressions++;
      byCountry[cc].visitors.add(e.visitorId);
      if (e.country.length > 2) byCountry[cc].countryCode = e.countryCode || cc;
    }

    // Device
    if (e.device) byDevice[e.device] = (byDevice[e.device] || 0) + 1;

    // Page URL
    const pageUrl = e.url || "/";
    if (!byPage[pageUrl]) byPage[pageUrl] = { impressions: 0, visitors: new Set() };
    byPage[pageUrl].impressions++;
    byPage[pageUrl].visitors.add(e.visitorId);

    // Rule
    if (e.ruleId) {
      if (!byRule[e.ruleId]) byRule[e.ruleId] = { impressions: 0, visitors: new Set() };
      byRule[e.ruleId].impressions++;
      byRule[e.ruleId].visitors.add(e.visitorId);
    }
  }

  const variantStats = Object.entries(byVariant).map(([variantId, d]) => ({
    variantId,
    impressions: d.impressions,
    uniqueVisitors: d.visitors.size,
  }));

  const dailyStats = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, impressions: d.impressions, visitors: d.visitors.size }));

  const elementStats = Object.entries(byElement).map(([elementId, imp]) => ({
    elementId,
    impressions: imp,
  }));

  const countryStats = Object.entries(byCountry)
    .map(([code, d]) => ({
      countryCode: d.countryCode || code,
      country: code.length > 2 ? code : code,
      impressions: d.impressions,
      uniqueVisitors: d.visitors.size,
    }))
    .sort((a, b) => b.impressions - a.impressions);

  const deviceStats = Object.entries(byDevice)
    .map(([device, imp]) => ({ device, impressions: imp }))
    .sort((a, b) => b.impressions - a.impressions);

  const pageStats = Object.entries(byPage)
    .map(([url, d]) => ({ url, impressions: d.impressions, uniqueVisitors: d.visitors.size }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 20);

  const ruleStats = Object.entries(byRule)
    .map(([ruleId, d]) => ({ ruleId, impressions: d.impressions, uniqueVisitors: d.visitors.size }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 20);

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

export default analytics;
