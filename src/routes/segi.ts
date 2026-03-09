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
  Recording,
  Project,
} from "../db/models.js";
import { AzureOpenAI } from "openai";
import { distance } from "fastest-levenshtein";
import ExcelJS from "exceljs";
import { friendlyName } from "../lib/friendly-name.js";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { readFile } from "fs/promises";
import { join } from "path";
import { parse as parseHTML } from "node-html-parser";

const MAX_TOOL_ITERATIONS = 8;

// ─── CRO Skill Catalog ──────────────────────────────────────────────

const SKILLS_DIR = join(import.meta.dir, "../../skills");

const SKILL_CATALOG: { name: string; description: string }[] = [
  { name: "page-cro", description: "Page conversion optimization: homepage, landing pages, pricing pages, feature pages. Use for bounce rate, low conversions, page not converting, CRO audit." },
  { name: "signup-flow-cro", description: "Signup/registration flow optimization. Use for signup drop-off, registration friction, trial conversion, account creation." },
  { name: "form-cro", description: "Form optimization for lead capture, contact forms, demo request, application, checkout forms. Use for form abandonment, too many fields, form completion rate." },
  { name: "popup-cro", description: "Popup/modal optimization: exit intent, email capture, lead magnets, announcement banners, slide-ins. Use for popup conversions, email collection, overlay strategy." },
  { name: "churn-prevention", description: "Cancel flows, save offers, dunning, failed payment recovery, retention strategies. Use for churn rate, customers leaving, cancel flow, win-back." },
  { name: "marketing-psychology", description: "40+ psychological principles and mental models for marketing: anchoring, social proof, scarcity, loss aversion, framing, nudge theory, pricing psychology." },
  { name: "paywall-upgrade-cro", description: "In-app paywall and upgrade screen optimization: feature gates, usage limits, trial expiration, upsell modals. Use for freemium conversion, trial to paid." },
  { name: "onboarding-cro", description: "User activation and time-to-value: post-signup onboarding, first-run experience, empty states, onboarding checklists. Use for activation rate, users not sticking." },
  { name: "email-sequence", description: "Email automation and lifecycle sequences: welcome series, lead nurture, re-engagement, onboarding emails, drip campaigns. Use for email flows and cadence." },
  { name: "ab-test-setup", description: "A/B test design and statistical rigor: hypothesis framework, sample size, experiment design, result analysis. Use for split testing, experiment planning." },
  { name: "pricing-strategy", description: "Pricing tiers, value metrics, packaging, price increases, Van Westendorp method. Use for pricing decisions, plan structure, monetization." },
  { name: "copywriting", description: "CTA copy, headline formulas, page structure, value proposition writing. Use for weak copy, headline help, CTA optimization, marketing copy." },
  { name: "analytics-tracking", description: "Event tracking, UTM parameters, GA4, conversion tracking, measurement plans. Use for tracking setup, analytics implementation, attribution." },
];

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
      name: "analyze_funnel",
      description: "Analyze a conversion funnel — track how many visitors progress through a sequence of steps (page visits, clicks, form submissions). Use when the user asks about funnels, drop-offs, or conversion flows.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description: "Ordered funnel steps. Each step is a page URL, click label, form ID, or custom event.",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["pageview", "click", "form_submit", "custom"], description: "Step type" },
                value: { type: "string", description: "URL for pageview, button label for click, form ID for form_submit, event name for custom" },
              },
              required: ["type", "value"],
            },
          },
          days: { type: "number", description: "Time window in days (default 30)" },
        },
        required: ["steps"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_traffic_sources",
      description: "Analyze which traffic sources (UTM, referrers) bring the most converting visitors. Use when the user asks about traffic quality, channel performance, ad ROI, or where their best visitors come from.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Time window in days (default 30)" },
          conversionGoal: { type: "string", enum: ["identified", "purchased", "returned"], description: "What counts as a conversion (default: identified)" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_page_performance",
      description: "Analyze page-level engagement metrics: pageviews, avg time on page, scroll depth, exit rate. Use when the user asks about page performance, engagement, or which pages need improvement.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Time window in days (default 30)" },
          limit: { type: "number", description: "Number of pages to return (default 15)" },
          sortBy: { type: "string", enum: ["exits", "avgDuration", "pageviews", "avgScrollDepth"], description: "Sort metric (default: pageviews)" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_segments",
      description: "Compare two visitor segments side by side on conversion metrics. Use when the user asks to compare mobile vs desktop, countries, identified vs anonymous, or any two groups.",
      parameters: {
        type: "object",
        properties: {
          segmentA: {
            type: "object",
            description: "First segment filter (same fields as filter_visitors: device, browser, country, identified, etc.)",
            additionalProperties: true,
          },
          segmentB: {
            type: "object",
            description: "Second segment filter",
            additionalProperties: true,
          },
          labelA: { type: "string", description: "Label for segment A (e.g. 'Mobile')" },
          labelB: { type: "string", description: "Label for segment B (e.g. 'Desktop')" },
        },
        required: ["segmentA", "segmentB"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_drop_offs",
      description: "Find pages where visitors exit the site most often. Surfaces the biggest 'leaks' — pages with highest exit rates and lowest engagement. Use when the user asks where visitors leave, what pages to fix, or for a site health check.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Time window in days (default 30)" },
          limit: { type: "number", description: "Number of pages to return (default 10)" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_behavior_patterns",
      description: "Discover what converting visitors do differently from non-converters. Compares page visits, events, session length, and engagement between visitors who converted vs those who didn't.",
      parameters: {
        type: "object",
        properties: {
          conversionGoal: { type: "string", enum: ["identified", "purchased", "returned"], description: "What counts as a conversion (default: identified)" },
          days: { type: "number", description: "Time window in days (default 30)" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_trends",
      description: "Detect metric changes and anomalies over time. Compares current period vs previous period and flags significant drops or spikes. Use when the user asks about trends, changes, what's different this week, etc.",
      parameters: {
        type: "object",
        properties: {
          metric: { type: "string", enum: ["visitors", "sessions", "pageviews", "revenue", "identified", "bounceRate"], description: "Metric to analyze (default: visitors)" },
          days: { type: "number", description: "Time window in days (default 30)" },
          compareWithPrevious: { type: "boolean", description: "Compare with the previous period (default true)" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page_content",
      description: "Fetch a page from the user's website and extract its structure: headings, sections, CTAs, forms, testimonials, images, navigation, and overall layout. ALWAYS use this before recommending page-level changes so you know what's actually on the page. You can call this for multiple pages.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to fetch (e.g. https://example.com/pricing)" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_cro_skill",
      description: "Load a CRO expert skill to get deep domain knowledge for your analysis. ALWAYS call this before giving recommendations on a CRO topic. You can load multiple skills per turn.",
      parameters: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            enum: [
              "page-cro", "signup-flow-cro", "form-cro", "popup-cro",
              "churn-prevention", "marketing-psychology", "paywall-upgrade-cro",
              "onboarding-cro", "email-sequence", "ab-test-setup",
              "pricing-strategy", "copywriting", "analytics-tracking",
            ],
            description: "The CRO skill to load. Pick the most relevant skill(s) for the user's question.",
          },
        },
        required: ["skill_name"],
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

// ─── CRO Tool Executors ─────────────────────────────────────────────

async function executeAnalyzeFunnel(projectId: string, args: any) {
  const steps: Array<{ type: string; value: string }> = args.steps || [];
  const days = args.days || 30;
  if (steps.length < 2) return { error: "Need at least 2 steps for a funnel" };

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const pid = new mongoose.Types.ObjectId(projectId);

  const stepResults: Array<{ step: string; type: string; visitors: number; conversionFromPrev: number; conversionFromFirst: number }> = [];
  let prevVisitorSet: Set<string> | null = null;
  let firstCount = 0;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    let visitorIds: string[] = [];

    if (s.type === "pageview") {
      visitorIds = await PageView.distinct("visitorId", { projectId, url: { $regex: s.value, $options: "i" }, timestamp: { $gte: since } });
    } else if (s.type === "click") {
      const events = await TrackEvent.find({ projectId, name: "click", timestamp: { $gte: since } }).select("visitorId properties").lean();
      const lower = s.value.toLowerCase();
      visitorIds = [...new Set(events.filter((e: any) => (e.properties as any)?.text?.toLowerCase().includes(lower)).map((e: any) => e.visitorId))];
    } else if (s.type === "form_submit") {
      const events = await TrackEvent.find({ projectId, name: "form_submit", timestamp: { $gte: since } }).select("visitorId properties").lean();
      const lower = s.value.toLowerCase();
      visitorIds = [...new Set(events.filter((e: any) => {
        const fid = (e.properties as any)?.formId || (e.properties as any)?.action || "";
        return fid.toLowerCase().includes(lower);
      }).map((e: any) => e.visitorId))];
    } else {
      visitorIds = await TrackEvent.distinct("visitorId", { projectId, name: { $regex: s.value, $options: "i" }, timestamp: { $gte: since } });
    }

    let currentSet = new Set(visitorIds);
    if (prevVisitorSet) {
      currentSet = new Set([...currentSet].filter((id) => prevVisitorSet!.has(id)));
    }

    if (i === 0) firstCount = currentSet.size;
    const convFromPrev = i === 0 ? 100 : (prevVisitorSet && prevVisitorSet.size > 0 ? Math.round((currentSet.size / prevVisitorSet.size) * 1000) / 10 : 0);
    const convFromFirst = firstCount > 0 ? Math.round((currentSet.size / firstCount) * 1000) / 10 : 0;

    stepResults.push({
      step: `${s.type}: ${s.value}`,
      type: s.type,
      visitors: currentSet.size,
      conversionFromPrev: convFromPrev,
      conversionFromFirst: convFromFirst,
    });

    prevVisitorSet = currentSet;
  }

  let biggestDropIdx = 0;
  let biggestDrop = 0;
  for (let i = 1; i < stepResults.length; i++) {
    const drop = 100 - stepResults[i].conversionFromPrev;
    if (drop > biggestDrop) { biggestDrop = drop; biggestDropIdx = i; }
  }

  return {
    steps: stepResults,
    overallConversion: stepResults.length > 0 ? stepResults[stepResults.length - 1].conversionFromFirst : 0,
    biggestDropOff: stepResults[biggestDropIdx]?.step || "",
    biggestDropOffRate: biggestDrop,
    days,
    summary: `Funnel: ${stepResults[0]?.visitors || 0} entered → ${stepResults[stepResults.length - 1]?.visitors || 0} completed (${stepResults[stepResults.length - 1]?.conversionFromFirst || 0}% conversion). Biggest drop: ${stepResults[biggestDropIdx]?.step} (-${biggestDrop.toFixed(1)}%)`,
  };
}

async function executeAnalyzeTrafficSources(projectId: string, args: any) {
  const days = args.days || 30;
  const goal = args.conversionGoal || "identified";
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const pid = new mongoose.Types.ObjectId(projectId);

  const goalCondition = goal === "purchased"
    ? { $gt: ["$totalRevenue", 0] }
    : goal === "returned"
      ? { $gt: ["$totalSessions", 1] }
      : { $ne: ["$email", null] };

  const sources = await Visitor.aggregate([
    { $match: { projectId: pid, firstSeenAt: { $gte: since } } },
    {
      $group: {
        _id: { source: { $ifNull: ["$firstUtmSource", "direct"] }, referrer: { $ifNull: ["$firstReferrer", "direct"] } },
        total: { $sum: 1 },
        converted: { $sum: { $cond: [goalCondition, 1, 0] } },
        revenue: { $sum: "$totalRevenue" },
        avgPageviews: { $avg: "$totalPageviews" },
        avgSessions: { $avg: "$totalSessions" },
      },
    },
    { $sort: { total: -1 } },
    { $limit: 15 },
  ]);

  const results = sources.map((s: any) => {
    const name = s._id.source !== "direct" ? s._id.source : s._id.referrer;
    return {
      source: name,
      visitors: s.total,
      converted: s.converted,
      conversionRate: s.total > 0 ? Math.round((s.converted / s.total) * 1000) / 10 : 0,
      revenue: s.revenue || 0,
      avgPageviews: Math.round((s.avgPageviews || 0) * 10) / 10,
      avgSessions: Math.round((s.avgSessions || 0) * 10) / 10,
    };
  });

  return {
    sources: results,
    conversionGoal: goal,
    days,
    summary: `${results.length} traffic sources analyzed. Top converter: ${results.sort((a, b) => b.conversionRate - a.conversionRate)[0]?.source || "N/A"} (${results[0]?.conversionRate || 0}%). Highest volume: ${sources[0]?._id?.source || "N/A"} (${sources[0]?.total || 0} visitors).`,
  };
}

async function executeAnalyzePagePerformance(projectId: string, args: any) {
  const days = args.days || 30;
  const limit = args.limit || 15;
  const sortBy = args.sortBy || "pageviews";
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const pid = new mongoose.Types.ObjectId(projectId);

  const [pageMetrics, exitCounts] = await Promise.all([
    PageView.aggregate([
      { $match: { projectId: pid, timestamp: { $gte: since } } },
      {
        $group: {
          _id: "$url",
          pageviews: { $sum: 1 },
          uniqueVisitors: { $addToSet: "$visitorId" },
          avgDuration: { $avg: { $ifNull: ["$duration", 0] } },
          avgScrollDepth: { $avg: { $ifNull: ["$scrollDepth", 0] } },
        },
      },
      { $addFields: { uniqueCount: { $size: "$uniqueVisitors" } } },
      { $project: { uniqueVisitors: 0 } },
      { $sort: { [sortBy === "avgDuration" ? "avgDuration" : sortBy === "avgScrollDepth" ? "avgScrollDepth" : "pageviews"]: -1 } },
      { $limit: limit * 2 },
    ]),
    Session.aggregate([
      { $match: { projectId: pid, startedAt: { $gte: since }, exitPage: { $ne: null } } },
      { $group: { _id: "$exitPage", exits: { $sum: 1 } } },
    ]),
  ]);

  const exitMap = new Map(exitCounts.map((e: any) => [e._id, e.exits]));
  const totalSessions = exitCounts.reduce((sum: number, e: any) => sum + e.exits, 0);

  let pages = pageMetrics.map((p: any) => ({
    url: p._id,
    pageviews: p.pageviews,
    uniqueVisitors: p.uniqueCount,
    avgDuration: Math.round(p.avgDuration || 0),
    avgScrollDepth: Math.round(p.avgScrollDepth || 0),
    exits: exitMap.get(p._id) || 0,
    exitRate: totalSessions > 0 ? Math.round(((exitMap.get(p._id) || 0) / Math.max(p.pageviews, 1)) * 1000) / 10 : 0,
  }));

  if (sortBy === "exits") pages.sort((a: any, b: any) => b.exitRate - a.exitRate);
  pages = pages.slice(0, limit);

  return { pages, days, sortBy, summary: `${pages.length} pages analyzed. Highest exit rate: ${pages.sort((a: any, b: any) => b.exitRate - a.exitRate)[0]?.url || "N/A"} (${pages[0]?.exitRate || 0}%).` };
}

async function executeCompareSegments(projectId: string, args: any) {
  const pid = new mongoose.Types.ObjectId(projectId);

  async function getSegmentStats(filters: any, label: string) {
    const where: any = { projectId: pid };
    if (filters.device) where.device = filters.device.toLowerCase();
    if (filters.browser) where.browser = { $regex: filters.browser, $options: "i" };
    if (filters.country) where.countryCode = filters.country.toUpperCase();
    if (filters.identified === "true") where.email = { $ne: null };
    else if (filters.identified === "false") where.email = null;
    if (filters.hasRevenue === "true") where.totalRevenue = { $gt: 0 };

    const agg = await Visitor.aggregate([
      { $match: where },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          identified: { $sum: { $cond: [{ $ne: ["$email", null] }, 1, 0] } },
          paid: { $sum: { $cond: [{ $gt: ["$totalRevenue", 0] }, 1, 0] } },
          revenue: { $sum: "$totalRevenue" },
          avgPageviews: { $avg: "$totalPageviews" },
          avgSessions: { $avg: "$totalSessions" },
          avgEvents: { $avg: "$totalEvents" },
        },
      },
    ]);
    const d = agg[0] || {};
    return {
      label,
      visitors: d.total || 0,
      identifiedRate: d.total > 0 ? Math.round((d.identified / d.total) * 1000) / 10 : 0,
      paidRate: d.total > 0 ? Math.round((d.paid / d.total) * 1000) / 10 : 0,
      totalRevenue: d.revenue || 0,
      avgRevenuePerVisitor: d.total > 0 ? Math.round((d.revenue || 0) / d.total) : 0,
      avgPageviews: Math.round((d.avgPageviews || 0) * 10) / 10,
      avgSessions: Math.round((d.avgSessions || 0) * 10) / 10,
      avgEvents: Math.round((d.avgEvents || 0) * 10) / 10,
    };
  }

  const [a, b] = await Promise.all([
    getSegmentStats(args.segmentA || {}, args.labelA || "Segment A"),
    getSegmentStats(args.segmentB || {}, args.labelB || "Segment B"),
  ]);

  const identDelta = a.identifiedRate - b.identifiedRate;
  const paidDelta = a.paidRate - b.paidRate;

  return {
    segmentA: a,
    segmentB: b,
    deltas: {
      identifiedRate: Math.round(identDelta * 10) / 10,
      paidRate: Math.round(paidDelta * 10) / 10,
      avgPageviews: Math.round((a.avgPageviews - b.avgPageviews) * 10) / 10,
      avgSessions: Math.round((a.avgSessions - b.avgSessions) * 10) / 10,
    },
    summary: `${a.label} (${a.visitors} visitors, ${a.identifiedRate}% identified) vs ${b.label} (${b.visitors} visitors, ${b.identifiedRate}% identified). Identification gap: ${identDelta > 0 ? "+" : ""}${identDelta.toFixed(1)}pp.`,
  };
}

async function executeFindDropOffs(projectId: string, args: any) {
  const days = args.days || 30;
  const limit = args.limit || 10;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const pid = new mongoose.Types.ObjectId(projectId);

  const [exitPages, pageEngagement] = await Promise.all([
    Session.aggregate([
      { $match: { projectId: pid, startedAt: { $gte: since }, exitPage: { $ne: null } } },
      { $group: { _id: "$exitPage", exits: { $sum: 1 }, totalSessions: { $sum: 1 } } },
      { $sort: { exits: -1 } },
      { $limit: limit * 2 },
    ]),
    PageView.aggregate([
      { $match: { projectId: pid, timestamp: { $gte: since } } },
      {
        $group: {
          _id: "$url",
          pageviews: { $sum: 1 },
          avgDuration: { $avg: { $ifNull: ["$duration", 0] } },
          avgScrollDepth: { $avg: { $ifNull: ["$scrollDepth", 0] } },
        },
      },
    ]),
  ]);

  const engMap = new Map(pageEngagement.map((p: any) => [p._id, p]));
  const totalExits = exitPages.reduce((sum: number, e: any) => sum + e.exits, 0);

  const dropOffs = exitPages.map((ep: any) => {
    const eng = engMap.get(ep._id) || {};
    return {
      page: ep._id,
      exits: ep.exits,
      exitShare: totalExits > 0 ? Math.round((ep.exits / totalExits) * 1000) / 10 : 0,
      exitRate: (eng as any).pageviews > 0 ? Math.round((ep.exits / (eng as any).pageviews) * 1000) / 10 : 0,
      pageviews: (eng as any).pageviews || 0,
      avgDuration: Math.round((eng as any).avgDuration || 0),
      avgScrollDepth: Math.round((eng as any).avgScrollDepth || 0),
    };
  }).sort((a: any, b: any) => b.exitRate - a.exitRate).slice(0, limit);

  return {
    dropOffs,
    days,
    summary: `Top ${dropOffs.length} drop-off pages. #1: ${dropOffs[0]?.page || "N/A"} (${dropOffs[0]?.exitRate || 0}% exit rate, ${dropOffs[0]?.exits} exits). Low-engagement pages indicate friction.`,
  };
}

async function executeAnalyzeBehaviorPatterns(projectId: string, args: any) {
  const goal = args.conversionGoal || "identified";
  const days = args.days || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const pid = new mongoose.Types.ObjectId(projectId);

  const goalMatch = goal === "purchased"
    ? { totalRevenue: { $gt: 0 } }
    : goal === "returned"
      ? { totalSessions: { $gt: 1 } }
      : { email: { $ne: null } };
  const nonGoalMatch = goal === "purchased"
    ? { $or: [{ totalRevenue: 0 }, { totalRevenue: null }] }
    : goal === "returned"
      ? { totalSessions: { $lte: 1 } }
      : { email: null };

  const [converters, nonConverters] = await Promise.all([
    Visitor.aggregate([
      { $match: { projectId: pid, firstSeenAt: { $gte: since }, ...goalMatch } },
      {
        $group: {
          _id: null, count: { $sum: 1 },
          avgPageviews: { $avg: "$totalPageviews" }, avgSessions: { $avg: "$totalSessions" },
          avgEvents: { $avg: "$totalEvents" }, avgRevenue: { $avg: "$totalRevenue" },
        },
      },
    ]),
    Visitor.aggregate([
      { $match: { projectId: pid, firstSeenAt: { $gte: since }, ...nonGoalMatch } },
      {
        $group: {
          _id: null, count: { $sum: 1 },
          avgPageviews: { $avg: "$totalPageviews" }, avgSessions: { $avg: "$totalSessions" },
          avgEvents: { $avg: "$totalEvents" }, avgRevenue: { $avg: "$totalRevenue" },
        },
      },
    ]),
  ]);

  const conv = converters[0] || {};
  const nonConv = nonConverters[0] || {};

  const converterIds = await Visitor.distinct("visitorId", { projectId, firstSeenAt: { $gte: since }, ...goalMatch });
  const nonConverterIds = await Visitor.distinct("visitorId", { projectId, firstSeenAt: { $gte: since }, ...nonGoalMatch });

  const [convPages, nonConvPages, convEvents, nonConvEvents] = await Promise.all([
    converterIds.length > 0
      ? PageView.aggregate([
          { $match: { projectId: pid, visitorId: { $in: converterIds.slice(0, 500) }, timestamp: { $gte: since } } },
          { $group: { _id: "$url", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 },
        ])
      : [],
    nonConverterIds.length > 0
      ? PageView.aggregate([
          { $match: { projectId: pid, visitorId: { $in: nonConverterIds.slice(0, 500) }, timestamp: { $gte: since } } },
          { $group: { _id: "$url", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 },
        ])
      : [],
    converterIds.length > 0
      ? TrackEvent.aggregate([
          { $match: { projectId: pid, visitorId: { $in: converterIds.slice(0, 500) }, timestamp: { $gte: since } } },
          { $group: { _id: "$name", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 },
        ])
      : [],
    nonConverterIds.length > 0
      ? TrackEvent.aggregate([
          { $match: { projectId: pid, visitorId: { $in: nonConverterIds.slice(0, 500) }, timestamp: { $gte: since } } },
          { $group: { _id: "$name", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 },
        ])
      : [],
  ]);

  return {
    conversionGoal: goal,
    converters: {
      count: conv.count || 0,
      avgPageviews: Math.round((conv.avgPageviews || 0) * 10) / 10,
      avgSessions: Math.round((conv.avgSessions || 0) * 10) / 10,
      avgEvents: Math.round((conv.avgEvents || 0) * 10) / 10,
      topPages: convPages.map((p: any) => ({ url: p._id, visits: p.count })),
      topEvents: convEvents.map((e: any) => ({ name: e._id, count: e.count })),
    },
    nonConverters: {
      count: nonConv.count || 0,
      avgPageviews: Math.round((nonConv.avgPageviews || 0) * 10) / 10,
      avgSessions: Math.round((nonConv.avgSessions || 0) * 10) / 10,
      avgEvents: Math.round((nonConv.avgEvents || 0) * 10) / 10,
      topPages: nonConvPages.map((p: any) => ({ url: p._id, visits: p.count })),
      topEvents: nonConvEvents.map((e: any) => ({ name: e._id, count: e.count })),
    },
    days,
    summary: `Converters (${conv.count || 0}) avg ${Math.round(conv.avgPageviews || 0)} pages, ${Math.round(conv.avgSessions || 0)} sessions. Non-converters (${nonConv.count || 0}) avg ${Math.round(nonConv.avgPageviews || 0)} pages, ${Math.round(nonConv.avgSessions || 0)} sessions.`,
  };
}

async function executeAnalyzeTrends(projectId: string, args: any) {
  const metric = args.metric || "visitors";
  const days = args.days || 30;
  const compare = args.compareWithPrevious !== false;
  const pid = new mongoose.Types.ObjectId(projectId);

  const currentStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const previousStart = new Date(Date.now() - days * 2 * 24 * 60 * 60 * 1000);

  async function getDailyMetric(since: Date, until: Date) {
    if (metric === "visitors" || metric === "identified") {
      const matchField = metric === "identified" ? { email: { $ne: null } } : {};
      return Visitor.aggregate([
        { $match: { projectId: pid, firstSeenAt: { $gte: since, $lt: until }, ...matchField } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$firstSeenAt" } }, value: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]);
    } else if (metric === "sessions" || metric === "bounceRate") {
      const sessions = await Session.aggregate([
        { $match: { projectId: pid, startedAt: { $gte: since, $lt: until } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$startedAt" } },
            count: { $sum: 1 },
            bounced: { $sum: { $cond: [{ $lte: ["$pageviews", 1] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]);
      return sessions.map((s: any) => ({
        _id: s._id,
        value: metric === "bounceRate" ? (s.count > 0 ? Math.round((s.bounced / s.count) * 1000) / 10 : 0) : s.count,
      }));
    } else if (metric === "pageviews") {
      return PageView.aggregate([
        { $match: { projectId: pid, timestamp: { $gte: since, $lt: until } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } }, value: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]);
    } else if (metric === "revenue") {
      return Visitor.aggregate([
        { $match: { projectId: pid, firstSeenAt: { $gte: since, $lt: until }, totalRevenue: { $gt: 0 } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$firstSeenAt" } }, value: { $sum: "$totalRevenue" } } },
        { $sort: { _id: 1 } },
      ]);
    }
    return [];
  }

  const now = new Date();
  const [currentDaily, previousDaily] = await Promise.all([
    getDailyMetric(currentStart, now),
    compare ? getDailyMetric(previousStart, currentStart) : Promise.resolve([]),
  ]);

  const currentTotal = currentDaily.reduce((s: number, d: any) => s + (d.value || 0), 0);
  const previousTotal = previousDaily.reduce((s: number, d: any) => s + (d.value || 0), 0);
  const isBounceRate = metric === "bounceRate";
  const currentAvg = currentDaily.length > 0 ? Math.round((currentTotal / currentDaily.length) * 10) / 10 : 0;
  const previousAvg = previousDaily.length > 0 ? Math.round((previousTotal / previousDaily.length) * 10) / 10 : 0;

  const changePercent = isBounceRate
    ? (previousAvg > 0 ? Math.round(((currentAvg - previousAvg) / previousAvg) * 1000) / 10 : 0)
    : (previousTotal > 0 ? Math.round(((currentTotal - previousTotal) / previousTotal) * 1000) / 10 : 0);

  const alerts: string[] = [];
  if (Math.abs(changePercent) > 20) {
    alerts.push(`${metric} ${changePercent > 0 ? "increased" : "decreased"} by ${Math.abs(changePercent)}% vs previous period`);
  }

  const dailyValues = currentDaily.map((d: any) => d.value || 0);
  if (dailyValues.length >= 3) {
    const last3avg = dailyValues.slice(-3).reduce((s: number, v: number) => s + v, 0) / 3;
    const overallAvg = currentAvg;
    if (overallAvg > 0 && Math.abs((last3avg - overallAvg) / overallAvg) > 0.3) {
      alerts.push(`Last 3 days ${last3avg > overallAvg ? "above" : "below"} average — ${last3avg > overallAvg ? "positive spike" : "potential issue"}`);
    }
  }

  return {
    metric,
    days,
    current: { total: isBounceRate ? currentAvg : currentTotal, dailyAvg: currentAvg, dataPoints: currentDaily.map((d: any) => ({ date: d._id, value: d.value })) },
    previous: compare ? { total: isBounceRate ? previousAvg : previousTotal, dailyAvg: previousAvg } : null,
    changePercent,
    alerts,
    summary: `${metric} (${days}d): ${isBounceRate ? currentAvg + "%" : currentTotal}. ${compare ? `vs previous: ${changePercent > 0 ? "+" : ""}${changePercent}%.` : ""} ${alerts.length ? "⚠ " + alerts.join(". ") : "No anomalies detected."}`,
  };
}

// ─── Page Content Fetcher ────────────────────────────────────────────

async function executeFetchPageContent(url: string): Promise<object> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "SegmentorBot/1.0 (CRO Analysis)" },
    });
    clearTimeout(timeout);

    if (!res.ok) return { error: `Failed to fetch ${url}: HTTP ${res.status}` };

    const html = await res.text();
    const root = parseHTML(html, { comment: false });

    const getText = (selector: string) =>
      root.querySelectorAll(selector).map((el) => el.text.trim()).filter((t) => t.length > 0 && t.length < 300);

    const headings = root.querySelectorAll("h1, h2, h3").map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: el.text.trim().slice(0, 200),
    })).filter((h) => h.text.length > 0);

    const links = root.querySelectorAll("a[href]").map((el) => ({
      text: el.text.trim().slice(0, 100),
      href: el.getAttribute("href") || "",
    })).filter((l) => l.text.length > 0);

    const ctaButtons = root.querySelectorAll("button, a.button, [class*='cta'], [class*='btn'], [role='button']").map((el) => el.text.trim().slice(0, 100)).filter((t) => t.length > 0);

    const forms = root.querySelectorAll("form").map((form) => {
      const inputs = form.querySelectorAll("input, select, textarea").map((inp) => ({
        type: inp.getAttribute("type") || inp.tagName.toLowerCase(),
        name: inp.getAttribute("name") || inp.getAttribute("placeholder") || "",
      }));
      const submitBtn = form.querySelector("button[type='submit'], input[type='submit']");
      return {
        action: form.getAttribute("action") || "",
        fields: inputs.slice(0, 15),
        submitText: submitBtn?.text?.trim() || submitBtn?.getAttribute("value") || "",
      };
    });

    const images = root.querySelectorAll("img[alt]").map((img) => ({
      alt: (img.getAttribute("alt") || "").slice(0, 100),
      src: (img.getAttribute("src") || "").slice(0, 200),
    })).filter((i) => i.alt.length > 0).slice(0, 20);

    const metaDesc = root.querySelector("meta[name='description']")?.getAttribute("content") || "";
    const title = root.querySelector("title")?.text?.trim() || "";

    const testimonialKeywords = ["testimonial", "review", "quote", "customer-story", "social-proof", "said", "rating", "stars"];
    const hasTestimonials = testimonialKeywords.some((kw) =>
      html.toLowerCase().includes(kw)
    );
    const testimonialSections = root.querySelectorAll("[class*='testimonial'], [class*='review'], [class*='quote'], [class*='social-proof'], blockquote").map((el) => el.text.trim().slice(0, 200)).filter((t) => t.length > 10).slice(0, 5);

    const pricingSections = root.querySelectorAll("[class*='pricing'], [class*='plan'], [class*='tier']");
    const hasPricing = pricingSections.length > 0 || html.toLowerCase().includes("pricing") && (html.includes("$") || html.includes("€") || html.toLowerCase().includes("/month") || html.toLowerCase().includes("/year"));

    const faqSections = root.querySelectorAll("[class*='faq'], [class*='accordion'], details");
    const hasFAQ = faqSections.length > 0;

    const hasVideo = root.querySelectorAll("video, iframe[src*='youtube'], iframe[src*='vimeo'], iframe[src*='loom'], [class*='video']").length > 0;

    const navLinks = root.querySelectorAll("nav a, header a").map((el) => el.text.trim()).filter((t) => t.length > 0 && t.length < 50).slice(0, 15);

    const footerLinks = root.querySelectorAll("footer a").map((el) => el.text.trim()).filter((t) => t.length > 0 && t.length < 50).slice(0, 15);

    const bodyText = root.querySelector("body")?.text || "";
    const wordCount = bodyText.split(/\s+/).filter((w) => w.length > 0).length;

    return {
      url,
      title,
      metaDescription: metaDesc.slice(0, 300),
      wordCount,
      structure: {
        headings: headings.slice(0, 20),
        ctaButtons: [...new Set(ctaButtons)].slice(0, 15),
        forms,
        images: images.slice(0, 15),
        links: links.slice(0, 30),
      },
      pageElements: {
        hasTestimonials,
        testimonialExcerpts: testimonialSections,
        hasPricing,
        hasFAQ,
        hasVideo,
        navigation: [...new Set(navLinks)],
        footer: [...new Set(footerLinks)],
      },
    };
  } catch (err: any) {
    if (err.name === "AbortError") return { error: `Timeout fetching ${url} (10s limit)` };
    return { error: `Failed to fetch ${url}: ${err.message}` };
  }
}

// ─── CRO Skill Loader ───────────────────────────────────────────────

const VALID_SKILL_NAMES = new Set(SKILL_CATALOG.map((s) => s.name));

async function executeLoadCroSkill(skillName: string): Promise<object> {
  if (!VALID_SKILL_NAMES.has(skillName)) {
    return { error: `Unknown skill: ${skillName}. Available: ${[...VALID_SKILL_NAMES].join(", ")}` };
  }
  try {
    const filePath = join(SKILLS_DIR, `${skillName}.md`);
    const content = await readFile(filePath, "utf-8");
    return { skill: skillName, content };
  } catch (err: any) {
    return { error: `Failed to load skill ${skillName}: ${err.message}` };
  }
}

// ─── Context Builder ────────────────────────────────────────────────

async function buildSystemPrompt(projectId: string, userQuery: string) {
  const projectIdObj = new mongoose.Types.ObjectId(projectId);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [visitorFacets, trackEventFacets, topPagesRaw, recentClicks, recentForms, samplePages, totalCount, identifiedCount, paidCount, conversionAgg, topSourcesAgg, topExitPagesAgg, deviceSplitAgg, projectDoc] = await Promise.all([
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
    Visitor.aggregate([
      { $match: { projectId: projectIdObj } },
      { $group: { _id: null, revenue: { $sum: "$totalRevenue" }, totalPV: { $sum: "$totalPageviews" }, totalSess: { $sum: "$totalSessions" } } },
    ]),
    Visitor.aggregate([
      { $match: { projectId: projectIdObj, firstSeenAt: { $gte: thirtyDaysAgo } } },
      { $group: { _id: { $ifNull: ["$firstUtmSource", "$firstReferrer"] }, total: { $sum: 1 }, identified: { $sum: { $cond: [{ $ne: ["$email", null] }, 1, 0] } }, revenue: { $sum: "$totalRevenue" } } },
      { $sort: { total: -1 } },
      { $limit: 5 },
    ]),
    Session.aggregate([
      { $match: { projectId: projectIdObj, startedAt: { $gte: thirtyDaysAgo }, exitPage: { $ne: null } } },
      { $group: { _id: "$exitPage", exits: { $sum: 1 } } },
      { $sort: { exits: -1 } },
      { $limit: 5 },
    ]),
    Visitor.aggregate([
      { $match: { projectId: projectIdObj } },
      { $group: { _id: { $toLower: { $ifNull: ["$device", "unknown"] } }, count: { $sum: 1 }, identified: { $sum: { $cond: [{ $ne: ["$email", null] }, 1, 0] } }, paid: { $sum: { $cond: [{ $gt: ["$totalRevenue", 0] }, 1, 0] } } } },
      { $sort: { count: -1 } },
    ]),
    Project.findById(projectId).select("name siteUrl").lean(),
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

  const cAgg = conversionAgg[0] || {};
  const totalRevenue30d = cAgg.revenue || 0;
  const sourcesStr = topSourcesAgg.map((s: any) => {
    const name = s._id || "direct";
    const convRate = s.total > 0 ? ((s.identified / s.total) * 100).toFixed(1) : "0";
    return `${name}: ${s.total} visitors, ${convRate}% identified, $${((s.revenue || 0) / 100).toFixed(0)} rev`;
  }).join("; ") || "no data";
  const exitPagesStr = topExitPagesAgg.map((p: any) => `${p._id} (${p.exits} exits)`).join(", ") || "no data";
  const deviceStr = deviceSplitAgg.map((d: any) => {
    const convRate = d.count > 0 ? ((d.identified / d.count) * 100).toFixed(1) : "0";
    return `${d._id}: ${d.count} visitors, ${convRate}% identified`;
  }).join("; ") || "no data";

  const siteUrl = (projectDoc as any)?.siteUrl || "";
  const projectName = (projectDoc as any)?.name || "";

  let conversionContext = `\n\nPROJECT:
- Name: ${projectName}
- Site URL: ${siteUrl}

CONVERSION CONTEXT (last 30 days):
- Revenue: $${(totalRevenue30d / 100).toFixed(2)}
- Top traffic sources: ${sourcesStr}
- Top exit pages: ${exitPagesStr}
- Device split: ${deviceStr}
- Known pages: ${pageUrls.slice(0, 30).join(", ") || "no pages tracked yet"}`;

  const prompt = `You are Segi, a Conversion Rate Optimization (CRO) expert for the Segmentor platform. You analyze visitor data and give specific, actionable recommendations to improve conversions and revenue.

CORE RULES:
1. Never just present numbers. Every insight must include: what the data means, why it matters for conversions, and a specific action to take.
2. Rank recommendations by estimated impact. Lead with the highest-impact action.
3. Use comparative language: "mobile visitors convert at X% vs Y% on desktop — that gap costs you Z visitors/month."
4. When you identify a problem, always give a concrete fix: "Add a sticky CTA on /pricing" not "consider improving the page."
5. Proactively use your CRO tools (analyze_funnel, analyze_traffic_sources, find_drop_offs, etc.) to get real data before making recommendations. Do not guess.

CRO SKILLS AVAILABLE:
You have access to deep CRO expertise via the load_cro_skill tool. ALWAYS load relevant skill(s) before giving CRO recommendations. Available skills:
${SKILL_CATALOG.map((s) => `- ${s.name}: ${s.description}`).join("\n")}

SKILL USAGE RULES:
1. When a user asks about any CRO topic, FIRST load the relevant skill(s) before answering.
2. You can load multiple skills in one turn (no limit).
3. Use the skill content as your expert knowledge base — follow its frameworks, benchmarks, and recommendation structures.
4. Combine skill knowledge with the real visitor data from your other tools.

DATA TOOLS:
- Use fetch_page_content to see what's ACTUALLY on a page before recommending changes. This tells you the headings, CTAs, forms, testimonials, pricing sections, videos, FAQ, and layout of any page. ALWAYS use this before suggesting "add X" — the page may already have it.
- Use analyze_funnel to track where visitors drop off in multi-step flows
- Use analyze_traffic_sources to find which channels bring converting visitors vs wasted traffic
- Use analyze_page_performance to find pages losing visitors (high exit rate, low engagement)
- Use find_drop_offs to automatically surface the biggest leaks in the site
- Use analyze_behavior_patterns to discover what converting visitors do differently
- Use compare_segments to compare mobile vs desktop, countries, or any two groups
- Use analyze_trends to detect metric changes and anomalies over time
- Use filter_visitors to find specific visitor segments
- Use query_visitor_stats for aggregate breakdowns
- Use get_visitor_details for individual visitor profiles (anonymous visitors have names like "keen rabbit")
- Use clear_filters when asked to reset/clear/show all visitors
- After export_visitors, do NOT include download links — the UI shows a download button

CRITICAL RULE - PAGE AWARENESS:
Before recommending ANY page-level changes (add testimonials, add CTA, change headline, add FAQ, etc.), you MUST first call fetch_page_content on the relevant page(s). This prevents you from suggesting things that already exist. When analyzing a full website, fetch the homepage and top pages first.

AVAILABLE DATA CONTEXT:
- Total visitors: ${totalCount}
- Identified visitors: ${identifiedCount} (${totalCount > 0 ? ((identifiedCount / totalCount) * 100).toFixed(1) : 0}%)
- Paid customers: ${paidCount} (${totalCount > 0 ? ((paidCount / totalCount) * 100).toFixed(1) : 0}%)
- Today's date: ${new Date().toISOString().split("T")[0]}

Available filter values:
- Countries: ${filterOptions.countries.join(", ") || "none"}
- Devices: ${filterOptions.devices.join(", ") || "none"}
- Browsers: ${filterOptions.browsers.join(", ") || "none"}
- OS: ${filterOptions.os.join(", ") || "none"}
- Languages: ${filterOptions.languages.join(", ") || "none"}
- Referrers: ${filterOptions.referrers.join(", ") || "none"}
- UTM Sources: ${filterOptions.utmSources.join(", ") || "none"}

Tracked event types: ${eventNames.length ? eventNames.join(", ") : "none"}
Click labels: ${clickLabels.length ? clickLabels.join(", ") : "none"}
Form IDs: ${formIds.length ? formIds.join(", ") : "none"}
Page URLs: ${pageUrls.slice(0, 30).join(", ") || "none"}

EVENT DATA MODEL:
- Click events: name="click", label in properties.text
- Form submissions: name="form_submit", form ID in properties.formId
- Custom events: unique name
- Page views: separate table with url field

When using filter_visitors with events, use the "label" field for clicks/form_submit. Fuzzy matching is applied.${conversionContext}${relevantSection}${sampleSection}${samplePageSection}`;

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

  let recordingContext = "";
  let isRecordingConversation = false;
  try {
    const conv = await SegiConversation.findById(conversationId).lean() as any;
    if (conv?.recordingSessionId) {
      isRecordingConversation = true;
      const rec = await Recording.findOne({ projectId, sessionId: conv.recordingSessionId }).lean() as any;
      if (rec) {
        const [visitor, pageViews] = await Promise.all([
          Visitor.findOne(
            { projectId, visitorId: rec.visitorId },
            { visitorId: 1, email: 1, name: 1, country: 1, device: 1, browser: 1, os: 1 },
          ).lean() as any,
          PageView.find({ projectId, visitorId: rec.visitorId })
            .sort({ timestamp: -1 })
            .limit(30)
            .select("url title")
            .lean(),
        ]);
        const visitorName = visitor?.name || visitor?.email || friendlyName(rec.visitorId);
        const pageUrls = pageViews.map((p: any) => p.url).filter(Boolean);
        const durationSec = Math.round((rec.duration || 0) / 1000);

        recordingContext = `\n\n--- SESSION RECORDING CONTEXT ---
This conversation is about a specific session recording.

Visitor: ${visitorName}
Country: ${rec.country || visitor?.country || "Unknown"}
Device: ${rec.device || visitor?.device || "Unknown"}
Browser: ${rec.browser || visitor?.browser || "Unknown"}
OS: ${rec.os || visitor?.os || "Unknown"}
Session duration: ${durationSec}s
Clicks: ${rec.clickCount || 0}
Pages in session: ${rec.pageCount || 0}
Entry URL: ${rec.entryUrl || "Unknown"}
Recent pages visited: ${pageUrls.length ? pageUrls.join(" → ") : "Unknown"}
Started at: ${rec.startedAt ? new Date(rec.startedAt).toISOString() : "Unknown"}
Ended at: ${rec.endedAt ? new Date(rec.endedAt).toISOString() : "Unknown"}
${rec.journeySummary ? `Previous AI summary: ${rec.journeySummary}` : ""}

IMPORTANT: When the user asks you to summarize or analyze this recording, you MUST respond with ONLY a valid JSON object (no markdown, no code fences, no extra text) matching this exact schema:
{
  "metadata": {
    "visitor": "string (visitor name)",
    "location": "string (country/region)",
    "device": "string (device info)",
    "browser": "string (browser name)",
    "date": "string (readable date)",
    "verdict": "string (short verdict label e.g. 'Interested but hesitant')",
    "verdictType": "positive" | "warning" | "negative"
  },
  "activityOverview": {
    "sessions": number,
    "pageviews": number,
    "rageClicks": number,
    "timeOnSite": "string (e.g. '2m 30s')"
  },
  "frictionScore": {
    "score": number (0-100),
    "level": "low" | "medium" | "high",
    "description": "string (explanation)"
  },
  "frictionPoints": [
    { "severity": "red" | "orange" | "yellow", "text": "string" }
  ],
  "visitorJourney": ["page1", "page2", "..."],
  "recommendations": [
    { "title": "string", "description": "string" }
  ],
  "verdict": {
    "summary": "string (one-paragraph conclusion)"
  }
}

For follow-up questions about the recording, respond normally in text.
--- END RECORDING CONTEXT ---`;
      }
    }
  } catch { /* recording context is optional, don't block chat */ }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt + recordingContext },
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
      console.log(`[Segi] Stream started for ${conversationId}${isRecordingConversation ? " (recording)" : ""}`);

      let continueLoop = true;
      let iterations = 0;

      while (continueLoop && !disconnected) {
        if (++iterations > MAX_TOOL_ITERATIONS) {
          console.warn("[Segi] Tool-call loop limit reached");
          break;
        }

        const userMsgCount = messages.filter((m) => m.role === "user").length;
        const isRecordingAnalysis = isRecordingConversation && userMsgCount <= 1;

        const response = isRecordingConversation
          ? await client.chat.completions.create({
              model: deployment,
              messages,
              temperature: 0.3,
              max_tokens: 2500,
              stream: true,
              ...(isRecordingAnalysis ? { response_format: { type: "json_object" as const } } : {}),
            })
          : await client.chat.completions.create({
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
          console.log(`[Segi] AI response: ${currentText.length} chars, tools: ${hasToolCalls}`);
          if (currentText) {
            await SegiMessage.create({
              conversationId: conversationId!,
              role: "assistant",
              content: currentText,
            });
          } else {
            console.warn("[Segi] AI returned empty response");
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
              } else if (tc.name === "analyze_funnel") {
                toolResult = await executeAnalyzeFunnel(projectId, parsedArgs);
              } else if (tc.name === "analyze_traffic_sources") {
                toolResult = await executeAnalyzeTrafficSources(projectId, parsedArgs);
              } else if (tc.name === "analyze_page_performance") {
                toolResult = await executeAnalyzePagePerformance(projectId, parsedArgs);
              } else if (tc.name === "compare_segments") {
                toolResult = await executeCompareSegments(projectId, parsedArgs);
              } else if (tc.name === "find_drop_offs") {
                toolResult = await executeFindDropOffs(projectId, parsedArgs);
              } else if (tc.name === "analyze_behavior_patterns") {
                toolResult = await executeAnalyzeBehaviorPatterns(projectId, parsedArgs);
              } else if (tc.name === "analyze_trends") {
                toolResult = await executeAnalyzeTrends(projectId, parsedArgs);
              } else if (tc.name === "fetch_page_content") {
                toolResult = await executeFetchPageContent(parsedArgs.url);
              } else if (tc.name === "load_cro_skill") {
                toolResult = await executeLoadCroSkill(parsedArgs.skill_name);
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
      console.error("[Segi] Stream error:", err);
      if (!disconnected) {
        const errMsg = err?.message || err?.error?.message || "An error occurred";
        try { await stream.writeSSE({ event: "error", data: JSON.stringify({ message: errMsg }) }); } catch {}
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
    recordingSessionId: conv.recordingSessionId || null,
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

segi.patch("/projects/:projectId/segi/conversations/:id", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  await requireProjectOwnership(projectId, userId);

  const body = await c.req.json<{ title?: string }>();
  const conv = await SegiConversation.findOne({ _id: id, projectId });
  if (!conv) return c.json({ error: "Conversation not found" }, 404);

  if (body.title !== undefined) {
    conv.title = body.title.trim().slice(0, 200);
    await conv.save();
  }
  return c.json({ id: conv._id, title: conv.title });
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
