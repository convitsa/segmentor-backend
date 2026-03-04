import { Audience } from "../db/models.js";
import type { Condition } from "../types/dto.js";

export async function listAudiences(projectId: string) {
  return Audience.find({ projectId }).sort({ createdAt: -1 });
}

export async function createAudience(
  projectId: string,
  data: {
    name: string;
    conditions: Condition[];
    logic: "AND" | "OR";
  }
) {
  return Audience.create({
    projectId,
    name: data.name,
    conditions: data.conditions as any,
    logic: data.logic,
  });
}

export async function updateAudience(
  id: string,
  data: {
    name?: string;
    conditions?: Condition[];
    logic?: "AND" | "OR";
  }
) {
  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.conditions !== undefined) updateData.conditions = data.conditions as any;
  if (data.logic !== undefined) updateData.logic = data.logic;
  return Audience.findByIdAndUpdate(id, updateData, { returnDocument: "after" });
}

export async function deleteAudience(id: string) {
  return Audience.findByIdAndDelete(id);
}
