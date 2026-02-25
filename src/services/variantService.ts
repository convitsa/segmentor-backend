import { prisma } from "../db/index.js";
import type { VariantMutation } from "../types/dto.js";

export async function createVariant(
  elementId: string,
  data: { name: string; mutations: VariantMutation[] }
) {
  return prisma.variant.create({
    data: {
      elementId,
      name: data.name,
      mutations: data.mutations as any,
    },
  });
}

export async function updateVariant(
  id: string,
  data: { name?: string; mutations?: VariantMutation[] }
) {
  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.mutations !== undefined) updateData.mutations = data.mutations as any;
  return prisma.variant.update({ where: { id }, data: updateData });
}

export async function deleteVariant(id: string) {
  await prisma.rule.deleteMany({ where: { variantId: id } });
  return prisma.variant.delete({ where: { id } });
}
