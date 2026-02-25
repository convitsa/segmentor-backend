import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { rateLimiter } from "hono-rate-limiter";

import authRoutes from "./routes/auth.js";
import projectRoutes from "./routes/projects.js";
import elementRoutes from "./routes/elements.js";
import variantRoutes from "./routes/variants.js";
import ruleRoutes from "./routes/rules.js";
import audienceRoutes from "./routes/audiences.js";
import analyticsRoutes from "./routes/analytics.js";
import publicRoutes from "./routes/public.js";
import billingRoutes from "./routes/billing.js";
import uploadRoutes from "./routes/uploads.js";
import adminRoutes from "./routes/admin.js";
import { requireAuth } from "./auth/middleware.js";
import { requireSubscription } from "./auth/require-subscription.js";
import { requireAdmin } from "./auth/require-admin.js";
import { shutdownPosthog } from "./lib/posthog.js";
import { prisma } from "./db/index.js";

function validateEnv() {
  const required = [
    "DATABASE_URL",
    "JWT_SECRET",
    "CORS_ORIGIN",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_ID_MONTHLY",
    "STRIPE_PRICE_ID_YEARLY",
  ];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}

validateEnv();

const app = new Hono();

const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";
const PORT = parseInt(process.env.PORT || "4000", 10);

app.use(logger());

app.use(
  "/api/*",
  cors({
    origin: CORS_ORIGIN,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(
  "/public/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

app.use(
  "/api/auth/*",
  rateLimiter({
    windowMs: 60 * 1000,
    limit: 10,
    keyGenerator: (c) =>
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown",
  })
);

app.use(
  "/public/track",
  rateLimiter({
    windowMs: 60 * 1000,
    limit: 100,
    keyGenerator: (c) =>
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown",
  })
);

app.route("/api/auth", authRoutes);
app.route("/api/billing", billingRoutes);

const adminProtected = new Hono();
adminProtected.use("/*", requireAuth, requireAdmin);
adminProtected.route("", adminRoutes);
app.route("/api/admin", adminProtected);

const protected_ = new Hono();
protected_.use("/*", requireAuth, requireSubscription);
protected_.route("/projects", projectRoutes);
protected_.route("", elementRoutes);
protected_.route("", variantRoutes);
protected_.route("", ruleRoutes);
protected_.route("", audienceRoutes);
protected_.route("", analyticsRoutes);
protected_.route("/uploads", uploadRoutes);
app.route("/api", protected_);

app.route("/public", publicRoutes);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

app.get("/health", async (c) => {
  try {
    await prisma.$runCommandRaw({ ping: 1 });
    return c.json({ status: "ok", db: "connected" });
  } catch {
    return c.json({ status: "degraded", db: "disconnected" }, 503);
  }
});

console.log(`Segmentor backend running on http://localhost:${PORT}`);

process.on("SIGTERM", async () => {
  await shutdownPosthog();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await shutdownPosthog();
  process.exit(0);
});

export default {
  port: PORT,
  fetch: app.fetch,
};
