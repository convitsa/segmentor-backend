import { Hono } from "hono";
import { z } from "zod";
import { OAuth2Client } from "google-auth-library";
import { User, Project, ElementConfig, Rule, Variant, Audience, Event } from "../db/models.js";
import { hashPassword, verifyPassword, signToken } from "../auth/jwt.js";
import { requireAuth } from "../auth/middleware.js";
import { fireEmail } from "../email/send.js";
import { welcomeEmail, passwordChangedEmail, accountDeletedEmail } from "../email/templates.js";
import { captureEvent } from "../lib/posthog.js";
import type { AuthResponse } from "../types/dto.js";

const authSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const googleSchema = z.object({
  idToken: z.string().min(1),
});

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const auth = new Hono();

auth.post("/signup", async (c) => {
  const body = await c.req.json();
  const parsed = authSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const { email, password } = parsed.data;

  const existing = await User.findOne({ email });
  if (existing) {
    return c.json({ error: "Email already registered" }, 409);
  }

  const passwordHash = await hashPassword(password);
  const user = await User.create({ email, passwordHash });

  const welcome = welcomeEmail(email);
  fireEmail(email, welcome.subject, welcome.html);
  captureEvent(user.id, "user_signed_up", { method: "email", email });

  const token = signToken(user.id);
  const response: AuthResponse = {
    user: { id: user.id, email: user.email, name: user.name ?? undefined, createdAt: (user as any).createdAt?.toISOString() ?? new Date().toISOString() },
    token,
  };

  return c.json(response, 201);
});

auth.post("/login", async (c) => {
  const body = await c.req.json();
  const parsed = authSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const { email, password } = parsed.data;

  const user = await User.findOne({ email });
  if (!user || !user.passwordHash) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  captureEvent(user.id, "user_logged_in", { method: "email" });

  const token = signToken(user.id);
  const response: AuthResponse = {
    user: { id: user.id, email: user.email, name: user.name ?? undefined, createdAt: (user as any).createdAt?.toISOString() ?? new Date().toISOString() },
    token,
  };

  return c.json(response);
});

auth.post("/google", async (c) => {
  const body = await c.req.json();
  const parsed = googleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Missing idToken" }, 400);
  }

  const { idToken } = parsed.data;

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    return c.json({ error: "Invalid Google token" }, 401);
  }

  if (!payload || !payload.email) {
    return c.json({ error: "Could not extract email from Google token" }, 401);
  }

  const googleId = payload.sub;
  const email = payload.email;

  let user = await User.findOne({ googleId });

  if (!user) {
    const existingByEmail = await User.findOne({ email });
    if (existingByEmail) {
      user = await User.findByIdAndUpdate(existingByEmail.id, { googleId }, { returnDocument: "after" });
      if (user) captureEvent(user.id, "user_logged_in", { method: "google" });
    } else {
      user = await User.create({ email, googleId });
      const welcome = welcomeEmail(email);
      fireEmail(email, welcome.subject, welcome.html);
      captureEvent(user.id, "user_signed_up", { method: "google", email });
    }
  } else {
    captureEvent(user.id, "user_logged_in", { method: "google" });
  }

  if (!user) return c.json({ error: "Could not create or update user" }, 500);

  const token = signToken(user.id);
  const response: AuthResponse = {
    user: { id: user.id, email: user.email, name: user.name ?? undefined, createdAt: (user as any).createdAt?.toISOString() ?? new Date().toISOString() },
    token,
  };

  return c.json(response);
});

// ─── Authenticated profile routes ───

auth.get("/me", requireAuth, async (c) => {
  const userId = c.get("userId");
  const user = await User.findById(userId);
  if (!user) return c.json({ error: "User not found" }, 404);

  return c.json({
    id: user.id,
    email: user.email,
    hasPassword: !!user.passwordHash,
    hasGoogle: !!user.googleId,
    role: user.role,
    createdAt: (user as any).createdAt?.toISOString() ?? new Date().toISOString(),
  });
});

const updateNameSchema = z.object({
  name: z.string().min(1).max(100),
});

auth.patch("/profile", requireAuth, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const parsed = updateNameSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const user = await User.findByIdAndUpdate(userId, { name: parsed.data.name }, { returnDocument: "after" });
  if (!user) return c.json({ error: "User not found" }, 404);

  return c.json({
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: (user as any).createdAt?.toISOString() ?? new Date().toISOString(),
  });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

auth.patch("/password", requireAuth, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const user = await User.findById(userId);
  if (!user || !user.passwordHash) {
    return c.json({ error: "Password change not available for this account" }, 400);
  }

  const valid = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
  if (!valid) {
    return c.json({ error: "Current password is incorrect" }, 401);
  }

  const newHash = await hashPassword(parsed.data.newPassword);
  await User.findByIdAndUpdate(userId, { passwordHash: newHash });

  const pwEmail = passwordChangedEmail();
  fireEmail(user.email, pwEmail.subject, pwEmail.html);

  return c.json({ message: "Password updated successfully" });
});

const setPasswordSchema = z.object({
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

auth.post("/set-password", requireAuth, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const parsed = setPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const user = await User.findById(userId);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.passwordHash) {
    return c.json({ error: "Password already set. Use the change password endpoint." }, 400);
  }

  const hash = await hashPassword(parsed.data.newPassword);
  await User.findByIdAndUpdate(userId, { passwordHash: hash });

  const pwEmail = passwordChangedEmail();
  fireEmail(user.email, pwEmail.subject, pwEmail.html);

  return c.json({ message: "Password set successfully" });
});

auth.delete("/account", requireAuth, async (c) => {
  const userId = c.get("userId");

  const userToDelete = await User.findById(userId);
  if (userToDelete) {
    const delEmail = accountDeletedEmail();
    fireEmail(userToDelete.email, delEmail.subject, delEmail.html);
  }

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

  await User.findByIdAndDelete(userId);

  return c.json({ message: "Account deleted successfully" });
});

export default auth;
