import { prisma } from "../db/index.js";
import type { ProjectConfigDTO, ElementConfigDTO, VariantDTO, RuleDTO, VariantMutation, Condition, Split } from "../types/dto.js";

export async function getProjectConfig(
  publicKey: string
): Promise<ProjectConfigDTO | null> {
  const project = await prisma.project.findUnique({
    where: { publicKey },
    include: {
      elements: {
        include: {
          variants: true,
          rules: true,
        },
      },
      audiences: true,
    },
  });

  if (!project) return null;

  const audienceMap = new Map(
    project.audiences.map((a) => [a.id, a])
  );

  const elements: ElementConfigDTO[] = project.elements.map((el) => {
    const variants: VariantDTO[] = el.variants.map((v) => ({
      id: v.id,
      name: v.name,
      mutations: v.mutations as unknown as VariantMutation[],
    }));

    const rules: RuleDTO[] = el.rules.map((r) => {
      let conditions = r.conditions as unknown as Condition[];
      let logic = r.logic as "AND" | "OR";

      if (r.audienceId) {
        const audience = audienceMap.get(r.audienceId);
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
  };
}
