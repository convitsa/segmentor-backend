import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { verifyToken } from "./jwt.js";
import { prisma } from "../db/index.js";

type Env = {
  Variables: {
    userId: string;
  };
};

export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Missing or invalid token" });
  }

  const token = header.slice(7);
  let userId: string;
  try {
    const payload = verifyToken(token);
    userId = payload.userId;
  } catch {
    throw new HTTPException(401, { message: "Invalid or expired token" });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) {
    throw new HTTPException(401, { message: "User no longer exists" });
  }

  c.set("userId", userId);
  await next();
});
