import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

type AuthEnv = { Variables: { userId: string } };
const uploads = new Hono<AuthEnv>();

const UPLOADS_DIR = join(import.meta.dir, "../../public/uploads");
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

uploads.post("/image", requireAuth, async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];

  if (!file || !(file instanceof File)) {
    return c.json({ error: "No file provided" }, 400);
  }

  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (!allowed.includes(file.type)) {
    return c.json({ error: "Invalid file type. Use JPEG, PNG, GIF, or WebP." }, 400);
  }

  const maxSize = 5 * 1024 * 1024;
  if (file.size > maxSize) {
    return c.json({ error: "File too large. Max 5MB." }, 400);
  }

  const ext = file.name.split(".").pop() || "png";
  const filename = `${randomUUID()}.${ext}`;
  const buffer = await file.arrayBuffer();

  writeFileSync(join(UPLOADS_DIR, filename), Buffer.from(buffer));

  const origin = process.env.CORS_ORIGIN || "http://localhost:3000";
  const port = process.env.PORT || "4000";
  const parsedOrigin = new URL(origin);
  const url = `${parsedOrigin.protocol}//${parsedOrigin.hostname}:${port}/public/uploads/${filename}`;

  return c.json({ url, filename });
});

export default uploads;
