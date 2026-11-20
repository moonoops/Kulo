import { translate as t } from "../../kulo-i18n";
import type { EnvNodeDescriptor, ProjectView, TicketCardView, TopicSummary } from "@kulo/protocol";
import { orderDevices } from "../../components/device-identity";

export const ALL_PROJECT_DEVICES = "*";
export type UpdateProjectCollection<T> = (next: T[] | ((previous: T[]) => T[])) => void;
export interface ProjectNavigationRequest { projectId: string; sequence: number }

export interface ProjectDevice {
  id: string;
  name: string;
  online: boolean;
  rootDir: string;
}

export function ordinaryTopics(topics: readonly TopicSummary[]): TopicSummary[] {
  return topics.filter((topic) => !topic.master && !topic.deletedAt && !topic.projectId);
}

export function topicsForProject(topics: readonly TopicSummary[], projectId: string): TopicSummary[] {
  return topics.filter((topic) => !topic.deletedAt && topic.projectId === projectId)
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
}

export function unfinishedTicket(ticket: Pick<TicketCardView, "status">): boolean {
  return ["queued", "running", "pausing", "waiting", "blocked"].includes(ticket.status);
}

export function projectTickets(projectId: string, topics: readonly TopicSummary[], tickets: readonly TicketCardView[]): TicketCardView[] {
  const topicIds = new Set(topics.filter((topic) => topic.projectId === projectId).map((topic) => topic.id));
  return tickets.filter((ticket) => ticket.projectId === projectId || topicIds.has(ticket.originTopicId ?? "root"));
}

export function projectDevices(
  envs: readonly EnvNodeDescriptor[],
  projects: readonly ProjectView[],
  known: readonly ProjectDevice[] = [],
  currentDeviceId?: string,
): ProjectDevice[] {
  const byId = new Map<string, ProjectDevice>();
  for (const project of projects) byId.set(project.deviceId, {
    id: project.deviceId, name: project.deviceName, online: project.availability === "ready", rootDir: "",
  });
  for (const device of known) byId.set(device.id, device);
  const knownNames = new Map(known.map((device) => [device.id, device.name]));
  for (const env of envs) byId.set(env.id, { id: env.id, name: knownNames.get(env.id) ?? env.name, online: env.online, rootDir: env.rootDir });
  return orderDevices([...byId.values()], { currentDeviceId });
}

export function initialProjectDevice(saved: string | null, currentDeviceId: string | undefined, currentDeviceKnown: boolean, devices: readonly ProjectDevice[]): string {
  if (saved === ALL_PROJECT_DEVICES || saved && devices.some((device) => device.id === saved)) return saved;
  return currentDeviceKnown && devices.some((device) => device.id === currentDeviceId) ? currentDeviceId! : ALL_PROJECT_DEVICES;
}

export function joinProjectDirectory(parent: string, name: string): string {
  if (!name.trim() || /[\\/\0]/.test(name) || [".", ".."].includes(name.trim())) throw new Error(t("请输入有效的目录名称", "Enter a valid directory name"));
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(parent);
  const separator = windows ? "\\" : "/";
  const normalized = windows ? parent.replace(/\//g, "\\") : parent;
  return `${normalized.replace(/[\\/]+$/, "")}${separator}${name.trim()}`;
}
