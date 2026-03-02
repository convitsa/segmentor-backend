import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireAuth } from "../auth/middleware.js";
import { requireProjectOwnership } from "../lib/ownership.js";
import { prisma } from "../db/index.js";
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
        const matches = await prisma.pageView.findMany({
          where: { projectId, url: { contains: evt.url, mode: "insensitive" } },
          select: { visitorId: true },
          distinct: ["visitorId"],
        });
        ids = matches.map((m: any) => m.visitorId);
      } else if ((evt.type === "click" || evt.type === "form_submit") && evt.label?.trim()) {
        const resolved = evt.type === "click"
          ? fuzzyMatch(evt.label, clickLabels)
          : fuzzyMatch(evt.label, formIds);
        console.log(`[Segi] ${evt.type} label="${evt.label}" -> resolved="${resolved}"`);

        const resolvedLabel = resolved || evt.label;
        if (!resolvedLabel?.trim()) continue;

        const allOfType = await prisma.trackEvent.findMany({
          where: { projectId, name: evt.type },
          select: { visitorId: true, properties: true },
        });
        const labelLower = resolvedLabel.toLowerCase();
        const matched = allOfType.filter((m: any) => {
          const text = (m.properties as any)?.text;
          return text && String(text).toLowerCase().includes(labelLower);
        });
        ids = [...new Set(matched.map((m: any) => m.visitorId))];
      } else if (evt.name) {
        const matches = await prisma.trackEvent.findMany({
          where: { projectId, name: { contains: evt.name, mode: "insensitive" } },
          select: { visitorId: true },
          distinct: ["visitorId"],
        });
        ids = matches.map((m: any) => m.visitorId);
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
  if (filters.browser) where.browser = { contains: filters.browser, mode: "insensitive" };
  if (filters.os) where.os = { contains: filters.os, mode: "insensitive" };
  if (filters.country) where.countryCode = filters.country.toUpperCase();
  if (filters.identified === "true") where.email = { not: null };
  else if (filters.identified === "false") where.email = null;
  if (filters.hasRevenue === "true") where.totalRevenue = { gt: 0 };
  if (filters.live === "true") where.lastSeenAt = { gte: new Date(Date.now() - 5 * 60 * 1000) };
  if (filters.search) {
    where.OR = [
      { name: { contains: filters.search, mode: "insensitive" } },
      { email: { contains: filters.search, mode: "insensitive" } },
      { city: { contains: filters.search, mode: "insensitive" } },
    ];
  }
  if (filters.seenAfter) where.lastSeenAt = { ...(where.lastSeenAt as any || {}), gte: new Date(filters.seenAfter) };
  if (filters.seenBefore) where.lastSeenAt = { ...(where.lastSeenAt as any || {}), lte: new Date(filters.seenBefore) };
  if (filters.utmSource) where.firstUtmSource = { contains: filters.utmSource, mode: "insensitive" };
  if (filters.utmMedium) where.firstUtmMedium = { contains: filters.utmMedium, mode: "insensitive" };
  if (filters.utmCampaign) where.firstUtmCampaign = { contains: filters.utmCampaign, mode: "insensitive" };
  if (filters.referrer) where.firstReferrer = { contains: filters.referrer, mode: "insensitive" };
  if (filters.tag) where.tags = { has: filters.tag };
  if (visitorIds) where.visitorId = { in: visitorIds };

  const orderBy: Record<string, string> = {};
  if (filters.sortBy) orderBy[filters.sortBy] = filters.sortOrder || "desc";
  else orderBy.lastSeenAt = "desc";

  const count = await prisma.visitor.count({ where: where as any });

  return {
    matchedCount: count,
    filters,
    visitorIds: visitorIds || [],
    summary: `Found ${count} visitor${count !== 1 ? "s" : ""} matching the criteria`,
  };
}

async function executeQueryStats(projectId: string, args: any) {
  const groupBy = args.groupBy;

  const [totalCount, identifiedCount, paidCount, aggregates] = await Promise.all([
    prisma.visitor.count({ where: { projectId } }),
    prisma.visitor.count({ where: { projectId, email: { not: null } } }),
    prisma.visitor.count({ where: { projectId, totalRevenue: { gt: 0 } } }),
    prisma.visitor.aggregate({
      where: { projectId },
      _sum: { totalRevenue: true, totalPageviews: true, totalSessions: true, totalEvents: true },
      _avg: { totalPageviews: true, totalSessions: true },
    }),
  ]);

  const result: any = {
    totalVisitors: totalCount,
    identifiedVisitors: identifiedCount,
    paidCustomers: paidCount,
    totalRevenue: aggregates._sum.totalRevenue || 0,
    totalPageviews: aggregates._sum.totalPageviews || 0,
    totalSessions: aggregates._sum.totalSessions || 0,
    avgPageviewsPerVisitor: Math.round((aggregates._avg.totalPageviews || 0) * 10) / 10,
    avgSessionsPerVisitor: Math.round((aggregates._avg.totalSessions || 0) * 10) / 10,
  };

  if (groupBy) {
    const fieldMap: Record<string, string> = {
      device: "device", browser: "browser", os: "os",
      country: "countryCode", language: "language",
    };

    if (fieldMap[groupBy]) {
      const groups = await prisma.visitor.groupBy({
        by: [fieldMap[groupBy] as any],
        where: { projectId },
        _count: { _all: true },
      });
      result.breakdown = groups.map((g: any) => {
        const name = g[fieldMap[groupBy]] || "unknown";
        const count = g._count._all;
        return { name, count, percentage: Math.round((count / totalCount) * 1000) / 10 };
      }).sort((a: any, b: any) => b.count - a.count);
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
  if (filters.browser) where.browser = { contains: filters.browser, mode: "insensitive" };
  if (filters.country) where.countryCode = filters.country.toUpperCase();
  if (filters.identified === "true") where.email = { not: null };
  if (filters.hasRevenue === "true") where.totalRevenue = { gt: 0 };

  const recordCount = await prisma.visitor.count({ where: where as any });
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

  const visitor = await prisma.visitor.findFirst({
    where: {
      projectId,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { email: { contains: query, mode: "insensitive" } },
      ],
    },
  });

  if (!visitor) {
    return { error: `No visitor found matching "${query}"` };
  }

  const [recentPages, recentEvents, sessions] = await Promise.all([
    prisma.pageView.findMany({
      where: { projectId, visitorId: (visitor as any).visitorId },
      orderBy: { timestamp: "desc" },
      take: 20,
      select: { url: true, title: true, timestamp: true, duration: true },
    }),
    prisma.trackEvent.findMany({
      where: { projectId, visitorId: (visitor as any).visitorId },
      orderBy: { timestamp: "desc" },
      take: 20,
      select: { name: true, properties: true, url: true, timestamp: true },
    }),
    prisma.session.findMany({
      where: { projectId, visitorId: (visitor as any).visitorId },
      orderBy: { startedAt: "desc" },
      take: 10,
      select: { entryPage: true, exitPage: true, pageviews: true, events: true, duration: true, startedAt: true, referrer: true, utmSource: true },
    }),
  ]);

  const v = visitor as any;
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

// ─── Context Builder ────────────────────────────────────────────────

async function buildSystemPrompt(projectId: string, userQuery: string) {
  const [
    countryGroups, deviceGroups, browserGroups, osGroups, languageGroups,
    referrerGroups, utmSourceGroups,
    eventNamesRaw, topPagesRaw, recentClicks, recentForms, sampleEvents, samplePages,
    totalCount, identifiedCount, paidCount,
  ] = await Promise.all([
    prisma.visitor.groupBy({ by: ["countryCode"], where: { projectId }, _count: { _all: true } }),
    prisma.visitor.groupBy({ by: ["device"], where: { projectId }, _count: { _all: true } }),
    prisma.visitor.groupBy({ by: ["browser"], where: { projectId }, _count: { _all: true } }),
    prisma.visitor.groupBy({ by: ["os"], where: { projectId }, _count: { _all: true } }),
    prisma.visitor.groupBy({ by: ["language"], where: { projectId }, _count: { _all: true } }),
    prisma.visitor.groupBy({ by: ["firstReferrer"], where: { projectId }, _count: { _all: true } }),
    prisma.visitor.groupBy({ by: ["firstUtmSource"], where: { projectId }, _count: { _all: true } }),
    prisma.trackEvent.findMany({ where: { projectId }, distinct: ["name"], select: { name: true }, take: 100 }),
    prisma.pageView.findMany({ where: { projectId }, distinct: ["url"], select: { url: true }, take: 100 }),
    prisma.trackEvent.findMany({ where: { projectId, name: "click" }, select: { properties: true }, take: 500, orderBy: { timestamp: "desc" } }),
    prisma.trackEvent.findMany({ where: { projectId, name: "form_submit" }, select: { properties: true }, take: 200, orderBy: { timestamp: "desc" } }),
    prisma.trackEvent.findMany({ where: { projectId }, select: { name: true, properties: true, visitorId: true, url: true }, take: 10, orderBy: { timestamp: "desc" } }),
    prisma.pageView.findMany({ where: { projectId }, select: { url: true, title: true, visitorId: true }, take: 10, orderBy: { timestamp: "desc" } }),
    prisma.visitor.count({ where: { projectId } }),
    prisma.visitor.count({ where: { projectId, email: { not: null } } }),
    prisma.visitor.count({ where: { projectId, totalRevenue: { gt: 0 } } }),
  ]);

  const extractGroupKeys = (groups: any[], key: string) =>
    groups.map((g: any) => g[key]).filter(Boolean).sort() as string[];

  const eventNames = eventNamesRaw.map((e: any) => e.name as string).filter(Boolean).sort();
  const pageUrls = topPagesRaw.map((p: any) => p.url as string).filter(Boolean).sort();

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
  const relevantEvents = eventNames.filter((n) =>
    queryKeywords.some((kw) => n.toLowerCase().includes(kw))
  );

  let relevantSection = "";
  if (relevantLabels.length || relevantEvents.length) {
    relevantSection = "\n\nRELEVANT MATCHES from user query keywords:";
    if (relevantLabels.length) relevantSection += `\n- Matching click labels: ${relevantLabels.join(", ")}`;
    if (relevantEvents.length) relevantSection += `\n- Matching event names: ${relevantEvents.join(", ")}`;
  }

  const sampleSection = sampleEvents.length ? `\n\nSample recent track events (for reference):\n${sampleEvents.map((e: any) => JSON.stringify({ name: e.name, properties: e.properties, url: e.url })).join("\n")}` : "";
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

IMPORTANT: After using export_visitors, do NOT include download links or URLs in your text response. The UI already shows a download button for the user. Just confirm what was exported (e.g. "Exported 23 visitors from Azerbaijan as CSV.").${relevantSection}${sampleSection}${samplePageSection}`;

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
    const conv = await prisma.segiConversation.create({
      data: { projectId, title: message.slice(0, 100) },
    });
    conversationId = conv.id;
  }

  await prisma.segiMessage.create({
    data: { conversationId, role: "user", content: message },
  });

  const prevMessages = await prisma.segiMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

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
      const toolCallId = msg.id;
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
            await prisma.segiMessage.create({
              data: { conversationId: conversationId!, role: "assistant", content: currentText },
            });
          }
          continueLoop = false;
        } else {
          if (currentText) {
            await prisma.segiMessage.create({
              data: { conversationId: conversationId!, role: "assistant", content: currentText },
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

            await prisma.segiMessage.create({
              data: { conversationId: conversationId!, role: "tool_use", content: "", toolName: tc.name, toolInput: parsedArgs },
            });
            await prisma.segiMessage.create({
              data: { conversationId: conversationId!, role: "tool_result", content: "", toolName: tc.name, toolOutput: toolResult },
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

  const conversations = await prisma.segiConversation.findMany({
    where: { projectId },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, createdAt: true, updatedAt: true },
  });

  return c.json({ conversations });
});

segi.get("/projects/:projectId/segi/conversations/:id", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  await requireProjectOwnership(projectId, userId);

  const conversation = await prisma.segiConversation.findFirst({
    where: { id, projectId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });

  if (!conversation) return c.json({ error: "Conversation not found" }, 404);
  return c.json({ conversation });
});

segi.delete("/projects/:projectId/segi/conversations/:id", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  await requireProjectOwnership(projectId, userId);

  const conv = await prisma.segiConversation.findFirst({ where: { id, projectId } });
  if (!conv) return c.json({ error: "Conversation not found" }, 404);

  await prisma.segiConversation.delete({ where: { id } });
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
      if (filters.browser) where.browser = { contains: filters.browser, mode: "insensitive" };
      if (filters.country) where.countryCode = filters.country.toUpperCase();
      if (filters.identified === "true") where.email = { not: null };
      if (filters.hasRevenue === "true") where.totalRevenue = { gt: 0 };
    } catch {}
  }

  const visitors = await prisma.visitor.findMany({
    where: where as any,
    orderBy: { lastSeenAt: "desc" },
    take: 10000,
  });

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

  const visitors = await prisma.visitor.findMany({
    where: { projectId, name: null },
    select: { id: true, visitorId: true },
  });

  let updated = 0;
  for (const v of visitors) {
    await prisma.visitor.update({
      where: { id: v.id },
      data: { name: friendlyName(v.visitorId), isRandomName: true },
    });
    updated++;
  }

  return c.json({ ok: true, updated });
});

export default segi;
