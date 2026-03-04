import { HTTPException } from "hono/http-exception";
import {
  Project,
  ElementConfig,
  Variant,
  Audience,
  Rule,
} from "../db/models.js";

export async function requireProjectOwnership(
  projectId: string,
  userId: string
) {
  const project = await Project.findById(projectId).select("userId");
  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }
  if (project.userId?.toString() !== userId) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
}

export async function requireElementOwnership(
  elementId: string,
  userId: string
) {
  const element = await ElementConfig.findById(elementId);
  if (!element) {
    throw new HTTPException(404, { message: "Element not found" });
  }
  const project = await Project.findById(element.projectId).select("userId");
  if (!project || project.userId?.toString() !== userId) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  return element;
}

export async function requireVariantOwnership(
  variantId: string,
  userId: string
) {
  const variant = await Variant.findById(variantId);
  if (!variant) {
    throw new HTTPException(404, { message: "Variant not found" });
  }
  const element = await ElementConfig.findById(variant.elementId);
  if (!element) {
    throw new HTTPException(404, { message: "Element not found" });
  }
  const project = await Project.findById(element.projectId).select("userId");
  if (!project || project.userId?.toString() !== userId) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  return variant;
}

export async function requireAudienceOwnership(audienceId: string, userId: string) {
  const audience = await Audience.findById(audienceId);
  if (!audience) {
    throw new HTTPException(404, { message: "Audience not found" });
  }
  const project = await Project.findById(audience.projectId).select("userId");
  if (!project || project.userId?.toString() !== userId) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  return audience;
}

export async function requireRuleOwnership(ruleId: string, userId: string) {
  const rule = await Rule.findById(ruleId);
  if (!rule) {
    throw new HTTPException(404, { message: "Rule not found" });
  }
  const element = await ElementConfig.findById(rule.elementId);
  if (!element) {
    throw new HTTPException(404, { message: "Element not found" });
  }
  const project = await Project.findById(element.projectId).select("userId");
  if (!project || project.userId?.toString() !== userId) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  return rule;
}
