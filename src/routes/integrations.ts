import { Hono } from "hono";
import { z } from "zod";
import { Webhook } from "standardwebhooks";
import { requireAuth } from "../auth/middleware.js";
import { requireProjectOwnership } from "../lib/ownership.js";
import { prisma } from "../db/index.js";

type Env = { Variables: { userId: string } };

const integrations = new Hono<Env>();

// ── Authenticated routes ──

integrations.use("/projects/:projectId/integrations/*", requireAuth);

integrations.get("/projects/:projectId/integrations", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const items = await prisma.integration.findMany({
    where: { projectId },
    select: { id: true, type: true, enabled: true, createdAt: true, updatedAt: true },
  });

  return c.json({ integrations: items });
});

const polarConnectSchema = z.object({
  webhookSecret: z.string().min(1),
});

integrations.post("/projects/:projectId/integrations/polar", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const body = await c.req.json();
  const parsed = polarConnectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const integration = await prisma.integration.upsert({
    where: { projectId_type: { projectId, type: "polar" } },
    create: {
      projectId,
      type: "polar",
      config: parsed.data,
      enabled: true,
    },
    update: {
      config: parsed.data,
      enabled: true,
    },
  });

  return c.json({
    id: integration.id,
    type: integration.type,
    enabled: integration.enabled,
    webhookUrl: `${process.env.CORS_ORIGIN ? "" : ""}https://api.segmentor.io/public/webhooks/polar/${projectId}`,
  });
});

integrations.delete("/projects/:projectId/integrations/polar", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  await prisma.integration.deleteMany({
    where: { projectId, type: "polar" },
  });

  return c.json({ ok: true });
});

export default integrations;

// ── Public webhook receiver (separate Hono app, mounted at /public) ──

export const polarWebhookHandler = new Hono();

polarWebhookHandler.post("/webhooks/polar/:projectId", async (c) => {
  const projectId = c.req.param("projectId");

  const integration = await prisma.integration.findUnique({
    where: { projectId_type: { projectId, type: "polar" } },
  });

  if (!integration || !integration.enabled) {
    return c.json({ error: "Integration not found" }, 404);
  }

  const config = integration.config as { webhookSecret: string };
  const rawBody = await c.req.text();

  const webhookId = c.req.header("webhook-id") || "";
  const webhookTimestamp = c.req.header("webhook-timestamp") || "";
  const webhookSignature = c.req.header("webhook-signature") || "";

  try {
    const wh = new Webhook(config.webhookSecret);
    wh.verify(rawBody, {
      "webhook-id": webhookId,
      "webhook-timestamp": webhookTimestamp,
      "webhook-signature": webhookSignature,
    });
  } catch (err) {
    console.error("Polar webhook signature verification failed:", err);
    return c.json({ error: "Invalid signature" }, 400);
  }

  const event = JSON.parse(rawBody) as {
    type: string;
    data: Record<string, any>;
  };

  const eventType = event.type;
  const data = event.data || {};

  let customerEmail: string | null = null;
  let amount: number | null = null;
  let currency: string | null = null;
  let productName: string | null = null;
  let externalId: string | null = null;
  let ceType = eventType;

  if (eventType === "order.paid") {
    customerEmail = data.customer?.email || data.user?.email || null;
    amount = data.amount || data.total || null;
    currency = data.currency || "usd";
    productName = data.product?.name || data.product_price?.product?.name || null;
    externalId = data.id || null;
    ceType = "purchase";
  } else if (eventType === "subscription.created" || eventType === "subscription.active") {
    customerEmail = data.customer?.email || data.user?.email || null;
    productName = data.product?.name || null;
    externalId = data.id || null;
    ceType = "subscription_created";
  } else if (eventType === "subscription.canceled" || eventType === "subscription.revoked") {
    customerEmail = data.customer?.email || data.user?.email || null;
    externalId = data.id || null;
    ceType = "subscription_canceled";
  } else if (eventType === "order.refunded") {
    customerEmail = data.customer?.email || data.user?.email || null;
    amount = data.amount || data.total || null;
    currency = data.currency || "usd";
    externalId = data.id || null;
    ceType = "refund";
  } else {
    return c.json({ received: true });
  }

  // Try to match visitor — first by visitorId in metadata, then by email
  let matchedVisitorId: string | null = null;

  const metaVisitorId = data.metadata?.segmentor_visitor_id
    || data.checkout?.metadata?.segmentor_visitor_id
    || data.metadata?.reference_id
    || data.checkout?.metadata?.reference_id
    || null;

  if (metaVisitorId) {
    const visitor = await prisma.visitor.findUnique({
      where: { projectId_visitorId: { projectId, visitorId: metaVisitorId } },
      select: { visitorId: true },
    });
    if (visitor) matchedVisitorId = visitor.visitorId;
  }

  if (!matchedVisitorId && customerEmail) {
    const visitor = await prisma.visitor.findFirst({
      where: { projectId, email: customerEmail.toLowerCase() },
      select: { visitorId: true },
    });
    if (visitor) matchedVisitorId = visitor.visitorId;
  }

  await prisma.customerEvent.create({
    data: {
      projectId,
      visitorId: matchedVisitorId,
      type: ceType,
      amount,
      currency,
      productName,
      customerEmail,
      externalId,
      provider: "polar",
      metadata: data,
    },
  });

  // Update visitor revenue if purchase matched
  if (matchedVisitorId && amount && ceType === "purchase") {
    await prisma.visitor.update({
      where: { projectId_visitorId: { projectId, visitorId: matchedVisitorId } },
      data: {
        totalRevenue: { increment: amount },
        polarCustomerId: data.customer?.id || undefined,
      },
    });
  }

  // Handle refunds
  if (matchedVisitorId && amount && ceType === "refund") {
    await prisma.visitor.update({
      where: { projectId_visitorId: { projectId, visitorId: matchedVisitorId } },
      data: { totalRevenue: { decrement: amount } },
    });
  }

  return c.json({ received: true });
});
