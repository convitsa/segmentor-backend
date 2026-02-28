import { EventEmitter } from "events";

export const hub = new EventEmitter();
hub.setMaxListeners(0);

export function broadcast(projectId: string, event: string, data: unknown) {
  hub.emit(`project:${projectId}`, { event, data });
}
