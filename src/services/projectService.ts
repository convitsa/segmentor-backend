import { prisma } from "../db/index.js";
import { nanoid } from "nanoid";

export async function listProjects(userId: string) {
  return prisma.project.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getProject(id: string) {
  return prisma.project.findUnique({ where: { id } });
}

export async function createProject(
  userId: string,
  data: { name: string; siteUrl: string }
) {
  return prisma.project.create({
    data: {
      userId,
      name: data.name,
      siteUrl: data.siteUrl,
      publicKey: nanoid(21),
    },
  });
}

export async function updateProject(
  id: string,
  data: { name?: string; siteUrl?: string }
) {
  return prisma.project.update({ where: { id }, data });
}

export async function deleteProject(id: string) {
  await prisma.rule.deleteMany({
    where: { element: { projectId: id } },
  });
  await prisma.variant.deleteMany({
    where: { element: { projectId: id } },
  });
  await prisma.elementConfig.deleteMany({ where: { projectId: id } });
  return prisma.project.delete({ where: { id } });
}
