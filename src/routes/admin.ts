import { Hono } from "hono";
import { z } from "zod";
import Stripe from "stripe";
import {
  User,
  Plan,
  Subscription,
  Project,
  ElementConfig,
  Rule,
  Variant,
  Audience,
  Event,
} from "../db/models.js";
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
    User.countDocuments(),
    Subscription.countDocuments({ status: "active" }),
    Project.countDocuments(),
    Event.countDocuments(),
    Subscription.find({ status: "active" }).select("interval planId").lean(),
  ]);

  const plans = await Plan.find().lean();
  const planMap = new Map(plans.map((p) => [p._id.toString(), p]));

  let mrr = 0;
  for (const sub of subscriptions) {
    const plan = planMap.get(sub.planId.toString());
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

  const mongoWhere = search
    ? {
        $or: [
          { email: { $regex: search, $options: "i" } },
          { name: { $regex: search, $options: "i" } },
        ],
      }
    : {};

  const [users, total] = await Promise.all([
    User.find(mongoWhere).sort({ createdAt: -1 }).skip(skip).limit(PAGE_SIZE).lean(),
    User.countDocuments(mongoWhere),
  ]);

  const userIds = users.map((u) => u._id);
  const [subscriptions, projectCounts] = await Promise.all([
    Subscription.find({ userId: { $in: userIds } }).select("userId status interval").lean(),
    Project.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { _id: "$userId", count: { $sum: 1 } } },
    ]),
  ]);

  const subMap = new Map(subscriptions.map((s) => [s.userId.toString(), s]));
  const countMap = new Map(projectCounts.map((pc) => [pc._id.toString(), pc.count]));

  return c.json({
    users: users.map((u) => {
      const sub = subMap.get(u._id.toString());
      return {
        id: u._id.toString(),
        email: u.email,
        name: u.name,
        role: u.role,
        subscriptionStatus: sub?.status ?? null,
        subscriptionInterval: sub?.interval ?? null,
        projectsCount: countMap.get(u._id.toString()) ?? 0,
        createdAt: u.createdAt.toISOString(),
      };
    }),
    total,
    pages: Math.ceil(total / PAGE_SIZE),
  });
});

admin.get("/users/:id", async (c) => {
  const userId = c.req.param("id");
  const user = await User.findById(userId).lean();
  if (!user) return c.json({ error: "User not found" }, 404);

  const [subscription, projects] = await Promise.all([
    Subscription.findOne({ userId }).lean(),
    Project.find({ userId }).select("_id name siteUrl createdAt").lean(),
  ]);

  return c.json({
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    role: user.role,
    googleId: !!user.googleId,
    hasPassword: !!user.passwordHash,
    stripeCustomerId: user.stripeCustomerId,
    subscription: subscription
      ? {
          id: subscription._id.toString(),
          status: subscription.status,
          interval: subscription.interval,
          planId: subscription.planId.toString(),
          currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        }
      : null,
    projects: projects.map((p) => ({
      id: p._id.toString(),
      name: p.name,
      siteUrl: p.siteUrl,
      createdAt: p.createdAt.toISOString(),
    })),
    createdAt: user.createdAt.toISOString(),
  });
});

admin.delete("/users/:id", async (c) => {
  const userId = c.req.param("id");
  const user = await User.findById(userId);
  if (!user) return c.json({ error: "User not found" }, 404);

  const projects = await Project.find({ userId }).select("_id").lean();
  const projectIds = projects.map((p) => p._id);

  if (projectIds.length > 0) {
    const elements = await ElementConfig.find({ projectId: { $in: projectIds } }).select("_id").lean();
    const elementIds = elements.map((e) => e._id);
    if (elementIds.length > 0) {
      await Rule.deleteMany({ elementId: { $in: elementIds } });
      await Variant.deleteMany({ elementId: { $in: elementIds } });
      await ElementConfig.deleteMany({ _id: { $in: elementIds } });
    }
    await Audience.deleteMany({ projectId: { $in: projectIds } });
    await Event.deleteMany({ projectId: { $in: projectIds } });
    await Project.deleteMany({ userId });
  }

  await Subscription.deleteMany({ userId });
  await User.findByIdAndDelete(userId);

  return c.json({ message: "User deleted" });
});

admin.post("/users/:id/grant-subscription", async (c) => {
  const userId = c.req.param("id");
  const user = await User.findById(userId);
  if (!user) return c.json({ error: "User not found" }, 404);

  const plan = await Plan.findOne({ active: true }).sort({ monthlyPrice: -1 });
  if (!plan) return c.json({ error: "No active plan" }, 400);

  const now = new Date();
  const endDate = new Date(now);
  endDate.setFullYear(endDate.getFullYear() + 100);

  const createData = {
    userId,
    planId: plan.id,
    stripeSubscriptionId: `admin_grant_${userId}_${Date.now()}`,
    stripeCustomerId: user.stripeCustomerId || "admin_grant",
    status: "active",
    interval: "year",
    currentPeriodStart: now,
    currentPeriodEnd: endDate,
    cancelAtPeriodEnd: false,
  };
  const updateData = {
    planId: plan.id,
    status: "active",
    currentPeriodEnd: endDate,
    cancelAtPeriodEnd: false,
  };
  await Subscription.findOneAndUpdate(
    { userId },
    { $set: updateData, $setOnInsert: createData },
    { upsert: true, returnDocument: "after" }
  );

  return c.json({ message: "Subscription granted" });
});

admin.post("/users/:id/revoke-subscription", async (c) => {
  const userId = c.req.param("id");
  await Subscription.deleteMany({ userId });
  return c.json({ message: "Subscription revoked" });
});

// ─── Subscriptions ───

admin.get("/subscriptions", async (c) => {
  const page = parseInt(c.req.query("page") || "1");
  const status = c.req.query("status") || "";
  const skip = (page - 1) * PAGE_SIZE;

  const where = status ? { status } : {};

  const [subs, total] = await Promise.all([
    Subscription.find(where).sort({ createdAt: -1 }).skip(skip).limit(PAGE_SIZE).lean(),
    Subscription.countDocuments(where),
  ]);

  const userIds = subs.map((s) => s.userId);
  const plans = await Plan.find().lean();
  const users = await User.find({ _id: { $in: userIds } }).select("email name").lean();

  const planMap = new Map(plans.map((p) => [p._id.toString(), p]));
  const userMap = new Map(users.map((u) => [u._id.toString(), u]));

  return c.json({
    subscriptions: subs.map((s) => {
      const u = userMap.get(s.userId.toString());
      return {
        id: s._id.toString(),
        userId: s.userId.toString(),
        userEmail: u?.email ?? null,
        userName: u?.name ?? null,
        planName: planMap.get(s.planId.toString())?.name ?? "Unknown",
        status: s.status,
        interval: s.interval,
        currentPeriodEnd: s.currentPeriodEnd.toISOString(),
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      };
    }),
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
  const sub = await Subscription.findById(c.req.param("id"));
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

  const updated = await Subscription.findByIdAndUpdate(sub.id, data, { returnDocument: "after" });
  return c.json(updated);
});

// ─── Projects ───

admin.get("/projects", async (c) => {
  const page = parseInt(c.req.query("page") || "1");
  const search = c.req.query("search") || "";
  const skip = (page - 1) * PAGE_SIZE;

  const mongoWhere = search
    ? {
        $or: [
          { name: { $regex: search, $options: "i" } },
          { siteUrl: { $regex: search, $options: "i" } },
        ],
      }
    : {};

  const [projects, total] = await Promise.all([
    Project.find(mongoWhere).sort({ createdAt: -1 }).skip(skip).limit(PAGE_SIZE).lean(),
    Project.countDocuments(mongoWhere),
  ]);

  const projectIds = projects.map((p) => p._id);
  const userIds = [...new Set(projects.map((p) => p.userId.toString()))];
  const [users, elementCounts] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select("_id email").lean(),
    ElementConfig.aggregate([
      { $match: { projectId: { $in: projectIds } } },
      { $group: { _id: "$projectId", count: { $sum: 1 } } },
    ]),
  ]);

  const userMap = new Map(users.map((u) => [u._id.toString(), u]));
  const countMap = new Map(elementCounts.map((ec) => [ec._id.toString(), ec.count]));

  return c.json({
    projects: projects.map((p) => ({
      id: p._id.toString(),
      name: p.name,
      siteUrl: p.siteUrl,
      ownerEmail: userMap.get(p.userId.toString())?.email ?? null,
      elementsCount: countMap.get(p._id.toString()) ?? 0,
      createdAt: p.createdAt.toISOString(),
    })),
    total,
    pages: Math.ceil(total / PAGE_SIZE),
  });
});

admin.get("/projects/:id", async (c) => {
  const projectId = c.req.param("id");
  const project = await Project.findById(projectId).lean();
  if (!project) return c.json({ error: "Project not found" }, 404);

  const [owner, elements, audiences] = await Promise.all([
    User.findById(project.userId).select("email name").lean(),
    ElementConfig.find({ projectId }).lean(),
    Audience.find({ projectId }).lean(),
  ]);

  const elementIds = elements.map((e) => e._id);
  const [variants, rules] = await Promise.all([
    Variant.find({ elementId: { $in: elementIds } }).lean(),
    Rule.find({ elementId: { $in: elementIds } }).lean(),
  ]);

  const variantMap = new Map<string, typeof variants>();
  for (const v of variants) {
    const key = v.elementId.toString();
    if (!variantMap.has(key)) variantMap.set(key, []);
    variantMap.get(key)!.push(v);
  }
  const ruleMap = new Map<string, typeof rules>();
  for (const r of rules) {
    const key = r.elementId.toString();
    if (!ruleMap.has(key)) ruleMap.set(key, []);
    ruleMap.get(key)!.push(r);
  }

  const elementsWithRelations = elements.map((e) => ({
    ...e,
    id: e._id.toString(),
    variants: (variantMap.get(e._id.toString()) ?? []).map((v) => ({ ...v, id: v._id.toString() })),
    rules: (ruleMap.get(e._id.toString()) ?? []).map((r) => ({ ...r, id: r._id.toString() })),
  }));

  return c.json({
    ...project,
    id: project._id.toString(),
    user: owner ? { email: owner.email, name: owner.name } : null,
    elements: elementsWithRelations,
    audiences: audiences.map((a) => ({ ...a, id: a._id.toString() })),
  });
});

admin.delete("/projects/:id", async (c) => {
  const projectId = c.req.param("id");
  const project = await Project.findById(projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const elements = await ElementConfig.find({ projectId }).select("_id").lean();
  const elementIds = elements.map((e) => e._id);
  if (elementIds.length > 0) {
    await Rule.deleteMany({ elementId: { $in: elementIds } });
    await Variant.deleteMany({ elementId: { $in: elementIds } });
    await ElementConfig.deleteMany({ _id: { $in: elementIds } });
  }
  await Audience.deleteMany({ projectId });
  await Event.deleteMany({ projectId });
  await Project.findByIdAndDelete(projectId);

  return c.json({ message: "Project deleted" });
});

// ─── Plans ───

admin.get("/plans", async (c) => {
  const plans = await Plan.find().sort({ createdAt: 1 });
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
  const plan = await Plan.findById(c.req.param("id"));
  if (!plan) return c.json({ error: "Plan not found" }, 404);

  const body = await c.req.json();
  const parsed = patchPlanSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten().fieldErrors }, 400);

  const updated = await Plan.findByIdAndUpdate(plan.id, parsed.data, { returnDocument: "after" });
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
    const found = await User.find({ _id: { $in: recipientFilter } }).select("_id email name").lean();
    users = found.map((u) => ({
      id: u._id.toString(),
      email: u.email,
      name: u.name ?? null,
    }));
  } else {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    if (recipientFilter === "all") {
      const found = await User.find({}).select("_id email name").lean();
      users = found.map((u) => ({
        id: u._id.toString(),
        email: u.email,
        name: u.name ?? null,
      }));
    } else if (recipientFilter === "active") {
      const activeSubs = await Subscription.find({ status: "active" }).select("userId").lean();
      const userIds = activeSubs.map((s) => s.userId);
      const found = await User.find({ _id: { $in: userIds } }).select("_id email name").lean();
      users = found.map((u) => ({
        id: u._id.toString(),
        email: u.email,
        name: u.name ?? null,
      }));
    } else if (recipientFilter === "inactive_7d") {
      const found = await User.find({ updatedAt: { $lt: sevenDaysAgo } }).select("_id email name").lean();
      users = found.map((u) => ({
        id: u._id.toString(),
        email: u.email,
        name: u.name ?? null,
      }));
    } else if (recipientFilter === "canceled") {
      const canceledSubs = await Subscription.find({ status: "canceled" }).select("userId").lean();
      const userIds = canceledSubs.map((s) => s.userId);
      const found = await User.find({ _id: { $in: userIds } }).select("_id email name").lean();
      users = found.map((u) => ({
        id: u._id.toString(),
        email: u.email,
        name: u.name ?? null,
      }));
    } else if (recipientFilter === "no_subscription") {
      const subUserIds = await Subscription.distinct("userId");
      const found = await User.find({ _id: { $nin: subUserIds } }).select("_id email name").lean();
      users = found.map((u) => ({
        id: u._id.toString(),
        email: u.email,
        name: u.name ?? null,
      }));
    } else {
      users = [];
    }
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
