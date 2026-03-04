import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireAuth } from "../auth/middleware.js";
import { requireProjectOwnership } from "../lib/ownership.js";
import mongoose from "mongoose";
import {
  Visitor,
  Session,
  PageView,
  TrackEvent,
  SegiConversation,
  SegiMessage,
  SessionRecording,
} from "../db/models.js";
import { AzureOpenAI } from "openai";
import { distance } from "fastest-levenshtein";
import ExcelJS from "exceljs";
import { friendlyName } from "../lib/friendly-name.js";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

const MAX_TOOL_ITERATIONS = 5;

type Env = { Variables: { userId: string } };

const segi = new Hono<Env>();
segi.use("/*", requireAuth);

function getOpenAIClient(): AzureOpenAI | null {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (!endpoint || !apiKey) return null;
  return new AzureOpenAI({ endpoint, apiKey, apiVersion: "2024-08-01-preview" });
}

// ─── Tool Definitions ───────────────────────────────────────────────

const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "filter_visitors",
      description: "Apply filters to the visitor list and return matching visitor count. Use this when the user wants to find or see specific visitors based on criteria like device, country, browser, behavior (clicks, page views), time ranges, etc.",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "Device type: desktop, mobile, tablet" },
          browser: { type: "string", description: "Browser name: Chrome, Safari, Firefox, Edge, Opera" },
          os: { type: "string", description: "OS name: Windows, macOS, Linux, Android, iOS" },
          country: { type: "string", description: "2-letter country code (e.g. US, DE, GB)" },
          language: { type: "string", description: "Language code" },
          identified: { type: "string", enum: ["true", "false"], description: "Whether visitor has email (identified)" },
          hasRevenue: { type: "string", enum: ["true"], description: "Only visitors with revenue > 0" },
          live: { type: "string", enum: ["true"], description: "Only visitors seen in last 5 minutes" },
          utmSource: { type: "string" },
          utmMedium: { type: "string" },
          utmCampaign: { type: "string" },
          referrer: { type: "string" },
          tag: { type: "string" },
          seenAfter: { type: "string", description: "ISO date (YYYY-MM-DD)" },
          seenBefore: { type: "string", description: "ISO date (YYYY-MM-DD)" },
          search: { type: "string", description: "Free text search across name, email, city" },
          sortBy: { type: "string", enum: ["lastSeenAt", "firstSeenAt", "totalPageviews", "totalSessions", "totalRevenue", "totalEvents"] },
          sortOrder: { type: "string", enum: ["asc", "desc"] },
          events: {
            type: "array",
            description: "Behavioral event conditions. ALL must be satisfied (AND logic).",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["click", "form_submit", "pageview", "custom"], description: "Event type" },
                label: { type: "string", description: "Button/link text for clicks, form ID for form_submit" },
                name: { type: "string", description: "Custom event name" },
                url: { type: "string", description: "Page URL for pageview events" },
              },
              required: ["type"],
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_visitor_stats",
      description: "Get aggregate statistics about visitors. Use when the user asks questions like 'how many mobile visitors do I have?', 'what is the most popular browser?', 'what countries are my visitors from?'",
      parameters: {
        type: "object",
        properties: {
          groupBy: {
            type: "string",
            enum: ["device", "browser", "os", "country", "language", "identified", "hasRevenue"],
            description: "Field to group statistics by",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "export_visitors",
      description: "Export filtered visitor data to a downloadable file. Use when the user asks to export, download, or save visitor data.",
      parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["csv", "json", "xlsx"],
            description: "Export file format",
          },
          filters: {
            type: "object",
            description: "Optional filters to apply before export (same as filter_visitors params)",
            properties: {
              device: { type: "string" },
              browser: { type: "string" },
              country: { type: "string" },
              identified: { type: "string" },
              hasRevenue: { type: "string" },
            },
            additionalProperties: true,
          },
        },
        required: ["format"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_filters",
      description: "Clear/reset all currently applied visitor filters and show all visitors. Use when the user asks to clear filters, reset filters, show all visitors, or remove the current filter.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_visitor_details",
      description: "Get detailed information about a specific visitor by their name (e.g. 'keen rabbit', 'vivid toucan') or email. Returns their full profile, recent page views, and tracked events. Use when the user asks about a specific visitor.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Visitor name or email to look up (case-insensitive fuzzy match)" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_recordings",
      description: "Search session recordings by visitor, page, clicked element, sentiment, or friction. Use when the user asks about recorded sessions, visitor behavior patterns, what visitors did on the site, click journeys, or friction points.",
      parameters: {
        type: "object",
        properties: {
          visitorId: { type: "string", description: "Filter by visitor ID or name" },
          page: { type: "string", description: "Filter by page URL visited" },
          clickedElement: { type: "string", description: "Filter recordings where visitor clicked element with this text" },
          notClickedElement: { type: "string", description: "Exclude recordings where visitor clicked this element text" },
          sentiment: { type: "string", enum: ["positive", "neutral", "frustrated"], description: "Filter by session sentiment" },
          hasFriction: { type: "string", enum: ["true"], description: "Only recordings with friction points" },
          country: { type: "string", description: "2-letter country code" },
          device: { type: "string", description: "Device type: desktop, mobile, tablet" },
          utmSource: { type: "string", description: "UTM source" },
          referrer: { type: "string", description: "Referrer URL" },
          dateFrom: { type: "string", description: "Start date (YYYY-MM-DD)" },
          dateTo: { type: "string", description: "End date (YYYY-MM-DD)" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_behavior_patterns",
      description: "Analyze behavior patterns across multiple session recordings. Use when the user asks questions like 'which users clicked X but didn't Y', 'why are users from country X not converting', 'what's the common behavior pattern'. Returns AI-powered analysis with insights and suggestions.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The behavior analysis question to answer" },
          country: { type: "string", description: "Filter recordings by country code" },
          device: { type: "string", description: "Filter by device type" },
          utmSource: { type: "string", description: "Filter by UTM source" },
          referrer: { type: "string", description: "Filter by referrer" },
          clickedElement: { type: "string", description: "Only recordings where this element was clicked" },
          notClickedElement: { type: "string", description: "Exclude recordings where this was clicked" },
          page: { type: "string", description: "Only recordings that visited this page" },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
];

// ─── Tool Executors ─────────────────────────────────────────────────

function fuzzyMatch(query: string, candidates: string[]): string | null {
  if (!query || !candidates.length) return null;
  const lower = query.toLowerCase();
  const exact = candidates.find((c) => c.toLowerCase() === lower);
  if (exact) return exact;
  const contains = candidates.find((c) => c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase()));
  if (contains) return contains;
  let best = candidates[0];
  let bestDist = distance(lower, best.toLowerCase());
  for (const c of candidates.slice(1)) {
    const d = distance(lower, c.toLowerCase());
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return bestDist <= Math.max(3, query.length * 0.4) ? best : null;
}

async function executeFilterVisitors(projectId: string, args: any, clickLabels: string[], formIds: string[]) {
  const filters: Record<string, string> = {};
  for (const key of ["device", "browser", "os", "country", "language", "identified", "hasRevenue", "live", "utmSource", "utmMedium", "utmCampaign", "referrer", "tag", "seenAfter", "seenBefore", "search", "sortBy", "sortOrder"]) {
    if (args[key]) filters[key] = args[key];
  }

  let visitorIds: string[] | undefined;

  if (args.events?.length) {
    console.log("[Segi] LLM events:", JSON.stringify(args.events));
    const idSets: Set<string>[] = [];

    for (const evt of args.events) {
      let ids: string[] = [];

      if (evt.type === "pageview" && evt.url) {
        ids = await PageView.distinct("visitorId", {
          projectId,
          url: { $regex: evt.url, $options: "i" },
        });
      } else if ((evt.type === "click" || evt.type === "form_submit") && evt.label?.trim()) {
        const resolved = evt.type === "click"
          ? fuzzyMatch(evt.label, clickLabels)
          : fuzzyMatch(evt.label, formIds);
        console.log(`[Segi] ${evt.type} label="${evt.label}" -> resolved="${resolved}"`);

        const resolvedLabel = resolved || evt.label;
        if (!resolvedLabel?.trim()) continue;

        const allOfType = await TrackEvent.find({ projectId, name: evt.type })
          .select("visitorId properties")
          .lean();
        const labelLower = resolvedLabel.toLowerCase();
        const matched = allOfType.filter((m: any) => {
          const text = (m.properties as any)?.text;
          return text && String(text).toLowerCase().includes(labelLower);
        });
        ids = [...new Set(matched.map((m: any) => m.visitorId))];
      } else if (evt.name) {
        ids = await TrackEvent.distinct("visitorId", {
          projectId,
          name: { $regex: evt.name, $options: "i" },
        });
      } else {
        continue;
      }

      idSets.push(new Set(ids));
    }

    if (idSets.length > 0) {
      const intersection = idSets.reduce((acc, set) =>
        new Set([...acc].filter((id) => set.has(id)))
      );
      visitorIds = [...intersection];
    }
  }

  const where: Record<string, unknown> = { projectId };
  if (filters.device) where.device = filters.device.toLowerCase();
  if (filters.browser) where.browser = { $regex: filters.browser, $options: "i" };
  if (filters.os) where.os = { $regex: filters.os, $options: "i" };
  if (filters.country) where.countryCode = filters.country.toUpperCase();
  if (filters.identified === "true") where.email = { $ne: null };
  else if (filters.identified === "false") where.email = null;
  if (filters.hasRevenue === "true") where.totalRevenue = { $gt: 0 };
  if (filters.live === "true") where.lastSeenAt = { $gte: new Date(Date.now() - 5 * 60 * 1000) };
  if (filters.search) {
    where.$or = [
      { name: { $regex: filters.search, $options: "i" } },
      { email: { $regex: filters.search, $options: "i" } },
      { city: { $regex: filters.search, $options: "i" } },
    ];
  }
  if (filters.seenAfter) {
    const lastSeen = (where.lastSeenAt as Record<string, Date>) || {};
    where.lastSeenAt = { ...lastSeen, $gte: new Date(filters.seenAfter) };
  }
  if (filters.seenBefore) {
    const lastSeen = (where.lastSeenAt as Record<string, Date>) || {};
    where.lastSeenAt = { ...lastSeen, $lte: new Date(filters.seenBefore) };
  }
  if (filters.utmSource) where.firstUtmSource = { $regex: filters.utmSource, $options: "i" };
  if (filters.utmMedium) where.firstUtmMedium = { $regex: filters.utmMedium, $options: "i" };
  if (filters.utmCampaign) where.firstUtmCampaign = { $regex: filters.utmCampaign, $options: "i" };
  if (filters.referrer) where.firstReferrer = { $regex: filters.referrer, $options: "i" };
  if (filters.tag) where.tags = filters.tag;
  if (visitorIds) where.visitorId = { $in: visitorIds };

  const count = await Visitor.countDocuments(where);

  return {
    matchedCount: count,
    filters,
    visitorIds: visitorIds || [],
    summary: `Found ${count} visitor${count !== 1 ? "s" : ""} matching the criteria`,
  };
}

async function executeQueryStats(projectId: string, args: any) {
  const groupBy = args.groupBy;

  const [totalCount, identifiedCount, paidCount, aggResult] = await Promise.all([
    Visitor.countDocuments({ projectId }),
    Visitor.countDocuments({ projectId, email: { $ne: null } }),
    Visitor.countDocuments({ projectId, totalRevenue: { $gt: 0 } }),
    Visitor.aggregate([
      { $match: { projectId: new mongoose.Types.ObjectId(projectId) } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$totalRevenue" },
          totalPageviews: { $sum: "$totalPageviews" },
          totalSessions: { $sum: "$totalSessions" },
          totalEvents: { $sum: "$totalEvents" },
          avgPageviews: { $avg: "$totalPageviews" },
          avgSessions: { $avg: "$totalSessions" },
        },
      },
    ]),
  ]);

  const agg = aggResult[0] || {};
  const result: any = {
    totalVisitors: totalCount,
    identifiedVisitors: identifiedCount,
    paidCustomers: paidCount,
    totalRevenue: agg.totalRevenue || 0,
    totalPageviews: agg.totalPageviews || 0,
    totalSessions: agg.totalSessions || 0,
    avgPageviewsPerVisitor: Math.round((agg.avgPageviews || 0) * 10) / 10,
    avgSessionsPerVisitor: Math.round((agg.avgSessions || 0) * 10) / 10,
  };

  if (groupBy) {
    const fieldMap: Record<string, string> = {
      device: "device", browser: "browser", os: "os",
      country: "countryCode", language: "language",
    };

    if (fieldMap[groupBy]) {
      const groups = await Visitor.aggregate([
        { $match: { projectId: new mongoose.Types.ObjectId(projectId) } },
        { $group: { _id: `$${fieldMap[groupBy]}`, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]);
      result.breakdown = groups.map((g: any) => {
        const name = g._id ?? "unknown";
        const count = g.count;
        return { name, count, percentage: Math.round((count / totalCount) * 1000) / 10 };
      });
    } else if (groupBy === "identified") {
      const identCount = identifiedCount;
      const anonCount = totalCount - identCount;
      result.breakdown = [
        { name: "identified", count: identCount, percentage: Math.round((identCount / totalCount) * 1000) / 10 },
        { name: "anonymous", count: anonCount, percentage: Math.round((anonCount / totalCount) * 1000) / 10 },
      ].filter((b) => b.count > 0);
    } else if (groupBy === "hasRevenue") {
      const freeCount = totalCount - paidCount;
      result.breakdown = [
        { name: "paid", count: paidCount, percentage: Math.round((paidCount / totalCount) * 1000) / 10 },
        { name: "free", count: freeCount, percentage: Math.round((freeCount / totalCount) * 1000) / 10 },
      ].filter((b) => b.count > 0);
    }
  }

  return result;
}

async function executeExportVisitors(projectId: string, args: any) {
  const format = args.format || "csv";
  const where: Record<string, unknown> = { projectId };
  const filters = args.filters || {};

  if (filters.device) where.device = filters.device.toLowerCase();
  if (filters.browser) where.browser = { $regex: filters.browser, $options: "i" };
  if (filters.country) where.countryCode = filters.country.toUpperCase();
  if (filters.identified === "true") where.email = { $ne: null };
  if (filters.hasRevenue === "true") where.totalRevenue = { $gt: 0 };

  const recordCount = await Visitor.countDocuments(where);
  const filename = `visitors-${recordCount}-${format.toUpperCase()}.${format}`;

  return {
    format,
    filters,
    recordCount,
    filename,
    summary: `Ready to export ${recordCount} visitors as ${format.toUpperCase()}`,
  };
}

async function executeGetVisitorDetails(projectId: string, args: any) {
  const query = (args.name || "").trim();
  if (!query) return { error: "No name provided" };

  const visitor = await Visitor.findOne({
    projectId,
    $or: [
      { name: { $regex: query, $options: "i" } },
      { email: { $regex: query, $options: "i" } },
    ],
  }).lean();

  if (!visitor) {
    return { error: `No visitor found matching "${query}"` };
  }

  const v = visitor as any;
  const [recentPages, recentEvents, sessions] = await Promise.all([
    PageView.find({ projectId, visitorId: v.visitorId })
      .sort({ timestamp: -1 })
      .limit(20)
      .select("url title timestamp duration")
      .lean(),
    TrackEvent.find({ projectId, visitorId: v.visitorId })
      .sort({ timestamp: -1 })
      .limit(20)
      .select("name properties url timestamp")
      .lean(),
    Session.find({ projectId, visitorId: v.visitorId })
      .sort({ startedAt: -1 })
      .limit(10)
      .select("entryPage exitPage pageviews events duration startedAt referrer utmSource")
      .lean(),
  ]);

  return {
    visitor: {
      visitorId: v.visitorId,
      name: v.name,
      isRandomName: v.isRandomName,
      email: v.email,
      country: v.country,
      countryCode: v.countryCode,
      city: v.city,
      region: v.region,
      device: v.device,
      browser: v.browser,
      os: v.os,
      language: v.language,
      totalPageviews: v.totalPageviews,
      totalSessions: v.totalSessions,
      totalEvents: v.totalEvents,
      totalRevenue: v.totalRevenue,
      tags: v.tags,
      firstSeenAt: v.firstSeenAt,
      lastSeenAt: v.lastSeenAt,
      firstReferrer: v.firstReferrer,
      firstUtmSource: v.firstUtmSource,
      firstUtmMedium: v.firstUtmMedium,
      firstUtmCampaign: v.firstUtmCampaign,
    },
    recentPages: recentPages.map((p: any) => ({
      url: p.url, title: p.title, timestamp: p.timestamp, duration: p.duration,
    })),
    recentEvents: recentEvents.map((e: any) => ({
      name: e.name,
      label: e.name === "click" ? (e.properties as any)?.text : e.name === "form_submit" ? (e.properties as any)?.formId : e.name,
      url: e.url,
      timestamp: e.timestamp,
    })),
    sessions: sessions.map((s: any) => ({
      entryPage: s.entryPage, exitPage: s.exitPage,
      pageviews: s.pageviews, events: s.events,
      duration: s.duration, startedAt: s.startedAt,
      referrer: s.referrer, utmSource: s.utmSource,
    })),
    summary: `${v.name || v.email || v.visitorId}: ${v.totalPageviews} pages, ${v.totalSessions} sessions, ${v.totalEvents} events${v.totalRevenue ? `, $${(v.totalRevenue / 100).toFixed(2)} revenue` : ""}. From ${v.city || v.country || "unknown location"}, using ${v.device || "unknown"} ${v.browser || ""}`,
  };
}

async function executeSearchRecordings(projectId: string, args: any) {
  const where: Record<string, unknown> = { projectId, status: "analyzed" };

  if (args.sentiment) where.sentiment = args.sentiment;
  if (args.page) where.pagesVisited = args.page;
  if (args.dateFrom || args.dateTo) {
    const startedAt: Record<string, Date> = {};
    if (args.dateFrom) startedAt.$gte = new Date(args.dateFrom);
    if (args.dateTo) startedAt.$lte = new Date(args.dateTo);
    where.startedAt = startedAt;
  }

  let recordings = await SessionRecording.find(where)
    .sort({ startedAt: -1 })
    .limit(200)
    .select("visitorId sessionId duration pagesVisited summary sentiment journeySteps clickPoints frictionPoints startedAt")
    .lean();

  if (args.clickedElement) {
    const searchText = args.clickedElement.toLowerCase();
    recordings = recordings.filter((r) => {
      const clicks = (r.clickPoints as any[]) || [];
      const journey = (r.journeySteps as any[]) || [];
      const summaryMatch = r.summary?.toLowerCase().includes(searchText);
      const clickMatch = clicks.some((c) => c.text?.toLowerCase().includes(searchText));
      const journeyMatch = journey.some((j: any) => j.action?.toLowerCase().includes(searchText));
      return summaryMatch || clickMatch || journeyMatch;
    });
  }

  if (args.notClickedElement) {
    const excludeText = args.notClickedElement.toLowerCase();
    recordings = recordings.filter((r) => {
      const clicks = (r.clickPoints as any[]) || [];
      const journey = (r.journeySteps as any[]) || [];
      const summaryMatch = r.summary?.toLowerCase().includes(excludeText);
      const clickMatch = clicks.some((c) => c.text?.toLowerCase().includes(excludeText));
      const journeyMatch = journey.some((j: any) => j.action?.toLowerCase().includes(excludeText));
      return !summaryMatch && !clickMatch && !journeyMatch;
    });
  }

  if (args.hasFriction === "true") {
    recordings = recordings.filter((r) => {
      const friction = (r.frictionPoints as any[]) || [];
      return friction.length > 0;
    });
  }

  // Filter by visitor attributes if needed
  if (args.country || args.device || args.utmSource || args.referrer || args.visitorId) {
    const visitorWhere: Record<string, unknown> = { projectId };
    if (args.country) visitorWhere.countryCode = args.country.toUpperCase();
    if (args.device) visitorWhere.device = args.device.toLowerCase();
    if (args.utmSource) visitorWhere.firstUtmSource = { $regex: args.utmSource, $options: "i" };
    if (args.referrer) visitorWhere.firstReferrer = { $regex: args.referrer, $options: "i" };
    if (args.visitorId) {
      visitorWhere.$or = [
        { name: { $regex: args.visitorId, $options: "i" } },
        { visitorId: { $regex: args.visitorId, $options: "i" } },
        { email: { $regex: args.visitorId, $options: "i" } },
      ];
    }

    const matchingVisitors = await Visitor.find(visitorWhere)
      .select("visitorId")
      .lean();
    const visitorIdSet = new Set(matchingVisitors.map((v: any) => v.visitorId));
    recordings = recordings.filter((r: any) => visitorIdSet.has(r.visitorId));
  }

  const visitorIds = [...new Set(recordings.map((r: any) => r.visitorId))];
  const visitors = await Visitor.find({ projectId, visitorId: { $in: visitorIds } })
    .select("visitorId name country countryCode device firstUtmSource firstReferrer")
    .lean();
  const visitorMap = new Map(visitors.map((v: any) => [v.visitorId, v]));

  const sentimentBreakdown: Record<string, number> = {};
  const countryBreakdown: Record<string, number> = {};
  const deviceBreakdown: Record<string, number> = {};

  for (const r of recordings) {
    sentimentBreakdown[(r as any).sentiment || "unknown"] = (sentimentBreakdown[(r as any).sentiment || "unknown"] || 0) + 1;
    const v = visitorMap.get((r as any).visitorId) as any;
    if (v?.countryCode) countryBreakdown[v.countryCode] = (countryBreakdown[v.countryCode] || 0) + 1;
    if (v?.device) deviceBreakdown[v.device] = (deviceBreakdown[v.device] || 0) + 1;
  }

  return {
    matchedCount: recordings.length,
    recordings: recordings.slice(0, 20).map((r: any) => ({
      id: r._id?.toString() ?? r.id,
      visitorName: (visitorMap.get(r.visitorId) as any)?.name || r.visitorId,
      country: (visitorMap.get(r.visitorId) as any)?.country,
      device: (visitorMap.get(r.visitorId) as any)?.device,
      duration: r.duration,
      pagesVisited: r.pagesVisited,
      summary: r.summary,
      sentiment: r.sentiment,
      frictionCount: ((r.frictionPoints as any[]) || []).length,
      startedAt: r.startedAt,
    })),
    breakdown: { sentimentBreakdown, countryBreakdown, deviceBreakdown },
    summary: `Found ${recordings.length} recorded session${recordings.length !== 1 ? "s" : ""} matching the criteria`,
  };
}

async function executeAnalyzeBehaviorPatterns(projectId: string, args: any) {
  const searchArgs: any = {};
  if (args.country) searchArgs.country = args.country;
  if (args.device) searchArgs.device = args.device;
  if (args.utmSource) searchArgs.utmSource = args.utmSource;
  if (args.referrer) searchArgs.referrer = args.referrer;
  if (args.clickedElement) searchArgs.clickedElement = args.clickedElement;
  if (args.notClickedElement) searchArgs.notClickedElement = args.notClickedElement;
  if (args.page) searchArgs.page = args.page;

  const results = await executeSearchRecordings(projectId, searchArgs);

  if (results.matchedCount === 0) {
    return {
      analysis: "No session recordings match the given criteria. Try broadening your filters or ensure session recording is enabled.",
      matchedCount: 0,
      suggestions: [],
    };
  }

  const summaries = results.recordings
    .map((r) => `- ${r.visitorName} (${r.country || "unknown"}, ${r.device || "unknown"}): ${r.summary} [sentiment: ${r.sentiment}]`)
    .join("\n");

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (!endpoint || !apiKey) {
    return {
      analysis: `Based on ${results.matchedCount} recordings: ${results.recordings.map((r) => r.summary).join(" ")}`,
      matchedCount: results.matchedCount,
      breakdown: results.breakdown,
      suggestions: ["Enable AI (Azure OpenAI) for deeper analysis"],
    };
  }

  const client = new AzureOpenAI({ endpoint, apiKey, apiVersion: "2024-08-01-preview" });
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o-mini";

  const prompt = `You are a conversion optimization expert. Analyze these ${results.matchedCount} session recording summaries and answer the user's question.

User's question: "${args.question}"

Session summaries:
${summaries}

Breakdown:
- Sentiment: ${JSON.stringify(results.breakdown.sentimentBreakdown)}
- Countries: ${JSON.stringify(results.breakdown.countryBreakdown)}
- Devices: ${JSON.stringify(results.breakdown.deviceBreakdown)}

Respond with valid JSON only (no markdown fences):
{
  "analysis": "Clear, data-driven answer to the question with specific numbers and percentages",
  "patterns": ["list of observed behavior patterns"],
  "suggestions": ["actionable suggestions to improve conversion, be specific with numbers like '10% discount' or 'simplified 2-step process'"]
}`;

  const response = await client.chat.completions.create({
    model: deployment,
    messages: [
      { role: "system", content: "You are a conversion optimization and UX expert. Provide data-driven insights from session recordings. Always respond with valid JSON only." },
      { role: "user", content: prompt },
    ],
    temperature: 0.4,
    max_tokens: 1000,
  });

  const content = response.choices[0]?.message?.content || "";
  let parsed: any;
  try {
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = { analysis: content, patterns: [], suggestions: [] };
  }

  return {
    analysis: parsed.analysis || content,
    patterns: parsed.patterns || [],
    suggestions: parsed.suggestions || [],
    matchedCount: results.matchedCount,
    breakdown: results.breakdown,
  };
}

// ─── Context Builder ────────────────────────────────────────────────

async function buildSystemPrompt(projectId: string, userQuery: string) {
  const projectIdObj = new mongoose.Types.ObjectId(projectId);

  const [visitorFacets, trackEventFacets, topPagesRaw, recentClicks, recentForms, samplePages, totalCount, identifiedCount, paidCount, recordingCount, analyzedRecordingCount] = await Promise.all([
    Visitor.aggregate([
      { $match: { projectId: projectIdObj } },
      {
        $facet: {
          byCountry: [{ $group: { _id: "$countryCode", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 50 }],
          byDevice: [{ $group: { _id: "$device", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          byBrowser: [{ $group: { _id: "$browser", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          byOs: [{ $group: { _id: "$os", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          byLanguage: [{ $group: { _id: "$language", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          byReferrer: [{ $group: { _id: "$firstReferrer", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          byUtmSource: [{ $group: { _id: "$firstUtmSource", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        },
      },
    ]),
    TrackEvent.aggregate([
      { $match: { projectId: projectIdObj } },
      {
        $facet: {
          eventNames: [{ $group: { _id: "$name" } }, { $limit: 100 }],
          sampleEvents: [
            { $sort: { timestamp: -1 } },
            { $limit: 10 },
            { $project: { name: 1, properties: 1, visitorId: 1, url: 1 } },
          ],
        },
      },
    ]),
    PageView.distinct("url", { projectId }),
    TrackEvent.find({ projectId, name: "click" })
      .select("properties")
      .sort({ timestamp: -1 })
      .limit(500)
      .lean(),
    TrackEvent.find({ projectId, name: "form_submit" })
      .select("properties")
      .sort({ timestamp: -1 })
      .limit(200)
      .lean(),
    PageView.find({ projectId })
      .select("url title visitorId")
      .sort({ timestamp: -1 })
      .limit(10)
      .lean(),
    Visitor.countDocuments({ projectId }),
    Visitor.countDocuments({ projectId, email: { $ne: null } }),
    Visitor.countDocuments({ projectId, totalRevenue: { $gt: 0 } }),
    SessionRecording.countDocuments({ projectId }),
    SessionRecording.countDocuments({ projectId, status: "analyzed" }),
  ]);

  const facets = visitorFacets[0] ?? {};
  const countryGroups = (facets.byCountry ?? []).map((g: any) => ({ countryCode: g._id, _count: { _all: g.count } }));
  const deviceGroups = (facets.byDevice ?? []).map((g: any) => ({ device: g._id, _count: { _all: g.count } }));
  const browserGroups = (facets.byBrowser ?? []).map((g: any) => ({ browser: g._id, _count: { _all: g.count } }));
  const osGroups = (facets.byOs ?? []).map((g: any) => ({ os: g._id, _count: { _all: g.count } }));
  const languageGroups = (facets.byLanguage ?? []).map((g: any) => ({ language: g._id, _count: { _all: g.count } }));
  const referrerGroups = (facets.byReferrer ?? []).map((g: any) => ({ firstReferrer: g._id, _count: { _all: g.count } }));
  const utmSourceGroups = (facets.byUtmSource ?? []).map((g: any) => ({ firstUtmSource: g._id, _count: { _all: g.count } }));

  const teFacets = trackEventFacets[0] ?? {};
  const eventNamesRaw = (teFacets.eventNames ?? []).map((g: any) => ({ name: g._id }));
  const sampleEventsFromFacet = teFacets.sampleEvents ?? [];

  const extractGroupKeys = (groups: any[], key: string) =>
    groups.map((g: any) => g[key]).filter(Boolean).sort() as string[];

  const eventNames = eventNamesRaw.map((e: any) => e.name as string).filter(Boolean).sort();
  const pageUrls = (Array.isArray(topPagesRaw) ? topPagesRaw : []).filter(Boolean).sort();

  const clickLabels = [...new Set(
    recentClicks.map((e: any) => (e.properties as any)?.text).filter(Boolean)
  )].sort() as string[];
  const formIds = [...new Set(
    recentForms.map((e: any) => (e.properties as any)?.formId || (e.properties as any)?.action).filter(Boolean)
  )].sort() as string[];

  const filterOptions = {
    countries: extractGroupKeys(countryGroups, "countryCode"),
    devices: extractGroupKeys(deviceGroups, "device"),
    browsers: extractGroupKeys(browserGroups, "browser"),
    os: extractGroupKeys(osGroups, "os"),
    languages: extractGroupKeys(languageGroups, "language"),
    referrers: extractGroupKeys(referrerGroups, "firstReferrer"),
    utmSources: extractGroupKeys(utmSourceGroups, "firstUtmSource"),
  };

  const queryKeywords = userQuery.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const relevantLabels = clickLabels.filter((l) =>
    queryKeywords.some((kw) => l.toLowerCase().includes(kw))
  );
  const relevantEvents = eventNames.filter((n: string) =>
    queryKeywords.some((kw) => n.toLowerCase().includes(kw))
  );

  let relevantSection = "";
  if (relevantLabels.length || relevantEvents.length) {
    relevantSection = "\n\nRELEVANT MATCHES from user query keywords:";
    if (relevantLabels.length) relevantSection += `\n- Matching click labels: ${relevantLabels.join(", ")}`;
    if (relevantEvents.length) relevantSection += `\n- Matching event names: ${relevantEvents.join(", ")}`;
  }

  const sampleSection = sampleEventsFromFacet.length ? `\n\nSample recent track events (for reference):\n${sampleEventsFromFacet.map((e: any) => JSON.stringify({ name: e.name, properties: e.properties, url: e.url })).join("\n")}` : "";
  const samplePageSection = samplePages.length ? `\n\nSample recent page views:\n${samplePages.map((p: any) => JSON.stringify({ url: p.url, title: p.title })).join("\n")}` : "";

  const prompt = `You are Segi, an AI analytics assistant for the Segmentor platform. You help users understand and explore their visitor data through conversation.

Your personality: helpful, concise, data-driven. You speak in short clear sentences. When you present numbers, you provide context (percentages, comparisons).

You have access to tools to filter visitors, query statistics, export data, clear filters, and look up individual visitors. Use them proactively when the user's question requires data.

When the user asks to "clear filters", "reset filters", "show all visitors", "remove filters", or anything similar, use the clear_filters tool.

When the user asks about a specific visitor by name (e.g. "tell me about keen rabbit", "give details about vivid toucan"), use the get_visitor_details tool. Anonymous visitors have randomly generated names like "keen rabbit" or "vivid toucan" — these are real names stored in the system and can be looked up.

AVAILABLE DATA CONTEXT:
- Total visitors: ${totalCount}
- Identified visitors: ${identifiedCount}
- Paid customers: ${paidCount}
- Today's date: ${new Date().toISOString().split("T")[0]}

Available filter values:
- Countries: ${filterOptions.countries.join(", ") || "none"}
- Devices: ${filterOptions.devices.join(", ") || "none"}
- Browsers: ${filterOptions.browsers.join(", ") || "none"}
- OS: ${filterOptions.os.join(", ") || "none"}
- Languages: ${filterOptions.languages.join(", ") || "none"}
- Referrers: ${filterOptions.referrers.join(", ") || "none"}
- UTM Sources: ${filterOptions.utmSources.join(", ") || "none"}

Available tracked event types: ${eventNames.length ? eventNames.join(", ") : "none"}
Available click button/link labels: ${clickLabels.length ? clickLabels.join(", ") : "none"}
Available form IDs: ${formIds.length ? formIds.join(", ") : "none"}
Available page URLs: ${pageUrls.slice(0, 30).join(", ") || "none"}

EVENT DATA MODEL:
- Click events: name="click", actual label in properties.text
- Form submissions: name="form_submit", form ID in properties.formId
- Custom events: have a unique name
- Page views: separate table with url field

When using filter_visitors with events, use the "label" field for clicks/form_submit matching the labels above. Use fuzzy matching - the label you provide will be matched against stored data.

IMPORTANT: After using export_visitors, do NOT include download links or URLs in your text response. The UI already shows a download button for the user. Just confirm what was exported (e.g. "Exported 23 visitors from Azerbaijan as CSV.").

SESSION RECORDINGS:
- Total recordings: ${recordingCount}
- Analyzed recordings: ${analyzedRecordingCount}
- Use search_recordings when users ask about session recordings, visitor journeys, click behavior, what visitors did, or friction points.
- Use analyze_behavior_patterns for complex behavioral questions like "which users clicked X but didn't Y", "why are users from country X not converting", or funnel analysis.
- When analyze_behavior_patterns returns suggestions, present them as actionable recommendations (e.g. "Consider offering a 10% discount for visitors from Portugal").
- If recordings data is available, prefer it over basic visitor filters for behavioral questions since recordings contain richer interaction data.${relevantSection}${sampleSection}${samplePageSection}`;

  return { prompt, clickLabels, formIds };
}

// ─── SSE Streaming Chat Endpoint ────────────────────────────────────

segi.post("/projects/:projectId/segi/chat", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const body = await c.req.json<{ conversationId?: string; message: string }>();
  const message = body.message?.trim();
  if (!message) return c.json({ error: "Message is required" }, 400);

  const client = getOpenAIClient();
  if (!client) return c.json({ error: "AI is not configured" }, 503);

  let conversationId = body.conversationId;
  if (!conversationId) {
    const conv = await SegiConversation.create({
      projectId,
      title: message.slice(0, 100),
    });
    conversationId = conv.id;
  }

  await SegiMessage.create({
    conversationId,
    role: "user",
    content: message,
  });

  const prevMessages = await SegiMessage.find({ conversationId })
    .sort({ createdAt: 1 })
    .limit(50)
    .lean();

  const { prompt: systemPrompt, clickLabels, formIds } = await buildSystemPrompt(projectId, message);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  let pendingToolCalls: { id: string; name: string; args: string }[] = [];
  for (const msg of prevMessages) {
    if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant" && msg.content) {
      messages.push({ role: "assistant", content: msg.content });
    } else if (msg.role === "tool_use" && msg.toolName) {
      const toolCallId = (msg as any).id ?? (msg as any)._id?.toString();
      pendingToolCalls.push({ id: toolCallId, name: msg.toolName, args: JSON.stringify(msg.toolInput || {}) });
    } else if (msg.role === "tool_result" && msg.toolOutput && pendingToolCalls.length > 0) {
      const tc = pendingToolCalls.shift()!;
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } }],
      } as any);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(msg.toolOutput),
      } as any);
    }
  }
  pendingToolCalls = [];

  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o-mini";

  return streamSSE(c, async (stream) => {
    let disconnected = false;
    const safeWrite = async (event: string, data: string) => {
      if (disconnected) return;
      try {
        await stream.writeSSE({ event, data });
      } catch {
        disconnected = true;
      }
    };

    try {
      await safeWrite("conversation", JSON.stringify({ conversationId }));
      await safeWrite("thinking", "{}");

      let continueLoop = true;
      let iterations = 0;

      while (continueLoop && !disconnected) {
        if (++iterations > MAX_TOOL_ITERATIONS) {
          console.warn("[Segi] Tool-call loop limit reached");
          break;
        }

        const response = await client.chat.completions.create({
          model: deployment,
          messages,
          tools: TOOL_DEFINITIONS,
          tool_choice: "auto",
          temperature: 0.3,
          max_tokens: 1000,
          stream: true,
        });

        let currentText = "";
        let currentToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
        let hasToolCalls = false;

        for await (const chunk of response) {
          if (disconnected) break;
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            currentText += delta.content;
            await safeWrite("text_delta", JSON.stringify({ delta: delta.content }));
          }

          if (delta.tool_calls) {
            hasToolCalls = true;
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!currentToolCalls.has(idx)) {
                currentToolCalls.set(idx, { id: tc.id || "", name: "", args: "" });
              }
              const entry = currentToolCalls.get(idx)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) {
                entry.name = tc.function.name;
                await safeWrite("tool_call_start", JSON.stringify({ toolCallId: entry.id, toolName: entry.name }));
              }
              if (tc.function?.arguments) {
                entry.args += tc.function.arguments;
                await safeWrite("tool_call_args", JSON.stringify({ toolCallId: entry.id, delta: tc.function.arguments }));
              }
            }
          }
        }

        if (!hasToolCalls) {
          if (currentText) {
            await SegiMessage.create({
              conversationId: conversationId!,
              role: "assistant",
              content: currentText,
            });
          }
          continueLoop = false;
        } else {
          if (currentText) {
            await SegiMessage.create({
              conversationId: conversationId!,
              role: "assistant",
              content: currentText,
            });
          }

          const assistantToolMsg: any = {
            role: "assistant",
            content: currentText || null,
            tool_calls: [...currentToolCalls.values()].map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.args },
            })),
          };
          messages.push(assistantToolMsg);

          for (const tc of currentToolCalls.values()) {
            if (disconnected) break;
            let parsedArgs: any = {};
            try { parsedArgs = JSON.parse(tc.args); } catch {}

            let toolResult: any;
            try {
              if (tc.name === "filter_visitors") {
                toolResult = await executeFilterVisitors(projectId, parsedArgs, clickLabels, formIds);
              } else if (tc.name === "query_visitor_stats") {
                toolResult = await executeQueryStats(projectId, parsedArgs);
              } else if (tc.name === "export_visitors") {
                toolResult = await executeExportVisitors(projectId, parsedArgs);
              } else if (tc.name === "clear_filters") {
                toolResult = { cleared: true, summary: "All filters have been cleared. Showing all visitors." };
              } else if (tc.name === "get_visitor_details") {
                toolResult = await executeGetVisitorDetails(projectId, parsedArgs);
              } else if (tc.name === "search_recordings") {
                toolResult = await executeSearchRecordings(projectId, parsedArgs);
              } else if (tc.name === "analyze_behavior_patterns") {
                toolResult = await executeAnalyzeBehaviorPatterns(projectId, parsedArgs);
              } else {
                toolResult = { error: "Unknown tool" };
              }
            } catch (err: any) {
              toolResult = { error: err.message || "Tool execution failed" };
            }

            await safeWrite("tool_result", JSON.stringify({ toolCallId: tc.id, toolName: tc.name, result: toolResult }));

            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(toolResult),
            } as any);

            await SegiMessage.create({
              conversationId: conversationId!,
              role: "tool_use",
              content: "",
              toolName: tc.name,
              toolInput: parsedArgs,
            });
            await SegiMessage.create({
              conversationId: conversationId!,
              role: "tool_result",
              content: "",
              toolName: tc.name,
              toolOutput: toolResult,
            });
          }
        }
      }

      await safeWrite("done", JSON.stringify({ conversationId }));
    } catch (err: any) {
      console.error("[Segi] Stream error:", err?.message || err);
      if (!disconnected) {
        try { await stream.writeSSE({ event: "error", data: JSON.stringify({ message: err?.message || "An error occurred" }) }); } catch {}
      }
    }
  });
});

// ─── Conversation CRUD ──────────────────────────────────────────────

segi.get("/projects/:projectId/segi/conversations", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const conversations = await SegiConversation.find({ projectId })
    .sort({ updatedAt: -1 })
    .limit(50)
    .select("title createdAt updatedAt")
    .lean();

  const conversationsWithId = conversations.map((c: any) => ({
    id: c._id?.toString(),
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));

  return c.json({ conversations: conversationsWithId });
});

segi.get("/projects/:projectId/segi/conversations/:id", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  await requireProjectOwnership(projectId, userId);

  const conversation = await SegiConversation.findOne({ _id: id, projectId }).lean();
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const messages = await SegiMessage.find({ conversationId: id })
    .sort({ createdAt: 1 })
    .lean();

  const conv = conversation as any;
  const conversationWithMessages = {
    id: conv._id?.toString(),
    title: conv.title,
    projectId: conv.projectId,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messages: messages.map((m: any) => ({
      id: m._id?.toString(),
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      toolName: m.toolName,
      toolInput: m.toolInput,
      toolOutput: m.toolOutput,
      createdAt: m.createdAt,
    })),
  };

  return c.json({ conversation: conversationWithMessages });
});

segi.delete("/projects/:projectId/segi/conversations/:id", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  await requireProjectOwnership(projectId, userId);

  const conv = await SegiConversation.findOne({ _id: id, projectId });
  if (!conv) return c.json({ error: "Conversation not found" }, 404);

  await SegiConversation.findByIdAndDelete(id);
  return c.json({ ok: true });
});

// ─── On-Demand Export Download ──────────────────────────────────────

segi.get("/projects/:projectId/segi/export", async (c) => {
  const projectId = c.req.param("projectId");
  const format = c.req.query("format") || "csv";
  const filtersRaw = c.req.query("filters");

  const where: Record<string, unknown> = { projectId };
  if (filtersRaw) {
    try {
      const filters = JSON.parse(filtersRaw);
      if (filters.device) where.device = filters.device.toLowerCase();
      if (filters.browser) where.browser = { $regex: filters.browser, $options: "i" };
      if (filters.country) where.countryCode = filters.country.toUpperCase();
      if (filters.identified === "true") where.email = { $ne: null };
      if (filters.hasRevenue === "true") where.totalRevenue = { $gt: 0 };
    } catch {}
  }

  const visitors = await Visitor.find(where)
    .sort({ lastSeenAt: -1 })
    .limit(10000)
    .lean();

  const headers = ["visitorId", "email", "name", "country", "countryCode", "city", "device", "browser", "os", "language", "totalPageviews", "totalSessions", "totalEvents", "totalRevenue", "firstSeenAt", "lastSeenAt"];
  const filename = `visitors-${visitors.length}.${format}`;

  if (format === "json") {
    return new Response(JSON.stringify(visitors, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  if (format === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Visitors");
    sheet.addRow(headers);
    for (const v of visitors as any[]) {
      sheet.addRow(headers.map((h) => v[h] ?? ""));
    }
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  // Default: CSV
  const rows = visitors.map((v: any) =>
    headers.map((h) => {
      const val = v[h];
      if (val === null || val === undefined) return "";
      const str = String(val);
      return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(",")
  );
  const csv = [headers.join(","), ...rows].join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

// ─── Backfill Friendly Names ────────────────────────────────────────

segi.post("/projects/:projectId/segi/backfill-names", async (c) => {
  const projectId = c.req.param("projectId");

  const visitors = await Visitor.find({ projectId, name: null })
    .select("visitorId")
    .lean();

  const ops = (visitors as any[]).map((v) => ({
    updateOne: {
      filter: { _id: v._id },
      update: { $set: { name: friendlyName(v.visitorId), isRandomName: true } },
    },
  }));

  if (ops.length > 0) {
    await Visitor.bulkWrite(ops);
  }

  return c.json({ ok: true, updated: ops.length });
});

export default segi;
