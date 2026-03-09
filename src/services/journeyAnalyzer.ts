import { AzureOpenAI } from "openai";
import { gunzipSync } from "zlib";
import { Recording, RecordingChunk, Visitor } from "../db/models.js";
import { friendlyName } from "../lib/friendly-name.js";

// rrweb enums
const EventType = { FullSnapshot: 2, IncrementalSnapshot: 3, Meta: 4 } as const;
const IncrementalSource = {
  Mutation: 0, MouseMove: 1, MouseInteraction: 2, Scroll: 3,
  ViewportResize: 4, Input: 5, TouchMove: 6, MediaInteraction: 7,
} as const;
const MouseInteraction = {
  MouseUp: 0, MouseDown: 1, Click: 2, ContextMenu: 3,
  DblClick: 4, Focus: 5, Blur: 6, TouchStart: 7, TouchEnd: 9,
} as const;

interface NodeInfo {
  tag: string;
  text: string;
  attrs: Record<string, string>;
}

function buildNodeMap(node: any, map: Map<number, NodeInfo>) {
  if (!node || typeof node !== "object") return;
  if (node.id != null && node.type === 2) {
    const tag = (node.tagName || "").toLowerCase();
    let text = "";
    if (node.childNodes) {
      for (const child of node.childNodes) {
        if (child.type === 3 && child.textContent) {
          text += child.textContent.trim() + " ";
          if (text.length > 120) break;
        }
      }
    }
    map.set(node.id, {
      tag,
      text: text.trim().slice(0, 100),
      attrs: node.attributes || {},
    });
  }
  if (node.childNodes) {
    for (const child of node.childNodes) buildNodeMap(child, map);
  }
}

function describeNode(nodeMap: Map<number, NodeInfo>, id: number): string {
  const n = nodeMap.get(id);
  if (!n) return `element #${id}`;
  const parts: string[] = [];
  if (n.tag === "a") parts.push("link");
  else if (n.tag === "button" || n.tag === "input" && n.attrs.type === "submit") parts.push("button");
  else if (n.tag === "input" || n.tag === "textarea" || n.tag === "select") parts.push(`${n.tag} field`);
  else if (n.tag === "img") parts.push("image");
  else parts.push(n.tag || "element");

  if (n.text) parts.push(`"${n.text}"`);
  else if (n.attrs.placeholder) parts.push(`"${n.attrs.placeholder}"`);
  else if (n.attrs["aria-label"]) parts.push(`"${n.attrs["aria-label"]}"`);
  else if (n.attrs.alt) parts.push(`"${n.attrs.alt}"`);
  else if (n.attrs.id) parts.push(`#${n.attrs.id}`);
  else if (n.attrs.class) parts.push(`.${String(n.attrs.class).split(" ")[0]}`);
  if (n.attrs.href) parts.push(`→ ${n.attrs.href.slice(0, 60)}`);
  return parts.join(" ");
}

interface UserAction {
  time: number;
  action: string;
}

export function extractActions(events: any[]): UserAction[] {
  const actions: UserAction[] = [];
  const nodeMap = new Map<number, NodeInfo>();
  let startTs = 0;

  for (const evt of events) {
    if (!startTs && evt.timestamp) startTs = evt.timestamp;
    const relSec = startTs ? Math.round((evt.timestamp - startTs) / 1000) : 0;

    if (evt.type === EventType.Meta && evt.data?.href) {
      actions.push({ time: relSec, action: `Navigated to ${evt.data.href}` });
    }

    if (evt.type === EventType.FullSnapshot && evt.data?.node) {
      buildNodeMap(evt.data.node, nodeMap);
      actions.push({ time: relSec, action: "Page loaded (full snapshot)" });
    }

    if (evt.type === EventType.IncrementalSnapshot && evt.data) {
      const d = evt.data;
      if (d.source === IncrementalSource.MouseInteraction) {
        if (d.type === MouseInteraction.Click || d.type === MouseInteraction.DblClick) {
          const desc = describeNode(nodeMap, d.id);
          const verb = d.type === MouseInteraction.DblClick ? "Double-clicked" : "Clicked";
          actions.push({ time: relSec, action: `${verb} on ${desc}` });
        }
      } else if (d.source === IncrementalSource.Input) {
        const desc = describeNode(nodeMap, d.id);
        actions.push({ time: relSec, action: `Typed in ${desc}` });
      } else if (d.source === IncrementalSource.Scroll) {
        const last = actions[actions.length - 1];
        if (!last || !last.action.startsWith("Scrolled")) {
          actions.push({ time: relSec, action: "Scrolled on page" });
        }
      } else if (d.source === IncrementalSource.ViewportResize) {
        actions.push({ time: relSec, action: `Resized viewport to ${d.width}×${d.height}` });
      }
    }
  }

  return actions;
}

function formatTimeline(actions: UserAction[]): string {
  return actions.map((a) => `[${a.time}s] ${a.action}`).join("\n");
}

function getClient(): AzureOpenAI | null {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (!endpoint || !apiKey) return null;
  return new AzureOpenAI({ endpoint, apiKey, apiVersion: "2024-08-01-preview" });
}

export interface SessionAnalysis {
  metadata: {
    visitor: string;
    location: string;
    device: string;
    browser: string;
    date: string;
    verdict: string;
    verdictType: "positive" | "warning" | "negative";
  };
  activityOverview: {
    sessions: number;
    pageviews: number;
    rageClicks: number;
    timeOnSite: string;
  };
  frictionScore: {
    score: number;
    level: "low" | "medium" | "high";
    description: string;
  };
  frictionPoints: Array<{
    severity: "red" | "orange" | "yellow";
    text: string;
  }>;
  visitorJourney: string[];
  recommendations: Array<{
    title: string;
    description: string;
  }>;
  verdict: {
    summary: string;
  };
}

function formatTimeOnSite(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function extractPageviews(actions: UserAction[]): string[] {
  const pages: string[] = [];
  for (const a of actions) {
    if (a.action.startsWith("Navigated to ")) {
      try {
        const url = new URL(a.action.replace("Navigated to ", ""));
        pages.push(url.pathname);
      } catch {
        pages.push(a.action.replace("Navigated to ", ""));
      }
    }
  }
  return pages;
}

function countRageClicks(actions: UserAction[]): number {
  let count = 0;
  for (let i = 0; i < actions.length; i++) {
    if (!actions[i].action.startsWith("Clicked")) continue;
    let rapid = 1;
    for (let j = i + 1; j < actions.length; j++) {
      if (!actions[j].action.startsWith("Clicked")) break;
      if (actions[j].time - actions[i].time > 3) break;
      rapid++;
    }
    if (rapid >= 3) count++;
  }
  return count;
}

export async function analyzeRecordingStructured(
  projectId: string,
  sessionId: string,
): Promise<SessionAnalysis | null> {
  const recording = await Recording.findOne({ projectId, sessionId }).lean() as any;
  if (!recording) return null;

  const chunks = await RecordingChunk.find({ projectId, sessionId })
    .sort({ seqNum: 1 })
    .lean();

  const allEvents: any[] = [];
  for (const chunk of chunks) {
    try {
      const raw = (chunk as any).events;
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer ?? raw);
      const decompressed = gunzipSync(buf);
      const parsed = JSON.parse(decompressed.toString("utf-8"));
      if (Array.isArray(parsed)) allEvents.push(...parsed);
    } catch { /* skip corrupted */ }
  }

  if (allEvents.length < 2) return null;

  const actions = extractActions(allEvents);
  if (actions.length === 0) return null;

  const timeline = formatTimeline(actions);
  const pages = extractPageviews(actions);
  const rageClicks = countRageClicks(actions);

  const start = recording.startedAt ? new Date(recording.startedAt).getTime() : 0;
  const end = recording.endedAt ? new Date(recording.endedAt).getTime() : Date.now();
  const durationSec = start ? Math.max(0, Math.round((end - start) / 1000)) : 0;

  const visitor = await Visitor.findOne(
    { projectId, visitorId: recording.visitorId },
    { visitorId: 1, email: 1, name: 1 },
  ).lean() as any;

  const visitorName = visitor?.name || visitor?.email || friendlyName(recording.visitorId);

  const activityOverview = {
    sessions: 1,
    pageviews: pages.length || recording.pageCount || 0,
    rageClicks,
    timeOnSite: formatTimeOnSite(durationSec),
  };

  const metadata = {
    visitor: visitorName,
    location: recording.country || "Unknown",
    device: recording.device || "Unknown",
    browser: recording.browser || "Unknown",
    date: recording.startedAt ? new Date(recording.startedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "Unknown",
    verdict: "",
    verdictType: "warning" as const,
  };

  const client = getClient();
  if (!client) return null;

  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o-mini";

  const systemPrompt = `You are a UX analyst. Given a timestamped timeline of a user's session on a website, analyze the session and return ONLY valid JSON (no markdown, no code fences) matching this exact schema:

{
  "verdict": { "text": "string — e.g. 'High Intent — Did Not Convert'", "type": "positive|warning|negative" },
  "frictionScore": { "score": 0-100, "level": "low|medium|high", "description": "one sentence explaining the score" },
  "frictionPoints": [{ "severity": "red|orange|yellow", "text": "description of the friction point" }],
  "recommendations": [{ "title": "short title", "description": "actionable recommendation" }],
  "verdictSummary": "one sentence — the single most important takeaway from this session"
}

Guidelines:
- frictionScore: 0-30 = low, 31-60 = medium, 61-100 = high
- frictionPoints: red = critical, orange = moderate, yellow = minor. Include 2-5 points.
- recommendations: 2-4 actionable items ranked by impact.
- verdict text should be a concise label like "High Intent — Did Not Convert" or "Engaged Browser — Converted" etc.
- verdictSummary should be a plain-language sentence about the key takeaway.`;

  const response = await client.chat.completions.create({
    model: deployment,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Session timeline:\n\n${timeline}\n\nSession metadata: Duration ${formatTimeOnSite(durationSec)}, ${recording.clickCount || 0} clicks, ${rageClicks} rage clicks, ${pages.length} pages visited, Device: ${recording.device || "unknown"}, Browser: ${recording.browser || "unknown"}, Country: ${recording.country || "unknown"}` },
    ],
    max_tokens: 1200,
    temperature: 0.3,
  });

  const raw = response.choices[0]?.message?.content?.trim() || "";

  try {
    const parsed = JSON.parse(raw);

    metadata.verdict = parsed.verdict?.text || "Session Analyzed";
    metadata.verdictType = parsed.verdict?.type || "warning";

    return {
      metadata,
      activityOverview,
      frictionScore: {
        score: parsed.frictionScore?.score ?? 50,
        level: parsed.frictionScore?.level || "medium",
        description: parsed.frictionScore?.description || "",
      },
      frictionPoints: (parsed.frictionPoints || []).map((fp: any) => ({
        severity: fp.severity || "yellow",
        text: fp.text || "",
      })),
      visitorJourney: pages.length > 0 ? pages : ["/"],
      recommendations: (parsed.recommendations || []).map((r: any) => ({
        title: r.title || "",
        description: r.description || "",
      })),
      verdict: {
        summary: parsed.verdictSummary || "Session analysis complete.",
      },
    };
  } catch {
    return null;
  }
}

// Legacy plain-text analyzer kept for backward compatibility
export async function analyzeRecording(
  projectId: string,
  sessionId: string,
): Promise<string | null> {
  const result = await analyzeRecordingStructured(projectId, sessionId);
  if (!result) return null;
  return result.verdict.summary;
}

export async function analyzeAndStore(
  projectId: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const summary = await analyzeRecording(projectId, sessionId);
    if (summary) {
      await Recording.updateOne(
        { projectId, sessionId },
        { $set: { journeySummary: summary, journeyAnalyzedAt: new Date() } },
      );
    }
    return summary;
  } catch (err) {
    console.error("Journey analysis error:", err);
    return null;
  }
}
