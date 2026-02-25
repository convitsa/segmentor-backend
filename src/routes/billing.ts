import { Hono } from "hono";
import { z } from "zod";
import Stripe from "stripe";
import { prisma } from "../db/index.js";
import { requireAuth } from "../auth/middleware.js";
import { fireEmail } from "../email/send.js";
import {
  subscriptionCreatedEmail,
  subscriptionUpdatedEmail,
  subscriptionCanceledEmail,
  paymentFailedEmail,
} from "../email/templates.js";
import { captureEvent } from "../lib/posthog.js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

const stripe = new Stripe(STRIPE_SECRET_KEY);

const MAX_PROCESSED_EVENTS = 10_000;
const processedWebhookEvents = new Set<string>();

type AuthEnv = { Variables: { userId: string } };
const billing = new Hono<AuthEnv>();

// ─── Public: list active plans ───

billing.get("/plans", async (c) => {
  const plans = await prisma.plan.findMany({
    where: { active: true },
    orderBy: { monthlyPrice: "asc" },
  });

  return c.json(
    plans.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      monthlyPrice: p.monthlyPrice,
      yearlyPrice: p.yearlyPrice,
      features: p.features,
    }))
  );
});

// ─── Auth: get current subscription ───

billing.get("/subscription", requireAuth, async (c) => {
  const userId = c.get("userId");

  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub) {
    return c.json({ subscription: null });
  }

  const plan = await prisma.plan.findUnique({ where: { id: sub.planId } });

  return c.json({
    subscription: {
      id: sub.id,
      status: sub.status,
      interval: sub.interval,
      currentPeriodStart: sub.currentPeriodStart.toISOString(),
      currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      plan: plan
        ? { id: plan.id, name: plan.name, slug: plan.slug, monthlyPrice: plan.monthlyPrice, yearlyPrice: plan.yearlyPrice }
        : null,
    },
  });
});

// ─── Auth: create Stripe Checkout session ───

const checkoutSchema = z.object({
  planId: z.string().min(1),
  interval: z.enum(["month", "year"]),
});

billing.post("/checkout", requireAuth, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const { planId, interval } = parsed.data;

  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.active) {
    return c.json({ error: "Plan not found" }, 404);
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return c.json({ error: "User not found" }, 404);

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId: user.id },
    });
    customerId = customer.id;
    await prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: customerId },
    });
  }

  const priceId = interval === "year" ? plan.stripePriceIdYearly : plan.stripePriceIdMonthly;

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${CORS_ORIGIN}/dashboard/projects?checkout=success`,
    cancel_url: `${CORS_ORIGIN}/billing?checkout=canceled`,
    metadata: { userId, planId, interval },
  });

  return c.json({ url: session.url });
});

// ─── Auth: create Stripe Customer Portal session ───

billing.post("/portal", requireAuth, async (c) => {
  const userId = c.get("userId");
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.stripeCustomerId) {
    return c.json({ error: "No billing account found" }, 400);
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${CORS_ORIGIN}/dashboard/settings`,
  });

  return c.json({ url: session.url });
});

// ─── Public: Stripe webhook ───

billing.post("/webhook", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "Missing stripe-signature header" }, 400);
  }

  const rawBody = await c.req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return c.json({ error: "Invalid signature" }, 400);
  }

  if (processedWebhookEvents.has(event.id)) {
    return c.json({ received: true });
  }
  processedWebhookEvents.add(event.id);
  if (processedWebhookEvents.size > MAX_PROCESSED_EVENTS) {
    const first = processedWebhookEvents.values().next().value;
    if (first) processedWebhookEvents.delete(first);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription" || !session.subscription) break;

      const userId = session.metadata?.userId;
      const planId = session.metadata?.planId;
      const interval = session.metadata?.interval || "month";
      if (!userId || !planId) break;

      const stripeSub = await stripe.subscriptions.retrieve(session.subscription as string);
      const item = stripeSub.items.data[0];
      const periodStart = item ? new Date(item.current_period_start * 1000) : new Date();
      const periodEnd = item ? new Date(item.current_period_end * 1000) : new Date();

      await prisma.subscription.upsert({
        where: { userId },
        create: {
          userId,
          planId,
          stripeSubscriptionId: stripeSub.id,
          stripeCustomerId: stripeSub.customer as string,
          status: stripeSub.status,
          interval,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
        },
        update: {
          planId,
          stripeSubscriptionId: stripeSub.id,
          stripeCustomerId: stripeSub.customer as string,
          status: stripeSub.status,
          interval,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
        },
      });

      const checkoutUser = await prisma.user.findUnique({ where: { id: userId } });
      const checkoutPlan = await prisma.plan.findUnique({ where: { id: planId } });
      if (checkoutUser && checkoutPlan) {
        const amount = interval === "year" ? checkoutPlan.yearlyPrice : checkoutPlan.monthlyPrice;
        const tpl = subscriptionCreatedEmail(checkoutPlan.name, interval, amount);
        fireEmail(checkoutUser.email, tpl.subject, tpl.html);
        captureEvent(userId, "subscription_created", { plan: checkoutPlan.name, interval, amount });
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const existing = await prisma.subscription.findUnique({
        where: { stripeSubscriptionId: sub.id },
      });
      if (!existing) break;

      const subItem = sub.items.data[0];
      const priceId = subItem?.price?.id;
      let interval = existing.interval;
      if (priceId) {
        const plan = await prisma.plan.findFirst({
          where: {
            OR: [
              { stripePriceIdMonthly: priceId },
              { stripePriceIdYearly: priceId },
            ],
          },
        });
        if (plan) {
          interval = priceId === plan.stripePriceIdYearly ? "year" : "month";
        }
      }

      const updPeriodStart = subItem ? new Date(subItem.current_period_start * 1000) : undefined;
      const updPeriodEnd = subItem ? new Date(subItem.current_period_end * 1000) : undefined;

      await prisma.subscription.update({
        where: { stripeSubscriptionId: sub.id },
        data: {
          status: sub.status,
          interval,
          ...(updPeriodStart && { currentPeriodStart: updPeriodStart }),
          ...(updPeriodEnd && { currentPeriodEnd: updPeriodEnd }),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        },
      });

      const updUser = await prisma.user.findUnique({ where: { id: existing.userId } });
      if (updUser && priceId) {
        const updPlan = await prisma.plan.findFirst({
          where: { OR: [{ stripePriceIdMonthly: priceId }, { stripePriceIdYearly: priceId }] },
        });
        if (updPlan) {
          const tpl = subscriptionUpdatedEmail(updPlan.name, interval);
          fireEmail(updUser.email, tpl.subject, tpl.html);
          captureEvent(existing.userId, "subscription_updated", { plan: updPlan.name, interval, status: sub.status });
        }
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const canceledSub = await prisma.subscription.findUnique({
        where: { stripeSubscriptionId: sub.id },
        include: { user: true },
      });
      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: sub.id },
        data: { status: "canceled" },
      });
      if (canceledSub?.user) {
        const tpl = subscriptionCanceledEmail();
        fireEmail(canceledSub.user.email, tpl.subject, tpl.html);
        captureEvent(canceledSub.userId, "subscription_canceled");
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const subRef = invoice.parent?.subscription_details?.subscription;
      const subId = typeof subRef === "string" ? subRef : subRef?.id;
      if (subId) {
        const failedSub = await prisma.subscription.findUnique({
          where: { stripeSubscriptionId: subId },
          include: { user: true },
        });
        await prisma.subscription.updateMany({
          where: { stripeSubscriptionId: subId },
          data: { status: "past_due" },
        });
        if (failedSub?.user) {
          const tpl = paymentFailedEmail();
          fireEmail(failedSub.user.email, tpl.subject, tpl.html);
          captureEvent(failedSub.userId, "payment_failed");
        }
      }
      break;
    }
  }

  return c.json({ received: true });
});

export default billing;
