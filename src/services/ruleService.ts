import { prisma } from "../db/index.js";
import type { Condition, Split } from "../types/dto.js";

export async function createRule(
  elementId: string,
  data: {
    description?: string;
    conditions: Condition[];
    logic: "AND" | "OR";
    variantId: string;
    priority: number;
    enabled?: boolean;
    startDate?: string | null;
    endDate?: string | null;
    splits?: Split[] | null;
    audienceId?: string | null;
  }
) {
  return prisma.rule.create({
    data: {
      elementId,
      description: data.description,
      conditions: data.conditions as any,
      logic: data.logic,
      variantId: data.variantId,
      priority: data.priority,
      enabled: data.enabled ?? true,
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
      splits: data.splits as any ?? undefined,
      audienceId: data.audienceId ?? null,
    },
  });
}

export async function updateRule(
  id: string,
  data: {
    description?: string;
    conditions?: Condition[];
    logic?: "AND" | "OR";
    variantId?: string;
    priority?: number;
    enabled?: boolean;
    startDate?: string | null;
    endDate?: string | null;
    splits?: Split[] | null;
    audienceId?: string | null;
  }
) {
  const updateData: Record<string, unknown> = {};
  if (data.description !== undefined) updateData.description = data.description;
  if (data.conditions !== undefined) updateData.conditions = data.conditions as any;
  if (data.logic !== undefined) updateData.logic = data.logic;
  if (data.variantId !== undefined) updateData.variantId = data.variantId;
  if (data.priority !== undefined) updateData.priority = data.priority;
  if (data.enabled !== undefined) updateData.enabled = data.enabled;
  if (data.startDate !== undefined) updateData.startDate = data.startDate ? new Date(data.startDate) : null;
  if (data.endDate !== undefined) updateData.endDate = data.endDate ? new Date(data.endDate) : null;
  if (data.splits !== undefined) updateData.splits = data.splits as any ?? null;
  if (data.audienceId !== undefined) updateData.audienceId = data.audienceId ?? null;
  return prisma.rule.update({ where: { id }, data: updateData });
}

export async function deleteRule(id: string) {
  return prisma.rule.delete({ where: { id } });
}
