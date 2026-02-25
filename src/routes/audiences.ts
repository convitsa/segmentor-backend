import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import {
  requireProjectOwnership,
  requireAudienceOwnership,
} from "../lib/ownership.js";
import * as audienceService from "../services/audienceService.js";

const conditionSchema = z.object({
  id: z.string(),
  type: z.enum(["always", "utm", "device", "language", "newReturning", "url", "referrer", "geo", "time"]),
  key: z.string().optional(),
  comparator: z.enum(["equals", "contains", "startsWith", "endsWith", "greaterThan", "lessThan", "between"]).optional(),
  value: z.string().optional(),
});

type Env = { Variables: { userId: string } };

const audiences = new Hono<Env>();

audiences.use("/*", requireAuth);

audiences.get("/projects/:projectId/audiences", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);
  const list = await audienceService.listAudiences(projectId);
  return c.json(list);
});

const createSchema = z.object({
  name: z.string().min(1),
  conditions: z.array(conditionSchema).min(1),
  logic: z.enum(["AND", "OR"]),
});

audiences.post("/projects/:projectId/audiences", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const audience = await audienceService.createAudience(projectId, parsed.data);
  return c.json(audience, 201);
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  conditions: z.array(conditionSchema).optional(),
  logic: z.enum(["AND", "OR"]).optional(),
});

audiences.patch("/audiences/:audienceId", async (c) => {
  const userId = c.get("userId");
  const audienceId = c.req.param("audienceId");
  await requireAudienceOwnership(audienceId, userId);
  const body = await c.req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const audience = await audienceService.updateAudience(audienceId, parsed.data);
  return c.json(audience);
});

audiences.delete("/audiences/:audienceId", async (c) => {
  const userId = c.get("userId");
  const audienceId = c.req.param("audienceId");
  await requireAudienceOwnership(audienceId, userId);
  await audienceService.deleteAudience(audienceId);
  return c.json({ success: true });
});

export default audiences;
