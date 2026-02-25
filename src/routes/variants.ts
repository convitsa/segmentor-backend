import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import {
  requireElementOwnership,
  requireVariantOwnership,
} from "../lib/ownership.js";
import * as variantService from "../services/variantService.js";

const DANGEROUS_ATTRIBUTES = /^(on\w+|formaction|xlink:href)$/i;

const mutationSchema = z.object({
  field: z.enum(["text", "visible", "href", "src", "className", "style", "attribute"]),
  value: z.string(),
  attributeName: z
    .string()
    .optional()
    .refine((v) => !v || !DANGEROUS_ATTRIBUTES.test(v), {
      message: "Dangerous attribute names are not allowed",
    }),
});

type Env = { Variables: { userId: string } };

const variants = new Hono<Env>();

variants.use("/*", requireAuth);

const createSchema = z.object({
  name: z.string().min(1),
  mutations: z.array(mutationSchema),
});

variants.post("/elements/:elementId/variants", async (c) => {
  const userId = c.get("userId");
  const elementId = c.req.param("elementId");
  await requireElementOwnership(elementId, userId);
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const variant = await variantService.createVariant(elementId, parsed.data);
  return c.json(variant, 201);
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  mutations: z.array(mutationSchema).optional(),
});

variants.patch("/variants/:variantId", async (c) => {
  const userId = c.get("userId");
  const variantId = c.req.param("variantId");
  await requireVariantOwnership(variantId, userId);
  const body = await c.req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const variant = await variantService.updateVariant(variantId, parsed.data);
  return c.json(variant);
});

variants.delete("/variants/:variantId", async (c) => {
  const userId = c.get("userId");
  const variantId = c.req.param("variantId");
  await requireVariantOwnership(variantId, userId);
  await variantService.deleteVariant(variantId);
  return c.json({ success: true });
});

export default variants;
