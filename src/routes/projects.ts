import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { requireProjectOwnership } from "../lib/ownership.js";
import * as projectService from "../services/projectService.js";

type Env = { Variables: { userId: string } };

const projects = new Hono<Env>();

projects.use("/*", requireAuth);

projects.get("/", async (c) => {
  const userId = c.get("userId");
  const list = await projectService.listProjects(userId);
  return c.json(list);
});

const createSchema = z.object({
  name: z.string().min(1),
  siteUrl: z.string().url(),
});

projects.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const project = await projectService.createProject(userId, parsed.data);
  return c.json(project, 201);
});

projects.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  await requireProjectOwnership(id, userId);
  const project = await projectService.getProject(id);
  return c.json(project);
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  siteUrl: z.string().url().optional(),
  recordingEnabled: z.boolean().optional(),
  recordingSampleRate: z.number().min(0).max(1).optional(),
});

projects.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  await requireProjectOwnership(id, userId);
  const body = await c.req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const project = await projectService.updateProject(id, parsed.data);
  return c.json(project);
});

projects.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  await requireProjectOwnership(id, userId);
  await projectService.deleteProject(id);
  return c.json({ success: true });
});

export default projects;
