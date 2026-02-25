import { Hono } from "hono";
import { z } from "zod";
import Stripe from "stripe";
import { prisma } from "../db/index.js";
import { sendEmail } from "../email/send.js";
import * as templates from "../email/templates.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

type AuthEnv = { Variables: { userId: string } };
const admin = new Hono<AuthEnv>();

const PAGE_SIZE = 20;

// ─── Dashboard stats ───

admin.get("/stats", async (c) => {
  const [
    totalUsers,
    activeSubscriptions,
    totalProjects,
    totalEvents,
    subscriptions,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.subscription.count({ where: { status: "active" } }),
    prisma.project.count(),
    prisma.event.count(),
    prisma.subscription.findMany({
      where: { status: "active" },
      select: { interval: true, planId: true },
    }),
  ]);

  const plans = await prisma.plan.findMany();
  const planMap = new Map(plans.map((p) => [p.id, p]));

  let mrr = 0;
  for (const sub of subscriptions) {
    const plan = planMap.get(sub.planId);
    if (!plan) continue;
    if (sub.interval === "year") {
      mrr += plan.yearlyPrice / 12;
    } else {
      mrr += plan.monthlyPrice;
    }
  }

  return c.json({
    totalUsers,
    activeSubscriptions,
    mrr: Math.round(mrr),
    totalProjects,
    totalEvents,
  });
});

// ─── Users ───

admin.get("/users", async (c) => {
  const page = parseInt(c.req.query("page") || "1");
  const search = c.req.query("search") || "";
  const skip = (page - 1) * PAGE_SIZE;

  const where = search
    ? {
        OR: [
          { email: { contains: search, mode: "insensitive" as const } },
          { name: { contains: search, mode: "insensitive" as const } },
        ],
      }
    : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: PAGE_SIZE,
      orderBy: { createdAt: "desc" },
      include: {
        subscription: { select: { status: true, interval: true } },
        _count: { select: { projects: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return c.json({
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      subscriptionStatus: u.subscription?.status || null,
      subscriptionInterval: u.subscription?.interval || null,
      projectsCount: u._count.projects,
      createdAt: u.createdAt.toISOString(),
    })),
    total,
    pages: Math.ceil(total / PAGE_SIZE),
  });
});

admin.get("/users/:id", async (c) => {
  const user = await prisma.user.findUnique({
    where: { id: c.req.param("id") },
    include: {
      subscription: true,
      projects: { select: { id: true, name: true, siteUrl: true, createdAt: true } },
    },
  });
  if (!user) return c.json({ error: "User not found" }, 404);

  return c.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    googleId: !!user.googleId,
    hasPassword: !!user.passwordHash,
    stripeCustomerId: user.stripeCustomerId,
    subscription: user.subscription
      ? {
          id: user.subscription.id,
          status: user.subscription.status,
          interval: user.subscription.interval,
          planId: user.subscription.planId,
          currentPeriodEnd: user.subscription.currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: user.subscription.cancelAtPeriodEnd,
        }
      : null,
    projects: user.projects,
    createdAt: user.createdAt.toISOString(),
  });
});

admin.delete("/users/:id", async (c) => {
  const userId = c.req.param("id");
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return c.json({ error: "User not found" }, 404);

  const projects = await prisma.project.findMany({ where: { userId }, select: { id: true } });
  const projectIds = projects.map((p) => p.id);

  if (projectIds.length > 0) {
    const elements = await prisma.elementConfig.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true },
    });
    const elementIds = elements.map((e) => e.id);
    if (elementIds.length > 0) {
      await prisma.rule.deleteMany({ where: { elementId: { in: elementIds } } });
      await prisma.variant.deleteMany({ where: { elementId: { in: elementIds } } });
      await prisma.elementConfig.deleteMany({ where: { id: { in: elementIds } } });
    }
    await prisma.audience.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.event.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.project.deleteMany({ where: { userId } });
  }

  await prisma.subscription.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });

  return c.json({ message: "User deleted" });
});

admin.post("/users/:id/grant-subscription", async (c) => {
  const userId = c.req.param("id");
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return c.json({ error: "User not found" }, 404);

  const plan = await prisma.plan.findFirst({ where: { active: true }, orderBy: { monthlyPrice: "desc" } });
  if (!plan) return c.json({ error: "No active plan" }, 400);

  const now = new Date();
  const endDate = new Date(now);
  endDate.setFullYear(endDate.getFullYear() + 100);

  await prisma.subscription.upsert({
    where: { userId },
    create: {
      userId,
      planId: plan.id,
      stripeSubscriptionId: `admin_grant_${userId}_${Date.now()}`,
      stripeCustomerId: user.stripeCustomerId || "admin_grant",
      status: "active",
      interval: "year",
      currentPeriodStart: now,
      currentPeriodEnd: endDate,
      cancelAtPeriodEnd: false,
    },
    update: {
      planId: plan.id,
      status: "active",
      currentPeriodEnd: endDate,
      cancelAtPeriodEnd: false,
    },
  });

  return c.json({ message: "Subscription granted" });
});

admin.post("/users/:id/revoke-subscription", async (c) => {
  const userId = c.req.param("id");
  await prisma.subscription.deleteMany({ where: { userId } });
  return c.json({ message: "Subscription revoked" });
});

// ─── Subscriptions ───

admin.get("/subscriptions", async (c) => {
  const page = parseInt(c.req.query("page") || "1");
  const status = c.req.query("status") || "";
  const skip = (page - 1) * PAGE_SIZE;

  const where = status ? { status } : {};

  const [subs, total] = await Promise.all([
    prisma.subscription.findMany({
      where,
      skip,
      take: PAGE_SIZE,
      orderBy: { createdAt: "desc" },
      include: { user: { select: { email: true, name: true } } },
    }),
    prisma.subscription.count({ where }),
  ]);

  const plans = await prisma.plan.findMany();
  const planMap = new Map(plans.map((p) => [p.id, p]));

  return c.json({
    subscriptions: subs.map((s) => ({
      id: s.id,
      userId: s.userId,
      userEmail: s.user.email,
      userName: s.user.name,
      planName: planMap.get(s.planId)?.name || "Unknown",
      status: s.status,
      interval: s.interval,
      currentPeriodEnd: s.currentPeriodEnd.toISOString(),
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    })),
    total,
    pages: Math.ceil(total / PAGE_SIZE),
  });
});

const patchSubSchema = z.object({
  planId: z.string().optional(),
  status: z.string().optional(),
  extendDays: z.number().optional(),
});

admin.patch("/subscriptions/:id", async (c) => {
  const sub = await prisma.subscription.findUnique({ where: { id: c.req.param("id") } });
  if (!sub) return c.json({ error: "Subscription not found" }, 404);

  const body = await c.req.json();
  const parsed = patchSubSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 400);

  const data: Record<string, unknown> = {};
  if (parsed.data.planId) data.planId = parsed.data.planId;
  if (parsed.data.status) data.status = parsed.data.status;
  if (parsed.data.extendDays) {
    const newEnd = new Date(sub.currentPeriodEnd);
    newEnd.setDate(newEnd.getDate() + parsed.data.extendDays);
    data.currentPeriodEnd = newEnd;
  }

  const updated = await prisma.subscription.update({ where: { id: sub.id }, data });
  return c.json(updated);
});

// ─── Projects ───

admin.get("/projects", async (c) => {
  const page = parseInt(c.req.query("page") || "1");
  const search = c.req.query("search") || "";
  const skip = (page - 1) * PAGE_SIZE;

  const where = search
    ? {
        OR: [
          { name: { contains: search, mode: "insensitive" as const } },
          { siteUrl: { contains: search, mode: "insensitive" as const } },
        ],
      }
    : {};

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      skip,
      take: PAGE_SIZE,
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { email: true } },
        _count: { select: { elements: true } },
      },
    }),
    prisma.project.count({ where }),
  ]);

  return c.json({
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      siteUrl: p.siteUrl,
      ownerEmail: p.user.email,
      elementsCount: p._count.elements,
      createdAt: p.createdAt.toISOString(),
    })),
    total,
    pages: Math.ceil(total / PAGE_SIZE),
  });
});

admin.get("/projects/:id", async (c) => {
  const project = await prisma.project.findUnique({
    where: { id: c.req.param("id") },
    include: {
      user: { select: { email: true, name: true } },
      elements: { include: { variants: true, rules: true } },
      audiences: true,
    },
  });
  if (!project) return c.json({ error: "Project not found" }, 404);
  return c.json(project);
});

admin.delete("/projects/:id", async (c) => {
  const projectId = c.req.param("id");
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return c.json({ error: "Project not found" }, 404);

  const elements = await prisma.elementConfig.findMany({
    where: { projectId },
    select: { id: true },
  });
  const elementIds = elements.map((e) => e.id);
  if (elementIds.length > 0) {
    await prisma.rule.deleteMany({ where: { elementId: { in: elementIds } } });
    await prisma.variant.deleteMany({ where: { elementId: { in: elementIds } } });
    await prisma.elementConfig.deleteMany({ where: { id: { in: elementIds } } });
  }
  await prisma.audience.deleteMany({ where: { projectId } });
  await prisma.event.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });

  return c.json({ message: "Project deleted" });
});

// ─── Plans ───

admin.get("/plans", async (c) => {
  const plans = await prisma.plan.findMany({ orderBy: { createdAt: "asc" } });
  return c.json(plans);
});

const patchPlanSchema = z.object({
  name: z.string().optional(),
  monthlyPrice: z.number().optional(),
  yearlyPrice: z.number().optional(),
  features: z.array(z.string()).optional(),
  active: z.boolean().optional(),
});

admin.patch("/plans/:id", async (c) => {
  const plan = await prisma.plan.findUnique({ where: { id: c.req.param("id") } });
  if (!plan) return c.json({ error: "Plan not found" }, 404);

  const body = await c.req.json();
  const parsed = patchPlanSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 400);

  const updated = await prisma.plan.update({
    where: { id: plan.id },
    data: parsed.data,
  });

  return c.json(updated);
});

// ─── Marketing Emails ───

const MARKETING_TEMPLATES = [
  "onboardingDay1",
  "onboardingDay3",
  "onboardingDay7",
  "inactiveReminder",
  "trialEnding",
  "featureAnnouncement",
  "reviewRequest",
  "winBack",
] as const;

const RECIPIENT_FILTERS = [
  "all",
  "active",
  "inactive_7d",
  "canceled",
  "no_subscription",
] as const;

const sendEmailsSchema = z.object({
  template: z.enum(MARKETING_TEMPLATES),
  recipientFilter: z.union([z.enum(RECIPIENT_FILTERS), z.array(z.string())]),
  customFields: z
    .object({
      title: z.string().optional(),
      body: z.string().optional(),
      daysLeft: z.number().optional(),
    })
    .optional(),
});

admin.get("/emails/templates", (c) => {
  return c.json({
    templates: MARKETING_TEMPLATES,
    filters: RECIPIENT_FILTERS,
  });
});

admin.post("/emails/send", async (c) => {
  const body = await c.req.json();
  const parsed = sendEmailsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 400);

  const { template, recipientFilter, customFields } = parsed.data;

  let users: { id: string; email: string; name: string | null }[];

  if (Array.isArray(recipientFilter)) {
    users = await prisma.user.findMany({
      where: { id: { in: recipientFilter } },
      select: { id: true, email: true, name: true },
    });
  } else {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const filterMap: Record<string, object> = {
      all: {},
      active: { subscription: { status: "active" } },
      inactive_7d: { updatedAt: { lt: sevenDaysAgo } },
      canceled: { subscription: { status: "canceled" } },
      no_subscription: { subscription: null },
    };
    users = await prisma.user.findMany({
      where: filterMap[recipientFilter] || {},
      select: { id: true, email: true, name: true },
    });
  }

  let sent = 0;
  for (const user of users) {
    const name = user.name || "";
    let tpl: { subject: string; html: string };

    switch (template) {
      case "onboardingDay1":
        tpl = templates.onboardingDay1Email(name);
        break;
      case "onboardingDay3":
        tpl = templates.onboardingDay3Email(name);
        break;
      case "onboardingDay7":
        tpl = templates.onboardingDay7Email(name);
        break;
      case "inactiveReminder":
        tpl = templates.inactiveReminderEmail(name);
        break;
      case "trialEnding":
        tpl = templates.trialEndingEmail(name, customFields?.daysLeft ?? 3);
        break;
      case "featureAnnouncement":
        tpl = templates.featureAnnouncementEmail(
          name,
          customFields?.title || "New Feature",
          customFields?.body || ""
        );
        break;
      case "reviewRequest":
        tpl = templates.reviewRequestEmail(name);
        break;
      case "winBack":
        tpl = templates.winBackEmail(name);
        break;
    }

    await sendEmail(user.email, tpl.subject, tpl.html);
    sent++;
  }

  return c.json({ sent, total: users.length });
});

// ─── Coupons (Stripe Promotion Codes) ───

admin.get("/coupons", async (c) => {
  try {
    const promotionCodes = await stripe.promotionCodes.list({ limit: 50, expand: ["data.coupon"] });
    return c.json({
      coupons: promotionCodes.data.map((pc) => {
        const coupon = typeof pc.coupon === "object" && pc.coupon ? pc.coupon : null;
        return {
          id: pc.id,
          code: pc.code,
          active: pc.active,
          couponId: coupon?.id || (typeof pc.coupon === "string" ? pc.coupon : null),
          percentOff: coupon?.percent_off ?? null,
          amountOff: coupon?.amount_off ?? null,
          currency: coupon?.currency ?? null,
          duration: coupon?.duration ?? null,
          timesRedeemed: coupon?.times_redeemed ?? 0,
          maxRedemptions: pc.max_redemptions,
          created: new Date(pc.created * 1000).toISOString(),
        };
      }),
    });
  } catch (err) {
    return c.json({ error: "Failed to fetch coupons", detail: String(err) }, 500);
  }
});

const createCouponSchema = z.object({
  code: z.string().min(1).max(30),
  percentOff: z.number().min(1).max(100).optional(),
  amountOff: z.number().min(1).optional(),
  currency: z.string().default("usd"),
  duration: z.enum(["once", "repeating", "forever"]).default("once"),
  durationInMonths: z.number().optional(),
  maxRedemptions: z.number().optional(),
});

admin.post("/coupons", async (c) => {
  const body = await c.req.json();
  const parsed = createCouponSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 400);

  try {
    const couponData: Stripe.CouponCreateParams = {
      duration: parsed.data.duration,
    };
    if (parsed.data.percentOff) couponData.percent_off = parsed.data.percentOff;
    else if (parsed.data.amountOff) {
      couponData.amount_off = parsed.data.amountOff;
      couponData.currency = parsed.data.currency;
    }
    if (parsed.data.duration === "repeating" && parsed.data.durationInMonths) {
      couponData.duration_in_months = parsed.data.durationInMonths;
    }

    const coupon = await stripe.coupons.create(couponData);

    const promoCode = await stripe.promotionCodes.create({
      coupon: coupon.id,
      code: parsed.data.code.toUpperCase(),
      max_redemptions: parsed.data.maxRedemptions || undefined,
    });

    return c.json({
      id: promoCode.id,
      code: promoCode.code,
      couponId: coupon.id,
    });
  } catch (err) {
    return c.json({ error: "Failed to create coupon", detail: String(err) }, 500);
  }
});

admin.post("/coupons/:id/deactivate", async (c) => {
  try {
    await stripe.promotionCodes.update(c.req.param("id"), { active: false });
    return c.json({ message: "Coupon deactivated" });
  } catch (err) {
    return c.json({ error: "Failed to deactivate", detail: String(err) }, 500);
  }
});

export default admin;
