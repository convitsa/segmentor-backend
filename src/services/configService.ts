import { Project, ElementConfig, Variant, Rule, Audience } from "../db/models.js";
import type { ProjectConfigDTO, ElementConfigDTO, VariantDTO, RuleDTO, VariantMutation, Condition, Split } from "../types/dto.js";

export async function getProjectConfig(
  publicKey: string
): Promise<ProjectConfigDTO | null> {
  const project = await Project.findOne({ publicKey });
  if (!project) return null;

  const [elementsData, audiences] = await Promise.all([
    ElementConfig.find({ projectId: project._id }),
    Audience.find({ projectId: project._id }),
  ]);

  const elementIds = elementsData.map((el) => el._id);
  const [variants, rules] = await Promise.all([
    Variant.find({ elementId: { $in: elementIds } }),
    Rule.find({ elementId: { $in: elementIds } }),
  ]);

  const audienceMap = new Map(audiences.map((a) => [a.id, a]));
  const variantsByElement = new Map<string, typeof variants>();
  const rulesByElement = new Map<string, typeof rules>();
  for (const v of variants) {
    const eid = String(v.elementId);
    if (!variantsByElement.has(eid)) variantsByElement.set(eid, []);
    variantsByElement.get(eid)!.push(v);
  }
  for (const r of rules) {
    const eid = String(r.elementId);
    if (!rulesByElement.has(eid)) rulesByElement.set(eid, []);
    rulesByElement.get(eid)!.push(r);
  }

  const elements: ElementConfigDTO[] = elementsData.map((el) => {
    const elVariants = variantsByElement.get(String(el._id)) ?? [];
    const elRules = rulesByElement.get(String(el._id)) ?? [];
    const variants: VariantDTO[] = elVariants.map((v) => ({
      id: v.id,
      name: v.name,
      mutations: v.mutations as unknown as VariantMutation[],
    }));

    const rules: RuleDTO[] = elRules.map((r) => {
      let conditions = r.conditions as unknown as Condition[];
      let logic = r.logic as "AND" | "OR";

      if (r.audienceId) {
        const audience = audienceMap.get(String(r.audienceId));
        if (audience) {
          conditions = audience.conditions as unknown as Condition[];
          logic = audience.logic as "AND" | "OR";
        }
      }

      return {
        id: r.id,
        description: r.description ?? undefined,
        conditions,
        logic,
        variantId: r.variantId,
        priority: r.priority,
        enabled: r.enabled,
        startDate: r.startDate?.toISOString(),
        endDate: r.endDate?.toISOString(),
        splits: r.splits as unknown as Split[] | undefined,
      };
    });

    return {
      id: el.id,
      label: el.label,
      selector: el.selector,
      variants,
      rules,
    };
  });

  return {
    id: project.id,
    siteUrl: project.siteUrl,
    elements,
    recordingEnabled: project.recordingEnabled ?? false,
  };
}
