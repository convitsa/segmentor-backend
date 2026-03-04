import { ElementConfig, Variant, Rule } from "../db/models.js";

export async function listElements(projectId: string) {
  const elements = await ElementConfig.find({ projectId }).sort({
    createdAt: -1,
  });
  const elementIds = elements.map((e) => e._id);
  const [variants, rules] = await Promise.all([
    Variant.find({ elementId: { $in: elementIds } }),
    Rule.find({ elementId: { $in: elementIds } }),
  ]);
  const variantMap = new Map<string, any[]>();
  for (const v of variants) {
    const key = v.elementId.toString();
    if (!variantMap.has(key)) variantMap.set(key, []);
    variantMap.get(key)!.push(v.toJSON());
  }
  const ruleMap = new Map<string, any[]>();
  for (const r of rules) {
    const key = r.elementId.toString();
    if (!ruleMap.has(key)) ruleMap.set(key, []);
    ruleMap.get(key)!.push(r.toJSON());
  }
  return elements.map((el) => ({
    ...el.toJSON(),
    variants: variantMap.get(el._id.toString()) ?? [],
    rules: ruleMap.get(el._id.toString()) ?? [],
  }));
}

export async function getElement(id: string) {
  const element = await ElementConfig.findById(id);
  if (!element) return null;
  const [variants, rules] = await Promise.all([
    Variant.find({ elementId: element._id }),
    Rule.find({ elementId: element._id }),
  ]);
  return {
    ...element.toJSON(),
    variants: variants.map((v) => v.toJSON()),
    rules: rules.map((r) => r.toJSON()),
  };
}

export async function createElement(
  projectId: string,
  data: { label: string; selector: string }
) {
  return ElementConfig.create({
    projectId,
    label: data.label,
    selector: data.selector,
  });
}

export async function updateElement(
  id: string,
  data: { label?: string; selector?: string }
) {
  return ElementConfig.findByIdAndUpdate(id, data, { returnDocument: "after" });
}

export async function deleteElement(id: string) {
  await Rule.deleteMany({ elementId: id });
  await Variant.deleteMany({ elementId: id });
  return ElementConfig.findByIdAndDelete(id);
}
