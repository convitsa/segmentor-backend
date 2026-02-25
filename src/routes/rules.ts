import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import {
  requireElementOwnership,
  requireRuleOwnership,
} from "../lib/ownership.js";
import * as ruleService from "../services/ruleService.js";

const conditionSchema = z.object({
  id: z.string(),
  type: z.enum(["always", "utm", "device", "language", "newReturning", "url", "referrer", "geo", "time"]),
  key: z.string().optional(),
  comparator: z.enum(["equals", "contains", "startsWith", "endsWith", "greaterThan", "lessThan", "between"]).optional(),
  value: z.string().optional(),
});

const splitSchema = z.object({
  variantId: z.string(),
  weight: z.number().min(0).max(100),
});

type Env = { Variables: { userId: string } };

const rules = new Hono<Env>();

rules.use("/*", requireAuth);

const createSchema = z.object({
  description: z.string().optional(),
  conditions: z.array(conditionSchema),
  logic: z.enum(["AND", "OR"]),
  variantId: z.string(),
  priority: z.number().int(),
  enabled: z.boolean().optional(),
  startDate: z.string().datetime().optional().nullable(),
  endDate: z.string().datetime().optional().nullable(),
  splits: z.array(splitSchema).optional().nullable(),
  audienceId: z.string().optional().nullable(),
});

rules.post("/elements/:elementId/rules", async (c) => {
  const userId = c.get("userId");
  const elementId = c.req.param("elementId");
  await requireElementOwnership(elementId, userId);
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const rule = await ruleService.createRule(elementId, parsed.data);
  return c.json(rule, 201);
});

const updateSchema = z.object({
  description: z.string().optional(),
  conditions: z.array(conditionSchema).optional(),
  logic: z.enum(["AND", "OR"]).optional(),
  variantId: z.string().optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
  startDate: z.string().datetime().optional().nullable(),
  endDate: z.string().datetime().optional().nullable(),
  splits: z.array(splitSchema).optional().nullable(),
  audienceId: z.string().optional().nullable(),
});

rules.patch("/rules/:ruleId", async (c) => {
  const userId = c.get("userId");
  const ruleId = c.req.param("ruleId");
  await requireRuleOwnership(ruleId, userId);
  const body = await c.req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const rule = await ruleService.updateRule(ruleId, parsed.data);
  return c.json(rule);
});

rules.delete("/rules/:ruleId", async (c) => {
  const userId = c.get("userId");
  const ruleId = c.req.param("ruleId");
  await requireRuleOwnership(ruleId, userId);
  await ruleService.deleteRule(ruleId);
  return c.json({ success: true });
});

export default rules;
