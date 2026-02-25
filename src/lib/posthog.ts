import { PostHog } from "posthog-node";

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || "";

const client = POSTHOG_API_KEY
  ? new PostHog(POSTHOG_API_KEY, { host: "https://us.i.posthog.com" })
  : null;

export function captureEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
) {
  if (!client) return;
  client.capture({ distinctId, event, properties });
}

export async function shutdownPosthog() {
  if (!client) return;
  await client.shutdown();
}
