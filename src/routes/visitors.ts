import { Hono } from "hono";
import mongoose from "mongoose";
import { requireAuth } from "../auth/middleware.js";
import { requireProjectOwnership } from "../lib/ownership.js";
import {
  Visitor,
  Session,
  PageView,
  TrackEvent,
  Event,
  CustomerEvent,
  SavedSegment,
} from "../db/models.js";
import { AzureOpenAI } from "openai";

type Env = { Variables: { userId: string } };

const visitors = new Hono<Env>();

visitors.use("/*", requireAuth);

function getOpenAIClient(): AzureOpenAI | null {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (!endpoint || !apiKey) return null;
  return new AzureOpenAI({ endpoint, apiKey, apiVersion: "2024-08-01-preview" });
}

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
  const filterVisitorIds = c.req.query("visitorIds") || "";
  const sortBy = c.req.query("sortBy") || "lastSeenAt";
  const sortOrder = c.req.query("sortOrder") === "asc" ? "asc" : "desc";

  const where: Record<string, unknown> = { projectId };

  if (search) {
    where.$or = [
      { email: { $regex: search, $options: "i" } },
      { visitorId: { $regex: search } },
      { city: { $regex: search, $options: "i" } },
      { name: { $regex: search, $options: "i" } },
    ];
  }
  if (filterCountry) {
    where.countryCode = filterCountry.toUpperCase();
  }
  if (filterDevice) {
    where.device = filterDevice.toLowerCase();
  }
  if (filterBrowser) {
    where.browser = { $regex: filterBrowser, $options: "i" };
  }
  if (filterOs) {
    where.os = { $regex: filterOs, $options: "i" };
  }
  if (filterLanguage) {
    where.language = { $regex: filterLanguage, $options: "i" };
  }
  if (filterIdentified === "true") {
    where.email = { $ne: null };
  } else if (filterIdentified === "false") {
    where.email = null;
  }
  if (filterHasRevenue === "true") {
    where.totalRevenue = { $gt: 0 };
  }
  if (filterLive === "true") {
    where.lastSeenAt = { $gte: new Date(Date.now() - 5 * 60 * 1000) };
  }
  if (filterUtmSource) {
    where.firstUtmSource = { $regex: filterUtmSource, $options: "i" };
  }
  if (filterUtmMedium) {
    where.firstUtmMedium = { $regex: filterUtmMedium, $options: "i" };
  }
  if (filterUtmCampaign) {
    where.firstUtmCampaign = { $regex: filterUtmCampaign, $options: "i" };
  }
  if (filterReferrer) {
    where.firstReferrer = { $regex: filterReferrer, $options: "i" };
  }
  if (filterTag) {
    where.tags = filterTag;
  }
  if (filterSeenAfter || filterSeenBefore) {
    const lastSeenFilter: Record<string, Date> = {};
    if (filterSeenAfter) lastSeenFilter.$gte = new Date(filterSeenAfter);
    if (filterSeenBefore) lastSeenFilter.$lte = new Date(filterSeenBefore);
    if (Object.keys(lastSeenFilter).length) where.lastSeenAt = lastSeenFilter;
  }
  if (filterVisitorIds) {
    where.visitorId = { $in: filterVisitorIds.split(",") };
  }

  const allowedSorts = ["lastSeenAt", "firstSeenAt", "totalPageviews", "totalSessions", "totalRevenue", "totalEvents", "email"];
  const orderField = allowedSorts.includes(sortBy) ? sortBy : "lastSeenAt";
  const mongoSort = { [orderField]: sortOrder === "asc" ? 1 : -1 } as Record<string, 1 | -1>;

  const projectOid = new mongoose.Types.ObjectId(projectId);

  const [items, total, aggregates] = await Promise.all([
    Visitor.find(where).sort(mongoSort).skip(skip).limit(limit),
    Visitor.countDocuments(where),
    Visitor.aggregate([
      { $match: { projectId: projectOid } },
      { $group: { _id: null, totalRevenue: { $sum: "$totalRevenue" }, count: { $sum: 1 } } },
    ]),
  ]);

  const agg = aggregates[0];
  const aggTotalRevenue = agg?.totalRevenue ?? 0;
  const aggCount = agg?.count ?? 0;

  const [identifiedCount, paidCount] = await Promise.all([
    Visitor.countDocuments({ projectId, email: { $ne: null } }),
    Visitor.countDocuments({ projectId, totalRevenue: { $gt: 0 } }),
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
      totalVisitors: aggCount,
      identifiedVisitors: identifiedCount,
      paidVisitors: paidCount,
      totalRevenue: aggTotalRevenue,
    },
  });
});

// Distinct filter values for populating dropdowns
visitors.get("/projects/:projectId/visitors/filters", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const filterOptions = await Visitor.aggregate([
    { $match: { projectId: new mongoose.Types.ObjectId(projectId) } },
    {
      $facet: {
        countries: [
          { $group: { _id: { code: "$countryCode", name: "$country" } } },
          { $match: { "_id.code": { $exists: true, $ne: null } } },
          { $sort: { "_id.name": 1 } },
        ],
        languages: [{ $group: { _id: "$language" } }, { $match: { _id: { $ne: null } } }, { $sort: { _id: 1 } }],
        browsers: [{ $group: { _id: "$browser" } }, { $match: { _id: { $ne: null } } }, { $sort: { _id: 1 } }],
        oses: [{ $group: { _id: "$os" } }, { $match: { _id: { $ne: null } } }, { $sort: { _id: 1 } }],
        devices: [{ $group: { _id: "$device" } }, { $match: { _id: { $ne: null } } }, { $sort: { _id: 1 } }],
        referrers: [{ $group: { _id: "$firstReferrer" } }, { $match: { _id: { $ne: null } } }, { $sort: { _id: 1 } }],
        utmSources: [{ $group: { _id: "$firstUtmSource" } }, { $match: { _id: { $ne: null } } }, { $sort: { _id: 1 } }],
        utmMediums: [{ $group: { _id: "$firstUtmMedium" } }, { $match: { _id: { $ne: null } } }, { $sort: { _id: 1 } }],
        utmCampaigns: [{ $group: { _id: "$firstUtmCampaign" } }, { $match: { _id: { $ne: null } } }, { $sort: { _id: 1 } }],
        tags: [{ $unwind: "$tags" }, { $group: { _id: "$tags" } }, { $match: { _id: { $ne: null } } }, { $sort: { _id: 1 } }],
      },
    },
  ]);

  const facet = filterOptions[0] ?? {};
  const mapStr = (arr: { _id: unknown }[]) => [...new Set(arr.map((x) => String(x._id)).filter(Boolean))].sort();
  const mapCountries = (arr: { _id: { code?: string; name?: string } }[]) =>
    [...new Set(arr.map((x) => (x._id?.code ? `${x._id.code}|${x._id.name || x._id.code}` : null)).filter(Boolean))].sort() as string[];
  const mapTags = (arr: { _id: unknown }[]) => [...new Set(arr.map((x) => String(x._id)).filter(Boolean))].sort();

  return c.json({
    countries: mapCountries(facet.countries ?? []),
    languages: mapStr(facet.languages ?? []),
    browsers: mapStr(facet.browsers ?? []),
    os: mapStr(facet.oses ?? []),
    devices: mapStr(facet.devices ?? []),
    referrers: mapStr(facet.referrers ?? []),
    utmSources: mapStr(facet.utmSources ?? []),
    utmMediums: mapStr(facet.utmMediums ?? []),
    utmCampaigns: mapStr(facet.utmCampaigns ?? []),
    tags: mapTags(facet.tags ?? []),
  });
});

// Visitor detail
visitors.get("/projects/:projectId/visitors/:visitorId", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const visitorId = c.req.param("visitorId");
  await requireProjectOwnership(projectId, userId);

  const visitor = await Visitor.findOne({ projectId, visitorId });

  if (!visitor) return c.json({ error: "Visitor not found" }, 404);

  const [recentSessions, purchases] = await Promise.all([
    Session.find({ projectId, visitorId }).sort({ startedAt: -1 }).limit(10),
    CustomerEvent.find({ projectId, visitorId }).sort({ timestamp: -1 }).limit(20),
  ]);

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
    PageView.find({ projectId, visitorId }).sort({ timestamp: -1 }).limit(500),
    TrackEvent.find({ projectId, visitorId }).sort({ timestamp: -1 }).limit(500),
    Event.find({ projectId, visitorId }).sort({ timestamp: -1 }).limit(200),
    CustomerEvent.find({ projectId, visitorId }).sort({ timestamp: -1 }).limit(200),
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
    Session.find({ projectId, visitorId }).sort({ startedAt: -1 }).skip(skip).limit(limit),
    Session.countDocuments({ projectId, visitorId }),
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
    Session.find({ projectId }).sort({ startedAt: -1 }).skip(skip).limit(limit),
    Session.countDocuments({ projectId }),
  ]);

  return c.json({
    sessions,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// ─── AI Natural Language Search ─────────────────────────────────────

visitors.post("/projects/:projectId/visitors/ai-search", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const body = await c.req.json<{ query: string }>();
  const query = body.query?.trim();
  if (!query) return c.json({ error: "Query is required" }, 400);

  const client = getOpenAIClient();
  if (!client) return c.json({ error: "AI search is not configured" }, 503);

  const [allVisitorsAgg, eventNamesRaw, topPagesRaw] = await Promise.all([
    Visitor.aggregate([
      { $match: { projectId: new mongoose.Types.ObjectId(projectId) } },
      {
        $facet: {
          countries: [{ $group: { _id: { code: "$countryCode", name: "$country" } } }],
          languages: [{ $group: { _id: "$language" } }],
          browsers: [{ $group: { _id: "$browser" } }],
          os: [{ $group: { _id: "$os" } }],
          devices: [{ $group: { _id: "$device" } }],
          referrers: [{ $group: { _id: "$firstReferrer" } }],
          utmSources: [{ $group: { _id: "$firstUtmSource" } }],
          utmMediums: [{ $group: { _id: "$firstUtmMedium" } }],
          utmCampaigns: [{ $group: { _id: "$firstUtmCampaign" } }],
          tags: [{ $unwind: "$tags" }, { $group: { _id: "$tags" } }],
        },
      },
    ]),
    TrackEvent.aggregate([
      { $match: { projectId: new mongoose.Types.ObjectId(projectId) } },
      { $group: { _id: "$name" } },
      { $limit: 100 },
    ]),
    PageView.aggregate([
      { $match: { projectId: new mongoose.Types.ObjectId(projectId) } },
      { $group: { _id: "$url" } },
      { $limit: 100 },
    ]),
  ]);

  const eventNames = eventNamesRaw.map((e: { _id: string }) => e._id).filter(Boolean).sort();
  const pageUrls = topPagesRaw.map((p: { _id: string }) => p._id).filter(Boolean).sort();

  const facet = allVisitorsAgg[0] ?? {};
  const mapStr = (arr: { _id: unknown }[]) => [...new Set(arr.map((x) => String(x._id)).filter(Boolean))].sort();
  const mapCountries = (arr: { _id: { code?: string; name?: string } }[]) =>
    [...new Set(arr.map((x) => (x._id?.code ? `${x._id.code} (${x._id.name || x._id.code})` : null)).filter(Boolean))].sort() as string[];
  const mapTags = (arr: { _id: unknown }[]) => [...new Set(arr.map((x) => String(x._id)).filter(Boolean))].sort();

  // Fetch distinct click labels (properties.text) and form IDs for richer context
  const [recentClicks, recentForms] = await Promise.all([
    TrackEvent.find({ projectId, name: "click" }).select("properties").sort({ timestamp: -1 }).limit(500).lean(),
    TrackEvent.find({ projectId, name: "form_submit" }).select("properties").sort({ timestamp: -1 }).limit(200).lean(),
  ]);
  const clickLabels = [...new Set(
    recentClicks.map((e: any) => (e.properties as any)?.text).filter(Boolean)
  )].sort() as string[];
  const formIds = [...new Set(
    recentForms.map((e: any) => (e.properties as any)?.formId || (e.properties as any)?.action).filter(Boolean)
  )].sort() as string[];

  const filterOptions = {
    countries: mapCountries(facet.countries ?? []),
    languages: mapStr(facet.languages ?? []),
    browsers: mapStr(facet.browsers ?? []),
    os: mapStr(facet.os ?? []),
    devices: mapStr(facet.devices ?? []),
    referrers: mapStr(facet.referrers ?? []),
    utmSources: mapStr(facet.utmSources ?? []),
    utmMediums: mapStr(facet.utmMediums ?? []),
    utmCampaigns: mapStr(facet.utmCampaigns ?? []),
    tags: mapTags(facet.tags ?? []),
  };

  const [identifiedCount, paidCount, totalCount] = await Promise.all([
    Visitor.countDocuments({ projectId, email: { $ne: null } }),
    Visitor.countDocuments({ projectId, totalRevenue: { $gt: 0 } }),
    Visitor.countDocuments({ projectId }),
  ]);

  const systemPrompt = `You are a visitor data filter assistant for a website analytics tool.
The user will describe visitors they want to find using natural language. Your job is to:
1. Convert their description into structured filter parameters (JSON).
2. If the query mentions user actions/behavior, return event conditions.
3. Provide a short, helpful insight sentence about their query.

Available filter fields and their valid values:
- country: Country code (2 letters). Available: ${filterOptions.countries.join(", ") || "none"}
- device: ${filterOptions.devices.join(", ") || "none"}
- browser: ${filterOptions.browsers.join(", ") || "none"}
- os: ${filterOptions.os.join(", ") || "none"}
- language: ${filterOptions.languages.join(", ") || "none"}
- identified: "true" (has email) or "false" (anonymous)
- hasRevenue: "true" (paid customers with revenue > 0)
- live: "true" (seen in last 5 minutes)
- utmSource: ${filterOptions.utmSources.join(", ") || "none"}
- utmMedium: ${filterOptions.utmMediums.join(", ") || "none"}
- utmCampaign: ${filterOptions.utmCampaigns.join(", ") || "none"}
- referrer: ${filterOptions.referrers.join(", ") || "none"}
- tag: ${filterOptions.tags.join(", ") || "none"}
- seenAfter: ISO date string (YYYY-MM-DD)
- seenBefore: ISO date string (YYYY-MM-DD)
- search: Free text search across name, email, city, visitorId
- sortBy: one of lastSeenAt, firstSeenAt, totalPageviews, totalSessions, totalRevenue, totalEvents
- sortOrder: "asc" or "desc"

Available tracked event types: ${eventNames.length ? eventNames.join(", ") : "none"}
Available click button/link labels: ${clickLabels.length ? clickLabels.join(", ") : "none"}
Available form IDs: ${formIds.length ? formIds.join(", ") : "none"}
Available page URLs: ${pageUrls.length ? pageUrls.join(", ") : "none"}

IMPORTANT - How events work in our system:
- Click events are stored with name="click" and the button/link text in the "label" field (e.g. "Get Started", "Install Plugin")
- Form submissions are stored with name="form_submit" and the form identifier in the "label" field
- Custom events have a unique name (listed above in event types)
- Page views have a URL

When the user's query refers to actions/behavior, include an "events" array. Each entry should have:
- type: "click" | "form_submit" | "pageview" | "custom"
- label: the button/link text for clicks (MUST match one of the available labels above), or form ID for form_submit. Use fuzzy matching to find the closest label.
- name: only for custom events, the event name
- url: only for pageview events, the page URL (matched to available URLs above)

Examples:
- "users who clicked Get Started" -> events: [{ "type": "click", "label": "Get Started" }]
- "visitors who viewed /pricing" -> events: [{ "type": "pageview", "url": "/pricing" }]
- "users who clicked Install Plugin and then clicked Get Started" -> events: [{ "type": "click", "label": "Install Plugin" }, { "type": "click", "label": "Get Started" }]
Multiple events use AND logic (visitor must have done ALL of them).

Current data context:
- Total visitors: ${totalCount}
- Identified visitors: ${identifiedCount}
- Paid customers: ${paidCount}
- Today's date: ${new Date().toISOString().split("T")[0]}

Respond ONLY with valid JSON in this exact format (no markdown, no code blocks):
{
  "filters": { ... only include filters that match the user's query, omit unused ones ... },
  "events": [ ... only include if the query mentions actions/behavior, e.g. {"type":"click","label":"Get Started"} ... ],
  "insight": "A brief helpful sentence about the filtered audience"
}`;

  try {
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o-mini";
    const response = await client.chat.completions.create({
      model: deployment,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
      ],
      temperature: 0.1,
      max_tokens: 500,
    });

    const content = response.choices[0]?.message?.content?.trim() || "{}";

    let parsed: {
      filters?: Record<string, string>;
      events?: { type: string; name?: string; label?: string; url?: string }[];
      insight?: string;
    };
    try {
      const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { filters: {}, insight: "Could not parse AI response. Try rephrasing your query." };
    }

    let visitorIds: string[] | undefined;

    if (parsed.events?.length) {
      console.log("[AI Search] LLM returned events:", JSON.stringify(parsed.events));

      const idSets = await Promise.all(
        parsed.events.map(async (evt) => {
          let ids: string[] = [];

          if (evt.type === "pageview" && evt.url) {
            ids = await PageView.distinct("visitorId", {
              projectId,
              url: { $regex: evt.url, $options: "i" },
            });
            console.log(`[AI Search] pageview url="${evt.url}" -> ${ids.length} visitors`);
          } else if ((evt.type === "click" || evt.type === "form_submit") && evt.label) {
            const allOfType = await TrackEvent.find({ projectId, name: evt.type })
              .select("visitorId properties")
              .lean();
            const labelLower = evt.label.toLowerCase();
            const matched = allOfType.filter((m) => {
              const text = (m.properties as Record<string, unknown>)?.text;
              return text && String(text).toLowerCase().includes(labelLower);
            });
            ids = [...new Set(matched.map((m) => m.visitorId))];
            console.log(`[AI Search] ${evt.type} label="${evt.label}" -> ${ids.length} visitors (from ${allOfType.length} total)`);
          } else if (evt.name) {
            ids = await TrackEvent.distinct("visitorId", {
              projectId,
              name: { $regex: evt.name, $options: "i" },
            });
            console.log(`[AI Search] custom event name="${evt.name}" -> ${ids.length} visitors`);
          }

          return new Set(ids);
        }),
      );

      if (idSets.length > 0) {
        const intersection = idSets.reduce((acc, set) => {
          return new Set([...acc].filter((id) => set.has(id)));
        });
        visitorIds = [...intersection];
        console.log(`[AI Search] intersection of ${idSets.length} sets -> ${visitorIds.length} visitors`);
      }
    }

    return c.json({
      filters: parsed.filters || {},
      events: parsed.events || [],
      visitorIds: visitorIds || [],
      insight: parsed.insight || "",
      naturalQuery: query,
    });
  } catch (err: any) {
    console.error("AI search error:", err?.message || err);
    return c.json({ error: "AI search failed", message: err?.message }, 500);
  }
});

// ─── Saved Segments CRUD ────────────────────────────────────────────

visitors.get("/projects/:projectId/visitors/segments", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const segments = await SavedSegment.find({ projectId }).sort({ createdAt: -1 });

  return c.json({ segments });
});

visitors.post("/projects/:projectId/visitors/segments", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const body = await c.req.json<{ name: string; naturalQuery: string; filters: Record<string, string> }>();
  if (!body.name?.trim()) return c.json({ error: "Name is required" }, 400);

  const segment = await SavedSegment.create({
    projectId,
    name: body.name.trim(),
    naturalQuery: body.naturalQuery || "",
    filters: body.filters || {},
  });

  return c.json({ segment }, 201);
});

visitors.delete("/projects/:projectId/visitors/segments/:segmentId", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  const segmentId = c.req.param("segmentId");
  await requireProjectOwnership(projectId, userId);

  const segment = await SavedSegment.findOne({ _id: segmentId, projectId });
  if (!segment) return c.json({ error: "Segment not found" }, 404);

  await SavedSegment.findByIdAndDelete(segmentId);
  return c.json({ ok: true });
});

export default visitors;
