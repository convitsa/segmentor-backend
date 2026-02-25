import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { prisma } from "../db/index.js";

type Env = {
  Variables: {
    userId: string;
  };
};

export const requireAdmin = createMiddleware<Env>(async (c, next) => {
  const userId = c.get("userId");
  if (!userId) {
    throw new HTTPException(401, { message: "Authentication required" });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user || user.role !== "admin") {
    throw new HTTPException(403, { message: "Admin access required" });
  }

  await next();
});
