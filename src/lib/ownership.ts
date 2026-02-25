import { HTTPException } from "hono/http-exception";
import { prisma } from "../db/index.js";

export async function requireProjectOwnership(
  projectId: string,
  userId: string
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  });
  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }
  if (project.userId !== userId) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
}

export async function requireElementOwnership(
  elementId: string,
  userId: string
) {
  const element = await prisma.elementConfig.findUnique({
    where: { id: elementId },
    include: { project: { select: { userId: true } } },
  });
  if (!element) {
    throw new HTTPException(404, { message: "Element not found" });
  }
  if (element.project.userId !== userId) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  return element;
}

export async function requireVariantOwnership(
  variantId: string,
  userId: string
) {
  const variant = await prisma.variant.findUnique({
    where: { id: variantId },
    include: { element: { include: { project: { select: { userId: true } } } } },
  });
  if (!variant) {
    throw new HTTPException(404, { message: "Variant not found" });
  }
  if (variant.element.project.userId !== userId) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  return variant;
}

export async function requireAudienceOwnership(audienceId: string, userId: string) {
  const audience = await prisma.audience.findUnique({
    where: { id: audienceId },
    include: { project: { select: { userId: true } } },
  });
  if (!audience) {
    throw new HTTPException(404, { message: "Audience not found" });
  }
  if (audience.project.userId !== userId) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  return audience;
}

export async function requireRuleOwnership(ruleId: string, userId: string) {
  const rule = await prisma.rule.findUnique({
    where: { id: ruleId },
    include: { element: { include: { project: { select: { userId: true } } } } },
  });
  if (!rule) {
    throw new HTTPException(404, { message: "Rule not found" });
  }
  if (rule.element.project.userId !== userId) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  return rule;
}
