import { Hono } from "hono";
import { z } from "zod";
import { getProjectConfig } from "../services/configService.js";
import {
  Project,
  Event,
  Visitor,
  Session,
  PageView,
  TrackEvent,
  CustomerEvent,
  Recording,
  RecordingChunk,
  HeatmapEvent,
  CobrowseSession,
} from "../db/models.js";
import { readFileSync, existsSync } from "fs";
import { analyzeAndStore } from "../services/journeyAnalyzer.js";
import { join } from "path";
import { lookup } from "mime-types";
import { gzipSync } from "zlib";
import { broadcast } from "../lib/websocket-hub.js";
import { friendlyName } from "../lib/friendly-name.js";

function isSafeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local")
  )
    return false;

  const parts = hostname.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
    const [a, b] = parts;
    if (a === 127) return false;
    if (a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 0) return false;
  }

  return true;
}

const pub = new Hono();

pub.get("/uploads/:filename", (c) => {
  const filename = c.req.param("filename");
  if (!filename || filename.includes("..")) return c.text("Not found", 404);
  const filePath = join(import.meta.dir, "../../public/uploads", filename);
  if (!existsSync(filePath)) return c.text("Not found", 404);
  const data = readFileSync(filePath);
  const mime = lookup(filename) || "application/octet-stream";
  c.header("Content-Type", mime);
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  return c.body(data);
});

const trackEventSchema = z.object({
  elementId: z.string().min(1),
  variantId: z.string().min(1),
  ruleId: z.string().optional(),
  type: z.string().min(1),
  visitorId: z.string().min(1),
  url: z.string().optional(),
  country: z.string().optional(),
  countryCode: z.string().optional(),
  device: z.string().optional(),
});

const trackBodySchema = z.object({
  projectKey: z.string().min(1),
  events: z.array(trackEventSchema).min(1).max(500),
});

// Legacy endpoint kept for backward compatibility
pub.post("/track", async (c) => {
  try {
    const raw = await c.req.json();
    const parsed = trackBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.flatten().fieldErrors }, 400);
    }
    const body = parsed.data;
    const project = await Project.findOne({ publicKey: body.projectKey });
    if (!project) return c.json({ ok: false }, 404);

    await Event.insertMany(
      body.events.map((e) => ({
        projectId: project.id,
        elementId: e.elementId,
        variantId: e.variantId,
        ruleId: e.ruleId || null,
        type: e.type || "impression",
        visitorId: e.visitorId,
        url: e.url || null,
        country: e.country || null,
        countryCode: e.countryCode || null,
        device: e.device || null,
      }))
    );
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 500);
  }
});

/* ───── New Ingest Endpoint (full journey tracking) ───── */

const ingestEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pageview"),
    url: z.string(),
    title: z.string().optional(),
    referrer: z.string().optional(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal("pageview_end"),
    url: z.string(),
    properties: z.object({
      duration: z.number().optional(),
      scrollDepth: z.number().optional(),
    }),
    ts: z.number(),
  }),
  z.object({
    type: z.literal("click"),
    url: z.string().optional(),
    properties: z.object({
      tag: z.string().optional(),
      text: z.string().optional(),
      href: z.string().optional(),
    }).passthrough(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal("form_submit"),
    url: z.string().optional(),
    properties: z.object({
      formId: z.string().optional(),
      action: z.string().optional(),
      method: z.string().optional(),
    }).passthrough(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal("identify"),
    properties: z.object({
      email: z.string().email(),
    }),
    ts: z.number(),
  }),
  z.object({
    type: z.literal("impression"),
    elementId: z.string(),
    variantId: z.string(),
    ruleId: z.string().nullable().optional(),
    url: z.string().optional(),
    country: z.string().optional(),
    countryCode: z.string().optional(),
    device: z.string().optional(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal("custom"),
    name: z.string(),
    url: z.string().optional(),
    properties: z.record(z.unknown()).optional(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal("session_end"),
    ts: z.number(),
  }),
  z.object({
    type: z.literal("s"),
    d: z.array(z.record(z.unknown())),
    seq: z.number(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal("hm_click"),
    url: z.string(),
    properties: z.object({
      x: z.number(),
      y: z.number(),
      vw: z.number(),
      vh: z.number(),
      sel: z.string().optional(),
    }),
    ts: z.number(),
  }),
  z.object({
    type: z.literal("hm_move"),
    url: z.string(),
    properties: z.object({
      points: z.array(z.object({ x: z.number(), y: z.number(), t: z.number() })),
      vw: z.number(),
      vh: z.number(),
    }),
    ts: z.number(),
  }),
  z.object({
    type: z.literal("hm_scroll"),
    url: z.string(),
    properties: z.object({
      depth: z.number(),
      vw: z.number(),
      vh: z.number(),
    }),
    ts: z.number(),
  }),
]);

const ingestBodySchema = z.object({
  projectKey: z.string().min(1),
  visitorId: z.string().min(1),
  sessionId: z.string().min(1),
  context: z.object({
    language: z.string().optional(),
    device: z.string().optional(),
    browser: z.string().optional(),
    os: z.string().optional(),
    screenWidth: z.number().optional(),
    referrer: z.string().optional(),
    utm: z.object({
      source: z.string().optional(),
      medium: z.string().optional(),
      campaign: z.string().optional(),
      term: z.string().optional(),
      content: z.string().optional(),
    }).optional(),
  }).optional(),
  geo: z.object({
    country: z.string().optional(),
    countryCode: z.string().optional(),
    region: z.string().optional(),
    city: z.string().optional(),
  }).optional(),
  events: z.array(ingestEventSchema).min(1).max(500),
});

pub.post("/ingest", async (c) => {
  try {
    const text = await c.req.text();
    const raw = JSON.parse(text);
    const parsed = ingestBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.flatten().fieldErrors }, 400);
    }
    const body = parsed.data;
    const project = await Project.findOne({ publicKey: body.projectKey });
    if (!project) return c.json({ ok: false }, 404);

    const pid = project.id;
    const vid = body.visitorId;
    const sid = body.sessionId;
    const ctx = body.context || {};
    const geo = body.geo || {};
    const utm = ctx.utm || {};

    const pageviews: Array<{
      projectId: string; visitorId: string; sessionId: string;
      url: string; title?: string; referrer?: string; timestamp: Date;
    }> = [];
    const trackEvents: Array<{
      projectId: string; visitorId: string; sessionId: string;
      name: string; properties?: any; url?: string; timestamp: Date;
    }> = [];
    const impressions: Array<{
      projectId: string; visitorId: string; elementId: string;
      variantId: string; ruleId: string | null; type: string;
      url: string | null; country: string | null;
      countryCode: string | null; device: string | null;
    }> = [];
    let identifyEmail: string | null = null;
    let pageviewEndUpdates: Array<{
      url: string; duration?: number; scrollDepth?: number;
    }> = [];

    let pvCount = 0;
    let evtCount = 0;
    let clickCount = 0;
    let firstPageUrl: string | null = null;
    let lastPageUrl: string | null = null;
    let hasSessionEnd = false;
    const snapshotChunks: Array<{ d: Record<string, unknown>[]; seq: number }> = [];
    const heatmapDocs: Array<Record<string, unknown>> = [];

    for (const evt of body.events) {
      const ts = new Date(evt.ts);

      if (evt.type === "pageview") {
        pvCount++;
        if (!firstPageUrl) firstPageUrl = evt.url;
        lastPageUrl = evt.url;
        pageviews.push({
          projectId: pid, visitorId: vid, sessionId: sid,
          url: evt.url, title: evt.title || undefined,
          referrer: evt.referrer || undefined, timestamp: ts,
        });
      } else if (evt.type === "pageview_end") {
        pageviewEndUpdates.push({
          url: evt.url,
          duration: evt.properties?.duration,
          scrollDepth: evt.properties?.scrollDepth,
        });
      } else if (evt.type === "click" || evt.type === "form_submit") {
        evtCount++;
        if (evt.type === "click") clickCount++;
        trackEvents.push({
          projectId: pid, visitorId: vid, sessionId: sid,
          name: evt.type, properties: evt.properties || {},
          url: evt.url || undefined, timestamp: ts,
        });
      } else if (evt.type === "custom") {
        evtCount++;
        trackEvents.push({
          projectId: pid, visitorId: vid, sessionId: sid,
          name: evt.name, properties: evt.properties || {},
          url: evt.url || undefined, timestamp: ts,
        });
      } else if (evt.type === "identify") {
        identifyEmail = evt.properties.email;
      } else if (evt.type === "impression") {
        impressions.push({
          projectId: pid, visitorId: vid,
          elementId: evt.elementId, variantId: evt.variantId,
          ruleId: evt.ruleId || null, type: "impression",
          url: evt.url || null, country: evt.country || null,
          countryCode: evt.countryCode || null, device: evt.device || null,
        });
      } else if (evt.type === "session_end") {
        hasSessionEnd = true;
      } else if (evt.type === "s") {
        snapshotChunks.push({ d: evt.d, seq: evt.seq });
      } else if (evt.type === "hm_click") {
        const p = evt.properties;
        heatmapDocs.push({
          projectId: pid, sessionId: sid, url: evt.url, type: "click",
          x: p.x, y: p.y, selector: p.sel || "",
          viewportW: p.vw, viewportH: p.vh,
          device: ctx.device || "desktop", timestamp: ts,
        });
      } else if (evt.type === "hm_move") {
        const p = evt.properties;
        for (const pt of p.points) {
          heatmapDocs.push({
            projectId: pid, sessionId: sid, url: evt.url, type: "move",
            x: pt.x, y: pt.y,
            viewportW: p.vw, viewportH: p.vh,
            device: ctx.device || "desktop", timestamp: new Date(pt.t),
          });
        }
      } else if (evt.type === "hm_scroll") {
        const p = evt.properties;
        heatmapDocs.push({
          projectId: pid, sessionId: sid, url: evt.url, type: "scroll",
          scrollDepth: p.depth,
          viewportW: p.vw, viewportH: p.vh,
          device: ctx.device || "desktop", timestamp: ts,
        });
      }
    }

    const now = new Date();
    const ops: Promise<unknown>[] = [];

    // Upsert Visitor
    const visitorSet: Record<string, unknown> = {
      lastSeenAt: now,
    };
    if (geo.country) visitorSet.country = geo.country;
    if (geo.countryCode) visitorSet.countryCode = geo.countryCode;
    if (geo.region) visitorSet.region = geo.region;
    if (geo.city) visitorSet.city = geo.city;
    if (ctx.language) visitorSet.language = ctx.language;
    if (ctx.device) visitorSet.device = ctx.device;
    if (ctx.browser) visitorSet.browser = ctx.browser;
    if (ctx.os) visitorSet.os = ctx.os;
    if (identifyEmail) visitorSet.email = identifyEmail;

    ops.push(
      Visitor.findOneAndUpdate(
        { projectId: pid, visitorId: vid },
        {
          $set: visitorSet,
          $inc: { totalPageviews: pvCount, totalEvents: evtCount },
          $setOnInsert: {
            projectId: pid,
            visitorId: vid,
            name: identifyEmail ? null : friendlyName(vid),
            isRandomName: !identifyEmail,
            firstReferrer: ctx.referrer || null,
            firstUtmSource: utm.source || null,
            firstUtmMedium: utm.medium || null,
            firstUtmCampaign: utm.campaign || null,
            totalSessions: 1,
            firstSeenAt: now,
          },
        },
        { upsert: true, returnDocument: "after" }
      )
    );

    // Upsert Session
    ops.push(
      Session.findOneAndUpdate(
        { projectId: pid, sessionId: sid },
        {
          $set: {
            endedAt: now,
            ...(lastPageUrl != null && { exitPage: lastPageUrl }),
          },
          $inc: { pageviews: pvCount, events: evtCount },
          $setOnInsert: {
            projectId: pid,
            visitorId: vid,
            sessionId: sid,
            entryPage: firstPageUrl,
            referrer: ctx.referrer || null,
            utmSource: utm.source || null,
            utmMedium: utm.medium || null,
            utmCampaign: utm.campaign || null,
            device: ctx.device || null,
            browser: ctx.browser || null,
            os: ctx.os || null,
            country: geo.country || null,
            countryCode: geo.countryCode || null,
            startedAt: now,
          },
        },
        { upsert: true, returnDocument: "after" }
      )
    );

    if (pageviews.length > 0) {
      ops.push(PageView.insertMany(pageviews));
    }
    if (trackEvents.length > 0) {
      ops.push(TrackEvent.insertMany(trackEvents));
    }
    if (impressions.length > 0) {
      ops.push(Event.insertMany(impressions));
    }
    if (heatmapDocs.length > 0) {
      ops.push(HeatmapEvent.insertMany(heatmapDocs, { ordered: false }));

      const hmCounts: Record<string, { clicks: number; moves: number; scrolls: number }> = {};
      for (const d of heatmapDocs) {
        const url = d.url as string;
        if (!hmCounts[url]) hmCounts[url] = { clicks: 0, moves: 0, scrolls: 0 };
        if (d.type === "click") hmCounts[url].clicks++;
        else if (d.type === "move") hmCounts[url].moves++;
        else if (d.type === "scroll") hmCounts[url].scrolls++;
      }
      for (const [url, counts] of Object.entries(hmCounts)) {
        broadcast(pid, "heatmap:new", { url, ...counts });
      }
    }

    // Handle pageview_end updates (update most recent matching pageview)
    ops.push(
      ...pageviewEndUpdates.map((pu) => {
        const set: Record<string, number> = {};
        if (pu.duration != null) set.duration = pu.duration;
        if (pu.scrollDepth != null) set.scrollDepth = pu.scrollDepth;
        if (Object.keys(set).length === 0) return Promise.resolve();
        return PageView.findOneAndUpdate(
          { projectId: pid, visitorId: vid, sessionId: sid, url: pu.url },
          { $set: set },
          { sort: { timestamp: -1 } }
        );
      })
    );

    // If identify, also link unlinked CustomerEvents
    if (identifyEmail) {
      ops.push(
        CustomerEvent.updateMany(
          { projectId: pid, customerEmail: identifyEmail, visitorId: null },
          { $set: { visitorId: vid } }
        )
      );
    }

    await Promise.all(ops);

    // Snapshot chunks are processed in the background so the ingest
    // response is not delayed by gzip compression + extra DB writes.
    if (snapshotChunks.length > 0) {
      const bgSnapshotChunks = snapshotChunks;
      const bgPvCount = pvCount;
      const bgClickCount = clickCount;
      (async () => {
        try {
          const bgOps: Promise<unknown>[] = [];

          for (const chunk of bgSnapshotChunks) {
            const raw = JSON.stringify(chunk.d);
            const compressed = gzipSync(Buffer.from(raw));
            bgOps.push(
              RecordingChunk.create({
                projectId: pid,
                sessionId: sid,
                seqNum: chunk.seq,
                events: compressed,
                eventCount: chunk.d.length,
              }),
            );
          }

          const totalNewSize = bgSnapshotChunks.reduce(
            (s, c) => s + JSON.stringify(c.d).length,
            0,
          );

          bgOps.push(
            Recording.findOneAndUpdate(
              { projectId: pid, sessionId: sid },
              {
                $set: { endedAt: now, status: "recording" },
                $inc: {
                  chunkCount: bgSnapshotChunks.length,
                  totalSize: totalNewSize,
                  pageCount: bgPvCount,
                  clickCount: bgClickCount,
                },
                $setOnInsert: {
                  projectId: pid,
                  sessionId: sid,
                  visitorId: vid,
                  startedAt: now,
                  entryUrl: firstPageUrl || null,
                  device: ctx.device || null,
                  browser: ctx.browser || null,
                  os: ctx.os || null,
                  country: geo.country || null,
                  countryCode: geo.countryCode || null,
                },
              },
              { upsert: true },
            ),
          );

          await Promise.all(bgOps);

          broadcast(pid, "recording:update", {
            sessionId: sid,
            visitorId: vid,
            entryUrl: firstPageUrl || null,
            device: ctx.device || null,
            status: "recording",
            chunkCount: bgSnapshotChunks.length,
          });
        } catch (err) {
          console.error("Background snapshot store error:", err);
        }
      })();
    }

    const ts = now.toISOString();

    for (const evt of body.events) {
      if (evt.type === "pageview") {
        broadcast(pid, "live:pageview", {
          visitorId: vid, sessionId: sid,
          url: evt.url, title: evt.title || null, referrer: evt.referrer || null,
          timestamp: ts,
        });
      } else if (evt.type === "pageview_end") {
        broadcast(pid, "live:pageview_end", {
          visitorId: vid, sessionId: sid,
          url: evt.url,
          duration: evt.properties?.duration ?? null,
          scrollDepth: evt.properties?.scrollDepth ?? null,
          timestamp: ts,
        });
      } else if (evt.type === "click") {
        broadcast(pid, "live:click", {
          visitorId: vid, sessionId: sid,
          url: evt.url || null,
          tag: evt.properties?.tag || null,
          text: evt.properties?.text || null,
          href: evt.properties?.href || null,
          timestamp: ts,
        });
      } else if (evt.type === "form_submit") {
        broadcast(pid, "live:form_submit", {
          visitorId: vid, sessionId: sid,
          url: evt.url || null,
          formId: evt.properties?.formId || null,
          action: evt.properties?.action || null,
          method: evt.properties?.method || null,
          timestamp: ts,
        });
      } else if (evt.type === "identify") {
        broadcast(pid, "live:identify", {
          visitorId: vid, sessionId: sid,
          email: evt.properties?.email || null,
          timestamp: ts,
        });
      } else if (evt.type === "custom") {
        broadcast(pid, "live:custom", {
          visitorId: vid, sessionId: sid,
          name: evt.name, url: evt.url || null,
          properties: evt.properties || {},
          timestamp: ts,
        });
      } else if (evt.type === "impression") {
        broadcast(pid, "live:impression", {
          visitorId: vid, sessionId: sid,
          elementId: evt.elementId, variantId: evt.variantId,
          ruleId: evt.ruleId || null, url: evt.url || null,
          timestamp: ts,
        });
      } else if (evt.type === "session_end") {
        broadcast(pid, "visitor_offline", {
          visitorId: vid, sessionId: sid,
          timestamp: ts,
        });
        broadcast(pid, "recording:end", {
          sessionId: sid, visitorId: vid,
          status: "complete", timestamp: ts,
        });
      }
    }

    if (hasSessionEnd) {
      analyzeAndStore(pid, sid).catch((err) =>
        console.error("Journey analysis trigger error:", err),
      );
    }

    if (!hasSessionEnd) {
      broadcast(pid, "visitor_update", {
        visitorId: vid,
        sessionId: sid,
        pageviews: pvCount,
        events: evtCount,
        email: identifyEmail || null,
        country: geo.country || null,
        countryCode: geo.countryCode || null,
        region: geo.region || null,
        city: geo.city || null,
        language: ctx.language || null,
        device: ctx.device || null,
        browser: ctx.browser || null,
        os: ctx.os || null,
        referrer: ctx.referrer || null,
        utmSource: utm.source || null,
        utmMedium: utm.medium || null,
        utmCampaign: utm.campaign || null,
        timestamp: ts,
      });
    }

    if (pvCount > 0 || evtCount > 0 || clickCount > 0) {
      broadcast(pid, "analytics:activity", {
        visitorId: vid,
        sessionId: sid,
        pageviews: pvCount,
        events: evtCount,
        clicks: clickCount,
        timestamp: ts,
      });
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("Ingest error:", err);
    return c.json({ ok: false }, 500);
  }
});

pub.get("/cobrowse-check", async (c) => {
  const projectKey = c.req.query("projectKey");
  const sessionId = c.req.query("sessionId");
  if (!projectKey || !sessionId) return c.json({ active: false });

  const project = await Project.findOne({ publicKey: projectKey }).select("_id").lean();
  if (!project) return c.json({ active: false });

  const session = await CobrowseSession.findOne({
    projectId: project._id,
    sessionId,
    status: { $in: ["requested", "active"] },
  }).lean();

  if (session && session.status === "requested") {
    await CobrowseSession.updateOne({ _id: session._id }, { $set: { status: "active" } });
  }

  return c.json({ active: !!session });
});

pub.get("/project-config", async (c) => {
  const projectKey = c.req.query("projectKey");
  if (!projectKey) {
    return c.json({ error: "projectKey query parameter is required" }, 400);
  }

  const config = await getProjectConfig(projectKey);
  if (!config) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json(config);
});

pub.get("/geo", async (c) => {
  const clientIp =
    c.req.header("x-client-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "";

  const isPrivate =
    !clientIp ||
    clientIp === "127.0.0.1" ||
    clientIp === "::1" ||
    clientIp.startsWith("192.168.") ||
    clientIp.startsWith("10.") ||
    (clientIp.startsWith("172.") && (() => {
      const second = parseInt(clientIp.split(".")[1], 10);
      return second >= 16 && second <= 31;
    })());

  const empty = { country: "", countryCode: "", region: "", city: "" };

  try {
    const lookupUrl = isPrivate
      ? "http://ip-api.com/json/?fields=status,country,countryCode,regionName,city"
      : `http://ip-api.com/json/${clientIp}?fields=status,country,countryCode,regionName,city`;

    const res = await fetch(lookupUrl);
    const data = await res.json() as Record<string, string>;

    if (data.status !== "success") {
      return c.json(empty);
    }

    c.header("Cache-Control", "public, max-age=300");
    return c.json({
      country: data.country || "",
      countryCode: data.countryCode || "",
      region: data.regionName || "",
      city: data.city || "",
    });
  } catch {
    return c.json(empty);
  }
});

const PICKER_SCRIPT = `
<script data-segmentor-picker>
(function(){
  var BRAND = "#171717";
  var BRAND_RGB = "23,23,23";
  var IDS = {
    overlay: "__seg_overlay",
    label: "__seg_label",
    select: "__seg_select",
    badge: "__seg_badge"
  };
  var overlay, labelEl, selectEl, badgeEl;
  var hovered = null, selected = null;
  var inspecting = true;

  /* ── UI elements ── */

  function ensureUI() {
    if (document.getElementById(IDS.overlay)) {
      overlay = document.getElementById(IDS.overlay);
      labelEl = document.getElementById(IDS.label);
      selectEl = document.getElementById(IDS.select);
      badgeEl = document.getElementById(IDS.badge);
      return true;
    }
    if (!document.body) return false;

    overlay = document.createElement("div");
    overlay.id = IDS.overlay;
    overlay.style.cssText = "position:fixed;pointer-events:none;border:2px solid " + BRAND + ";background:rgba(" + BRAND_RGB + ",0.06);z-index:2147483646;display:none;transition:all 60ms ease;border-radius:3px;box-sizing:border-box;";
    document.body.appendChild(overlay);

    labelEl = document.createElement("div");
    labelEl.id = IDS.label;
    labelEl.style.cssText = "position:fixed;z-index:2147483646;background:" + BRAND + ";color:#fff;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 7px;border-radius:3px;pointer-events:none;display:none;white-space:nowrap;";
    document.body.appendChild(labelEl);

    selectEl = document.createElement("div");
    selectEl.id = IDS.select;
    selectEl.style.cssText = "position:fixed;pointer-events:none;border:2px solid " + BRAND + ";background:rgba(" + BRAND_RGB + ",0.04);z-index:2147483647;display:none;border-radius:3px;box-sizing:border-box;";
    document.body.appendChild(selectEl);

    badgeEl = document.createElement("div");
    badgeEl.id = IDS.badge;
    badgeEl.style.cssText = "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:" + BRAND + ";color:#fff;font:11px/1 system-ui,sans-serif;padding:5px 12px;border-radius:20px;pointer-events:none;opacity:0.9;display:none;white-space:nowrap;";
    document.body.appendChild(badgeEl);

    return true;
  }

  function isOurs(el) {
    if (!el) return false;
    var id = el.id || "";
    return id === IDS.overlay || id === IDS.label || id === IDS.select || id === IDS.badge || (el.hasAttribute && el.hasAttribute("data-segmentor-picker"));
  }

  /* ── Selector generation (inspired by @medv/finder) ── */

  function isUnique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch(e) { return false; }
  }

  function escId(id) {
    try { return CSS.escape(id); } catch(e) { return id.replace(/([^a-zA-Z0-9_-])/g, "\\\\$1"); }
  }

  function buildSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return "body";

    if (el.id && !el.id.startsWith("__seg")) {
      var idSel = "#" + escId(el.id);
      if (isUnique(idSel)) return idSel;
    }

    if (el.getAttribute && el.getAttribute("data-testid")) {
      var dSel = "[data-testid=\\"" + el.getAttribute("data-testid") + "\\"]";
      if (isUnique(dSel)) return dSel;
    }

    var cls = el.className;
    if (cls && typeof cls === "string") {
      var classes = cls.trim().split(/\\s+/).filter(function(c) {
        return c && !c.startsWith("__seg") && c.length < 50;
      });
      for (var ci = 0; ci < classes.length; ci++) {
        var cSel = el.tagName.toLowerCase() + "." + escId(classes[ci]);
        if (isUnique(cSel)) return cSel;
      }
      if (classes.length >= 2) {
        var combo = el.tagName.toLowerCase() + "." + classes.slice(0, 3).map(escId).join(".");
        if (isUnique(combo)) return combo;
      }
    }

    var path = [];
    var cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (cur !== el && cur.id && !cur.id.startsWith("__seg")) {
        path.unshift("#" + escId(cur.id));
        var candidate = path.join(" > ");
        if (isUnique(candidate)) return candidate;
      }
      var tag = cur.tagName.toLowerCase();
      var parent = cur.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(s) { return s.tagName === cur.tagName && !isOurs(s); });
        if (siblings.length > 1) {
          var idx = siblings.indexOf(cur);
          if (idx >= 0) tag += ":nth-of-type(" + (idx + 1) + ")";
        }
      }
      path.unshift(tag);
      cur = parent;
    }
    return path.length ? "body > " + path.join(" > ") : "body";
  }

  /* ── Element data ── */

  function getDisplayLabel(el) {
    var tag = el.tagName.toLowerCase();
    var id = el.id && !el.id.startsWith("__seg") ? "#" + el.id : "";
    var cls = "";
    try {
      if (el.className && typeof el.className === "string") {
        cls = "." + el.className.trim().split(/\\s+/).filter(function(c) { return c && !c.startsWith("__seg"); }).slice(0, 2).join(".");
      }
    } catch(x) {}
    return tag + id + cls;
  }

  function getBreadcrumb(el) {
    var crumbs = [];
    var cur = el;
    while (cur && cur !== document.documentElement) {
      crumbs.unshift(cur.tagName.toLowerCase());
      cur = cur.parentElement;
    }
    return crumbs;
  }

  function getComputedProps(el) {
    var cs = window.getComputedStyle(el);
    return {
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      fontFamily: cs.fontFamily,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textAlign: cs.textAlign,
      textDecoration: cs.textDecoration,
      padding: cs.padding,
      margin: cs.margin,
      borderRadius: cs.borderRadius,
      display: cs.display,
      opacity: cs.opacity
    };
  }

  function getElementData(el) {
    var text = "";
    try { text = (el.textContent || "").trim().substring(0, 500); } catch(x) {}
    var rect = el.getBoundingClientRect();
    return {
      type: "SEGMENTOR_PICK",
      selector: buildSelector(el),
      tag: (el.tagName || "").toLowerCase(),
      text: text,
      href: el.getAttribute("href") || "",
      src: el.getAttribute("src") || "",
      alt: el.getAttribute("alt") || "",
      breadcrumb: getBreadcrumb(el),
      computedStyle: getComputedProps(el),
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    };
  }

  /* ── Overlay / selection rendering ── */

  function positionBox(box, r) {
    box.style.top = r.top + "px";
    box.style.left = r.left + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    box.style.display = "block";
  }

  function showOverlay(el) {
    if (!ensureUI()) return;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    positionBox(overlay, r);
    labelEl.textContent = getDisplayLabel(el);
    var lt = r.top - 24;
    labelEl.style.top = (lt < 0 ? r.bottom + 4 : lt) + "px";
    labelEl.style.left = r.left + "px";
    labelEl.style.display = "block";
  }

  function showSelection(el) {
    if (!ensureUI()) return;
    positionBox(selectEl, el.getBoundingClientRect());
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = "none";
    if (labelEl) labelEl.style.display = "none";
  }

  function hideSelection() {
    if (selectEl) selectEl.style.display = "none";
  }

  function showBadge(text) {
    if (!ensureUI()) return;
    badgeEl.textContent = text;
    badgeEl.style.display = "block";
    clearTimeout(showBadge._t);
    showBadge._t = setTimeout(function() { badgeEl.style.display = "none"; }, 1500);
  }

  /* ── Scroll / resize tracking ── */

  var rafPending = false;
  function onLayout() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function() {
      rafPending = false;
      if (hovered && inspecting) showOverlay(hovered);
      if (selected) showSelection(selected);
    });
  }
  window.addEventListener("scroll", onLayout, true);
  window.addEventListener("resize", onLayout, true);

  /* ── Inspect-mode event handlers ── */

  document.addEventListener("mouseover", function(e) {
    if (!inspecting) return;
    var t = e.target;
    if (!t || !t.tagName || isOurs(t) || t === document.body || t === document.documentElement) return;
    hovered = t;
    showOverlay(t);
    window.parent.postMessage({
      type: "SEGMENTOR_HOVER",
      selector: buildSelector(t),
      display: getDisplayLabel(t),
      breadcrumb: getBreadcrumb(t),
      rect: (function(r) { return { top: r.top, left: r.left, width: r.width, height: r.height }; })(t.getBoundingClientRect())
    }, "*");
  }, true);

  document.addEventListener("mouseout", function(e) {
    if (e.target === hovered) { hovered = null; hideOverlay(); }
  }, true);

  var BLOCK_EVENTS = ["auxclick","dblclick","mousedown","mouseup","pointerdown","pointerup","touchstart","touchend","submit"];
  function blockHandler(e) {
    if (!inspecting) return;
    if (isOurs(e.target)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  }
  BLOCK_EVENTS.forEach(function(evt) { document.addEventListener(evt, blockHandler, true); });

  document.addEventListener("click", function(e) {
    if (!inspecting) return;
    var t = e.target;
    if (isOurs(t)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (!t || !t.tagName || t === document.body || t === document.documentElement) return;
    selected = t;
    showSelection(t);
    window.parent.postMessage(getElementData(t), "*");
  }, true);

  document.addEventListener("keydown", function(e) {
    if (!inspecting && e.key !== "Escape") return;
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); }
  }, true);

  window.open = function() { return null; };
  window.alert = function() {};
  window.confirm = function() { return false; };
  window.prompt = function() { return null; };

  /* ── Mutation engine ── */

  function applyMutation(el, m) {
    if (!el || !m) return;
    if (m.field === "text") el.textContent = m.value;
    else if (m.field === "innerHTML") el.innerHTML = m.value;
    else if (m.field === "href") el.setAttribute("href", m.value);
    else if (m.field === "src") el.setAttribute("src", m.value);
    else if (m.field === "visible") el.style.display = m.value === "false" ? "none" : "";
    else if (m.field === "style") {
      try { var s = typeof m.value === "string" ? JSON.parse(m.value) : m.value; for (var k in s) el.style[k] = s[k]; } catch(x) {}
    }
    else if (m.field === "className") el.className = m.value;
    else if (m.field === "attribute") el.setAttribute(m.key || "", m.value);
    if (el === selected) showSelection(el);
  }

  function mutationMatches(el, m) {
    if (!el || !m) return true;
    if (m.field === "text") return el.textContent === m.value;
    if (m.field === "href") return el.getAttribute("href") === m.value;
    if (m.field === "src") return el.getAttribute("src") === m.value;
    if (m.field === "visible") return m.value === "false" ? el.style.display === "none" : el.style.display !== "none";
    return false;
  }

  /* Persistent mutations: survive SPA re-renders via MutationObserver */

  var stickyMutations = {};
  var originalState = {};
  var reapplyScheduled = false;

  function captureOriginal(selector, el) {
    if (originalState[selector]) return;
    originalState[selector] = {
      textContent: el.textContent,
      innerHTML: el.innerHTML,
      href: el.getAttribute("href"),
      src: el.getAttribute("src"),
      display: el.style.display,
      className: el.className,
      style: el.getAttribute("style") || ""
    };
  }

  function addStickyMutation(selector, mutation) {
    if (!stickyMutations[selector]) stickyMutations[selector] = [];
    var arr = stickyMutations[selector];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].field === mutation.field && (arr[i].key || "") === (mutation.key || "")) {
        arr[i] = mutation;
        return;
      }
    }
    arr.push(mutation);
  }

  function reapplyStickyMutations() {
    reapplyScheduled = false;
    for (var selector in stickyMutations) {
      var el = null;
      try { el = document.querySelector(selector); } catch(x) {}
      if (!el) continue;
      var muts = stickyMutations[selector];
      for (var i = 0; i < muts.length; i++) {
        if (!mutationMatches(el, muts[i])) applyMutation(el, muts[i]);
      }
    }
  }

  function scheduleReapply() {
    if (reapplyScheduled) return;
    reapplyScheduled = true;
    requestAnimationFrame(reapplyStickyMutations);
  }

  function revertAllMutations() {
    for (var selector in originalState) {
      var el = null;
      try { el = document.querySelector(selector); } catch(x) {}
      if (!el) continue;
      var orig = originalState[selector];
      el.setAttribute("style", orig.style);
      if (orig.href !== null) el.setAttribute("href", orig.href);
      if (orig.src !== null) el.setAttribute("src", orig.src);
      el.textContent = orig.textContent;
    }
    stickyMutations = {};
    originalState = {};
    window.parent.postMessage({ type: "SEGMENTOR_REVERTED" }, "*");
  }

  /* ── Ancestor traversal ── */

  function navigateAncestor(direction) {
    if (!selected) return;
    var target = null;
    if (direction === "up") {
      target = selected.parentElement;
      if (!target || target === document.body || target === document.documentElement) return;
    } else {
      target = selected.firstElementChild;
      if (!target || isOurs(target)) return;
    }
    selected = target;
    showSelection(target);
    window.parent.postMessage(getElementData(target), "*");
  }

  /* ── Message handler ── */

  var pendingApplies = [];
  var selectPollTimer = null;

  window.addEventListener("message", function(e) {
    var d = e.data;
    if (!d || !d.type) return;

    if (d.type === "SEGMENTOR_SET_MODE") {
      inspecting = d.mode !== "interact";
      if (!inspecting) { hideOverlay(); hovered = null; }
      showBadge(inspecting ? "Inspect mode" : "Interact mode");
    }

    if (d.type === "SEGMENTOR_APPLY") {
      var el = selected;
      if (d.selector) { try { el = document.querySelector(d.selector); } catch(x) {} }
      if (el) {
        captureOriginal(d.selector || buildSelector(el), el);
        applyMutation(el, d.mutation);
      } else if (d.selector) {
        pendingApplies.push({ selector: d.selector, mutation: d.mutation });
      }
      if (d.selector) addStickyMutation(d.selector, d.mutation);
    }

    if (d.type === "SEGMENTOR_REVERT") {
      revertAllMutations();
    }

    if (d.type === "SEGMENTOR_DESELECT") {
      selected = null;
      pendingApplies = [];
      stickyMutations = {};
      originalState = {};
      if (selectPollTimer) { clearTimeout(selectPollTimer); selectPollTimer = null; }
      hideSelection();
    }

    if (d.type === "SEGMENTOR_SELECT") {
      if (selectPollTimer) { clearTimeout(selectPollTimer); selectPollTimer = null; }
      var sel = d.selector;
      function tryFind(attempts) {
        var target = null;
        try { target = document.querySelector(sel); } catch(x) {}
        if (target) {
          selected = target;
          showSelection(target);
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          window.parent.postMessage(getElementData(target), "*");
          for (var i = 0; i < pendingApplies.length; i++) {
            var pa = pendingApplies[i];
            var paEl = null;
            try { paEl = document.querySelector(pa.selector); } catch(x) {}
            if (paEl) { captureOriginal(pa.selector, paEl); applyMutation(paEl, pa.mutation); }
          }
          pendingApplies = [];
          return;
        }
        if (attempts > 0) {
          selectPollTimer = setTimeout(function() { tryFind(attempts - 1); }, 200);
        }
      }
      tryFind(30);
    }

    if (d.type === "SEGMENTOR_ANCESTOR") {
      navigateAncestor(d.direction || "up");
    }
  });

  /* ── MutationObserver ── */

  if (typeof MutationObserver !== "undefined") {
    setInterval(ensureUI, 2000);
    new MutationObserver(function() {
      ensureUI();
      scheduleReapply();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ── Ready signal ── */

  function sendReady() {
    window.parent.postMessage({ type: "SEGMENTOR_READY" }, "*");
  }
  sendReady();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sendReady);
  }
})();
</script>
`;

pub.get("/heatmap-proxy", async (c) => {
  const url = c.req.query("url");
  if (!url || !isSafeUrl(url)) {
    return c.text("Invalid URL", 400);
  }

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Segmentor/1.0)",
        "Accept": "text/html",
      },
    });

    if (!res.ok) {
      return c.text(`Failed to fetch: ${res.status}`, 502);
    }

    let html = await res.text();

    const parsed = new URL(url);
    const siteBase = parsed.origin + parsed.pathname;
    const base = siteBase.endsWith("/") ? siteBase : siteBase.substring(0, siteBase.lastIndexOf("/") + 1) || parsed.origin + "/";

    html = html.replace(/<script[^>]*runtime\.js[^>]*><\/script>/gi, "");
    html = html.replace(/<style[^>]*id=["']segmentor-hide["'][^>]*>[^<]*<\/style>/gi, "");

    if (!html.includes("<base")) {
      html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${base}" target="_self" />`);
    }

    const injectedScripts = `<script>
      document.addEventListener('click', function(e) {
        var a = e.target.closest && e.target.closest('a');
        if (a) { e.preventDefault(); e.stopPropagation(); }
      }, true);
      window.addEventListener('beforeunload', function(e) { e.preventDefault(); });
      (function(){
        function sendHeight(){
          var h = Math.max(
            document.body.scrollHeight||0, document.documentElement.scrollHeight||0,
            document.body.offsetHeight||0, document.documentElement.offsetHeight||0
          );
          window.parent.postMessage({type:'segmentor-page-height',height:h},'*');
        }
        if(document.readyState==='complete') sendHeight();
        else window.addEventListener('load',sendHeight);
        new MutationObserver(sendHeight).observe(document.documentElement,{childList:true,subtree:true});
        window.addEventListener('resize',sendHeight);
      })();
    </script>
    <style>html,body{overflow:hidden!important;}</style>`;
    html = html.replace("</head>", injectedScripts + "</head>");

    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("X-Frame-Options", "ALLOWALL");
    c.header("Content-Security-Policy", "");
    return c.body(html);
  } catch (err) {
    return c.text(`Failed to fetch: ${err}`, 502);
  }
});

pub.get("/proxy", async (c) => {
  const projectKey = c.req.query("projectKey");
  if (!projectKey) {
    return c.text("projectKey is required", 400);
  }

  const project = await Project.findOne({ publicKey: projectKey }).select(
    "siteUrl"
  );

  if (!project) {
    return c.text("Project not found", 404);
  }

  if (!isSafeUrl(project.siteUrl)) {
    return c.text("Invalid or blocked URL", 400);
  }

  try {
    const res = await fetch(project.siteUrl, {
      headers: {
        "User-Agent": "Segmentor-Editor/1.0",
        "Accept": "text/html",
      },
    });

    if (!res.ok) {
      return c.text(`Failed to fetch site: ${res.status}`, 502);
    }

    let html = await res.text();

    // Remove X-Frame-Options / CSP that would block iframe embedding
    // Rewrite relative URLs to absolute so assets load correctly
    const siteOrigin = new URL(project.siteUrl).origin;
    const siteBase = project.siteUrl.endsWith("/") ? project.siteUrl : project.siteUrl + "/";

    // Strip Segmentor runtime script + hide style so editor shows the original page
    html = html.replace(/<script[^>]*runtime\.js[^>]*><\/script>/gi, "");
    html = html.replace(/<style[^>]*id=["']segmentor-hide["'][^>]*>[^<]*<\/style>/gi, "");

    // Inject <base> so relative URLs resolve to the original site
    if (!html.includes("<base")) {
      html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${siteBase}" />`);
    }

    // Inject picker script at end of <head> so capture-phase handlers register
    // before ANY site scripts — this guarantees our click interception fires first
    if (html.includes("</head>")) {
      html = html.replace("</head>", PICKER_SCRIPT + "</head>");
    } else if (html.includes("<body")) {
      html = html.replace(/<body/i, PICKER_SCRIPT + "<body");
    } else {
      html = PICKER_SCRIPT + html;
    }

    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("X-Frame-Options", "ALLOWALL");
    c.header("Content-Security-Policy", "");
    return c.body(html);
  } catch (err) {
    return c.text(`Failed to fetch site: ${err}`, 502);
  }
});

export default pub;
