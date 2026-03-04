import { Variant, Rule } from "../db/models.js";
import type { VariantMutation } from "../types/dto.js";

export async function createVariant(
  elementId: string,
  data: { name: string; mutations: VariantMutation[] }
) {
  return Variant.create({
    elementId,
    name: data.name,
    mutations: data.mutations as any,
  });
}

export async function updateVariant(
  id: string,
  data: { name?: string; mutations?: VariantMutation[] }
) {
  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.mutations !== undefined) updateData.mutations = data.mutations as any;
  return Variant.findByIdAndUpdate(id, updateData, { returnDocument: "after" });
}

export async function deleteVariant(id: string) {
  await Rule.deleteMany({ variantId: id });
  return Variant.findByIdAndDelete(id);
}
