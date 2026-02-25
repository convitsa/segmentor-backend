import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import {
  requireProjectOwnership,
  requireElementOwnership,
} from "../lib/ownership.js";
import * as elementService from "../services/elementService.js";

type Env = { Variables: { userId: string } };

const elements = new Hono<Env>();

elements.use("/*", requireAuth);

elements.get("/projects/:projectId/elements", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);
  const list = await elementService.listElements(projectId);
  return c.json(list);
});

const createSchema = z.object({
  label: z.string().min(1),
  selector: z.string().min(1),
});

elements.post("/projects/:projectId/elements", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("projectId");
  await requireProjectOwnership(projectId, userId);
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const element = await elementService.createElement(projectId, parsed.data);
  return c.json(element, 201);
});

const updateSchema = z.object({
  label: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
});

elements.patch("/elements/:elementId", async (c) => {
  const userId = c.get("userId");
  const elementId = c.req.param("elementId");
  await requireElementOwnership(elementId, userId);
  const body = await c.req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const element = await elementService.updateElement(elementId, parsed.data);
  return c.json(element);
});

elements.delete("/elements/:elementId", async (c) => {
  const userId = c.get("userId");
  const elementId = c.req.param("elementId");
  await requireElementOwnership(elementId, userId);
  await elementService.deleteElement(elementId);
  return c.json({ success: true });
});

export default elements;
