import { AzureOpenAI } from "openai";
import { gunzipSync } from "zlib";
import { Recording, RecordingChunk } from "../db/models.js";

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

export async function analyzeRecording(
  projectId: string,
  sessionId: string,
): Promise<string | null> {
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

  const client = getClient();
  if (!client) return null;

  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o-mini";

  const response = await client.chat.completions.create({
    model: deployment,
    messages: [
      {
        role: "system",
        content: `You are a UX analyst. Given a timestamped timeline of a user's actions on a website, write a clear, concise summary of their journey. Describe step by step what the user did, their likely intent, and any notable behavior patterns (hesitation, exploration, drop-off). Use natural language, not bullet points. Keep it to 2-4 short paragraphs. Do not speculate beyond what the data shows.`,
      },
      {
        role: "user",
        content: `Here is the user's session timeline:\n\n${timeline}`,
      },
    ],
    max_tokens: 600,
    temperature: 0.3,
  });

  return response.choices[0]?.message?.content?.trim() || null;
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
