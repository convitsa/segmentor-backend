import { prisma } from "../db/index.js";
import type { Condition } from "../types/dto.js";

export async function listAudiences(projectId: string) {
  return prisma.audience.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
}

export async function createAudience(
  projectId: string,
  data: {
    name: string;
    conditions: Condition[];
    logic: "AND" | "OR";
  }
) {
  return prisma.audience.create({
    data: {
      projectId,
      name: data.name,
      conditions: data.conditions as any,
      logic: data.logic,
    },
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
  return prisma.audience.update({ where: { id }, data: updateData });
}

export async function deleteAudience(id: string) {
  return prisma.audience.delete({ where: { id } });
}
