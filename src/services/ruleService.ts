import { Rule } from "../db/models.js";
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
  return Rule.create({
    elementId,
    description: data.description,
    conditions: data.conditions as any,
    logic: data.logic,
    variantId: data.variantId,
    priority: data.priority,
    enabled: data.enabled ?? true,
    startDate: data.startDate ? new Date(data.startDate) : undefined,
    endDate: data.endDate ? new Date(data.endDate) : undefined,
    splits: (data.splits as any) ?? undefined,
    audienceId: data.audienceId ?? undefined,
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
  return Rule.findByIdAndUpdate(id, updateData, { returnDocument: "after" });
}

export async function deleteRule(id: string) {
  return Rule.findByIdAndDelete(id);
}
