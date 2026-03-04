import { Hono } from "hono";
import { z } from "zod";
import { Webhook } from "standardwebhooks";
import { requireAuth } from "../auth/middleware.js";
import { requireProjectOwnership } from "../lib/ownership.js";
import { Integration, Visitor, CustomerEvent } from "../db/models.js";
import { broadcast } from "../lib/websocket-hub.js";

type Env = { Variables: { userId: string } };

const integrations = new Hono<Env>();

// ── Authenticated routes ──

integrations.use("/projects/:projectId/integrations/*", requireAuth);

integrations.get("/projects/:projectId/integrations", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);

  const items = await Integration.find({ projectId }).select("_id type enabled createdAt updatedAt").lean();

  return c.json({
    integrations: items.map((i) => ({
      id: i._id.toString(),
      type: i.type,
      enabled: i.enabled,
      createdAt: (i as any).createdAt?.toISOString?.() ?? null,
      updatedAt: (i as any).updatedAt?.toISOString?.() ?? null,
    })),
  });
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

  const createData = {
    projectId,
    type: "polar",
    config: parsed.data,
    enabled: true,
  };
  const updateData = {
    config: parsed.data,
    enabled: true,
  };
  const integration = await Integration.findOneAndUpdate(
    { projectId, type: "polar" },
    { $set: updateData, $setOnInsert: createData },
    { upsert: true, returnDocument: "after" }
  );

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

  await Integration.deleteMany({ projectId, type: "polar" });

  return c.json({ ok: true });
});

export default integrations;

// ── Public webhook receiver (separate Hono app, mounted at /public) ──

export const polarWebhookHandler = new Hono();

polarWebhookHandler.post("/webhooks/polar/:projectId", async (c) => {
  const projectId = c.req.param("projectId");

  const integration = await Integration.findOne({ projectId, type: "polar" });

  if (!integration || !integration.enabled) {
    return c.json({ error: "Integration not found" }, 404);
  }

  const config = integration.config as { webhookSecret: string };
  const rawBody = await c.req.raw.text();

  const webhookId = c.req.header("webhook-id") || "";
  const webhookTimestamp = c.req.header("webhook-timestamp") || "";
  const webhookSignature = c.req.header("webhook-signature") || "";

  try {
    const encodedSecret = Buffer.from(config.webhookSecret).toString("base64");
    const wh = new Webhook(encodedSecret);
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
    const visitor = await Visitor.findOne({ projectId, visitorId: metaVisitorId }).select("visitorId").lean();
    if (visitor) matchedVisitorId = visitor.visitorId;
  }

  if (!matchedVisitorId && customerEmail) {
    const visitor = await Visitor.findOne({ projectId, email: customerEmail.toLowerCase() })
      .select("visitorId")
      .lean();
    if (visitor) matchedVisitorId = visitor.visitorId;
  }

  await CustomerEvent.create({
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
  });

  const customerName: string | null = data.customer?.name || null;

  // Update visitor with payment data and customer details
  if (matchedVisitorId && ceType === "purchase" && amount) {
    const setFields: Record<string, unknown> = {};
    if (customerName) setFields.name = customerName;
    if (customerEmail) setFields.email = customerEmail.toLowerCase();
    if (data.customer?.id) setFields.polarCustomerId = data.customer.id;

    await Visitor.findOneAndUpdate(
      { projectId, visitorId: matchedVisitorId },
      {
        $inc: { totalRevenue: amount },
        ...(Object.keys(setFields).length > 0 && { $set: setFields }),
      }
    );
  } else if (matchedVisitorId && ceType === "refund" && amount) {
    await Visitor.findOneAndUpdate(
      { projectId, visitorId: matchedVisitorId },
      { $inc: { totalRevenue: -amount } }
    );
  } else if (matchedVisitorId && (ceType === "subscription_created" || ceType === "subscription_canceled")) {
    const visitorUpdate: Record<string, unknown> = {};
    if (customerName) visitorUpdate.name = customerName;
    if (customerEmail) visitorUpdate.email = customerEmail.toLowerCase();
    if (data.customer?.id) visitorUpdate.polarCustomerId = data.customer.id;
    if (Object.keys(visitorUpdate).length > 0) {
      await Visitor.findOneAndUpdate({ projectId, visitorId: matchedVisitorId }, visitorUpdate);
    }
  }

  broadcast(projectId, "purchase", {
    visitorId: matchedVisitorId,
    type: ceType,
    amount,
    currency,
    productName,
    customerEmail,
    customerName,
    timestamp: new Date().toISOString(),
  });

  return c.json({ received: true });
});
