import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { prisma } from "../db/index.js";

type Env = {
  Variables: {
    userId: string;
  };
};

export const requireSubscription = createMiddleware<Env>(async (c, next) => {
  const userId = c.get("userId");
  if (!userId) {
    throw new HTTPException(401, { message: "Authentication required" });
  }

  const sub = await prisma.subscription.findUnique({ where: { userId } });

  if (!sub || !["active", "trialing"].includes(sub.status)) {
    throw new HTTPException(403, {
      message: "Active subscription required",
    });
  }

  await next();
});
