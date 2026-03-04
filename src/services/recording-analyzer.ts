import { SessionRecording, Visitor } from "../db/models.js";
import { AzureOpenAI } from "openai";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const UPLOADS_DIR = join(import.meta.dir, "../../uploads");

// rrweb event types (legacy compat)
const RRWEB_TYPE = { IncrementalSnapshot: 3, Meta: 4 };
const INCREMENTAL_SOURCE = { MouseInteraction: 2, Scroll: 3, Input: 5 };
const MOUSE_INTERACTION = { Click: 2 };

interface StructuredEvent {
  ts: number;
  type: string;
  url?: string;
  title?: string;
  text?: string;
  selector?: string;
  x?: number;
  y?: number;
  depth?: number;
  duration?: number;
  inputId?: string;
}

function extractStructuredEvents(rawEvents: any[]): StructuredEvent[] {
  const timeline: StructuredEvent[] = [];
  let currentUrl = "";
  let lastPageTs = 0;

  const baseTs = rawEvents[0]?.timestamp || 0;

  for (const evt of rawEvents) {
    const relTs = evt.timestamp - baseTs;

    // Meta / navigation events (type 4 -- used by both inline recorder and rrweb)
    if (evt.type === 4 && evt.data?.href) {
      const newUrl = evt.data.href;
      if (newUrl !== currentUrl) {
        if (currentUrl && lastPageTs > 0) {
          timeline.push({ ts: lastPageTs, type: "page_end", url: currentUrl, duration: Math.round((relTs - lastPageTs) / 1000) });
        }
        currentUrl = newUrl;
        let title = evt.data.title || "";
        if (!title) { try { title = new URL(newUrl).pathname; } catch { title = newUrl; } }
        lastPageTs = relTs;
        timeline.push({ ts: relTs, type: "page", url: currentUrl, title });
      }
    }

    // Inline recorder: click
    if (evt.type === "click" && evt.data) {
      timeline.push({
        ts: relTs,
        type: "click",
        x: evt.data.x,
        y: evt.data.y,
        selector: evt.data.selector || "",
        text: evt.data.text || "",
      });
    }

    // Inline recorder: scroll
    if (evt.type === "scroll" && evt.data) {
      const depth = evt.data.depth || 0;
      const prev = timeline[timeline.length - 1];
      if (!prev || prev.type !== "scroll" || Math.abs(depth - (prev.depth || 0)) > 15) {
        timeline.push({ ts: relTs, type: "scroll", depth });
      }
    }

    // Inline recorder: input
    if (evt.type === "input" && evt.data) {
      timeline.push({ ts: relTs, type: "input", inputId: evt.data.selector || "", text: "[masked]" });
    }

    // rrweb IncrementalSnapshot (both legacy and inline recorder)
    if (evt.type === RRWEB_TYPE.IncrementalSnapshot && evt.data) {
      const src = evt.data.source;
      if (src === INCREMENTAL_SOURCE.MouseInteraction && evt.data.type === MOUSE_INTERACTION.Click) {
        timeline.push({
          ts: relTs, type: "click", x: evt.data.x, y: evt.data.y,
          selector: evt.data.__selector || `node#${evt.data.id}`,
          text: evt.data.__text || "",
        });
      }
      if (src === INCREMENTAL_SOURCE.Scroll) {
        const depth = Math.min(100, Math.round(((evt.data.y || 0) + 900) / 3000 * 100));
        const prev = timeline[timeline.length - 1];
        if (!prev || prev.type !== "scroll" || Math.abs(depth - (prev.depth || 0)) > 15) {
          timeline.push({ ts: relTs, type: "scroll", depth });
        }
      }
      if (src === INCREMENTAL_SOURCE.Input) {
        timeline.push({ ts: relTs, type: "input", inputId: `node#${evt.data.id}`, text: evt.data.text ? "[masked]" : "" });
      }
    }
  }

  // Inject idle markers for gaps > 10s
  const withIdle: StructuredEvent[] = [];
  for (let i = 0; i < timeline.length; i++) {
    if (i > 0) {
      const gap = timeline[i].ts - timeline[i - 1].ts;
      if (gap > 10000) {
        withIdle.push({ ts: timeline[i - 1].ts, type: "idle", duration: Math.round(gap / 1000) });
      }
    }
    withIdle.push(timeline[i]);
  }
  return withIdle;
}

function getOpenAIClient(): AzureOpenAI | null {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (!endpoint || !apiKey) return null;
  return new AzureOpenAI({ endpoint, apiKey, apiVersion: "2024-08-01-preview" });
}

export async function analyzeRecording(recordingId: string): Promise<void> {
  const rec = await SessionRecording.findById(recordingId);
  if (!rec || !rec.eventsFile) {
    throw new Error("Recording not found or has no events file");
  }

  await SessionRecording.findByIdAndUpdate(recordingId, { status: "analyzing" }, { returnDocument: "after" });

  try {
    const eventsPath = join(UPLOADS_DIR, rec.eventsFile);
    if (!existsSync(eventsPath)) {
      throw new Error("Events file not found on disk");
    }

    const rawEvents = JSON.parse(readFileSync(eventsPath, "utf-8"));
    const structuredEvents = extractStructuredEvents(rawEvents);

    // Get visitor context
    const visitor = await Visitor.findOne({ projectId: rec.projectId, visitorId: rec.visitorId }).select(
      "country countryCode city device browser os firstReferrer firstUtmSource email name"
    );

    const client = getOpenAIClient();
    if (!client) {
      await SessionRecording.findByIdAndUpdate(
        recordingId,
        {
          status: "analyzed",
          summary: "AI analysis unavailable - structured events extracted successfully.",
          journeySteps: structuredEvents.filter((e) => e.type === "page") as any,
          clickPoints: structuredEvents.filter((e) => e.type === "click") as any,
          frictionPoints: structuredEvents.filter((e) => e.type === "idle") as any,
          sentiment: "neutral",
          analyzedAt: new Date(),
        },
        { returnDocument: "after" }
      );
      return;
    }

    const timelineSummary = structuredEvents.slice(0, 100).map((e) => {
      const sec = Math.round(e.ts / 1000);
      if (e.type === "page") return `${sec}s: Visited ${e.title || e.url}`;
      if (e.type === "click") return e.text ? `${sec}s: Clicked "${e.text}" (${e.selector})` : `${sec}s: Clicked at (${e.x}, ${e.y})`;
      if (e.type === "scroll") return `${sec}s: Scrolled to ${e.depth}%`;
      if (e.type === "input") return `${sec}s: Typed in form field ${e.inputId || ""}`;
      if (e.type === "idle") return `${sec}s: Idle for ${e.duration}s`;
      if (e.type === "page_end") return `${sec}s: Left ${e.url} after ${e.duration}s`;
      return `${sec}s: ${e.type}`;
    }).join("\n");

    const visitorContext = visitor
      ? `Visitor: ${visitor.name || "anonymous"}, from ${visitor.city || visitor.country || "unknown"} (${visitor.countryCode || "??"}), using ${visitor.device || "unknown"} / ${visitor.browser || "unknown"} / ${visitor.os || "unknown"}. Referrer: ${visitor.firstReferrer || "direct"}. UTM source: ${visitor.firstUtmSource || "none"}.`
      : "Visitor: unknown context.";

    const prompt = `Analyze this website visitor session recording. ${visitorContext}

Session duration: ${rec.duration} seconds
Pages visited: ${rec.pagesVisited.join(", ") || "unknown"}

Interaction timeline:
${timelineSummary}

Respond with ONLY valid JSON (no markdown, no code fences) in this exact format:
{
  "summary": "2-3 sentence natural language summary of what the visitor did, their intent, and outcome",
  "journeySteps": [{"page": "url", "action": "what they did", "durationOnPage": seconds}],
  "clickPoints": [{"text": "what was clicked", "timestamp": seconds}],
  "frictionPoints": [{"type": "hesitation|rage_click|abandon|confusion", "description": "what happened", "page": "url"}],
  "sentiment": "positive|neutral|frustrated"
}`;

    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o-mini";
    const response = await client.chat.completions.create({
      model: deployment,
      messages: [
        { role: "system", content: "You are a UX analytics expert. Analyze visitor session recordings and provide structured insights. Always respond with valid JSON only." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 1500,
    });

    const content = response.choices[0]?.message?.content || "";
    let analysis: any;
    try {
      const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      analysis = JSON.parse(cleaned);
    } catch {
      analysis = {
        summary: content.slice(0, 500),
        journeySteps: [],
        clickPoints: [],
        frictionPoints: [],
        sentiment: "neutral",
      };
    }

    await SessionRecording.findByIdAndUpdate(
      recordingId,
      {
        status: "analyzed",
        summary: analysis.summary || "Analysis complete",
        journeySteps: analysis.journeySteps || [],
        clickPoints: analysis.clickPoints || [],
        frictionPoints: analysis.frictionPoints || [],
        conversionEvents: analysis.conversionEvents || [],
        sentiment: analysis.sentiment || "neutral",
        analyzedAt: new Date(),
      },
      { returnDocument: "after" }
    );

    console.log(`[Recording] Analysis complete for ${recordingId}`);
  } catch (err: any) {
    console.error(`[Recording] Analysis failed for ${recordingId}:`, err?.message || err);
    await SessionRecording.findByIdAndUpdate(recordingId, { status: "failed" }, { returnDocument: "after" });
  }
}
