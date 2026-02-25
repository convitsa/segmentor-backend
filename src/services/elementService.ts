import { prisma } from "../db/index.js";

export async function listElements(projectId: string) {
  return prisma.elementConfig.findMany({
    where: { projectId },
    include: { variants: true, rules: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getElement(id: string) {
  return prisma.elementConfig.findUnique({
    where: { id },
    include: { variants: true, rules: true },
  });
}

export async function createElement(
  projectId: string,
  data: { label: string; selector: string }
) {
  return prisma.elementConfig.create({
    data: { projectId, label: data.label, selector: data.selector },
  });
}

export async function updateElement(
  id: string,
  data: { label?: string; selector?: string }
) {
  return prisma.elementConfig.update({ where: { id }, data });
}

export async function deleteElement(id: string) {
  await prisma.rule.deleteMany({ where: { elementId: id } });
  await prisma.variant.deleteMany({ where: { elementId: id } });
  return prisma.elementConfig.delete({ where: { id } });
}
