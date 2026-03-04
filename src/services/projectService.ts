import { Project, Rule, Variant, ElementConfig } from "../db/models.js";
import { nanoid } from "nanoid";

export async function listProjects(userId: string) {
  return Project.find({ userId }).sort({ createdAt: -1 });
}

export async function getProject(id: string) {
  return Project.findById(id);
}

export async function createProject(
  userId: string,
  data: { name: string; siteUrl: string }
) {
  return Project.create({
    userId,
    name: data.name,
    siteUrl: data.siteUrl,
    publicKey: nanoid(21),
  });
}

export async function updateProject(
  id: string,
  data: { name?: string; siteUrl?: string }
) {
  return Project.findByIdAndUpdate(id, data, { returnDocument: "after" });
}

export async function deleteProject(id: string) {
  const elements = await ElementConfig.find({ projectId: id });
  const elementIds = elements.map((e) => e._id);
  await Rule.deleteMany({ elementId: { $in: elementIds } });
  await Variant.deleteMany({ elementId: { $in: elementIds } });
  await ElementConfig.deleteMany({ projectId: id });
  return Project.findByIdAndDelete(id);
}
