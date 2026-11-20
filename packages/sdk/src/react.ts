import { useSyncExternalStore } from "react";
import type { PersonalAgentClient } from "./client.js";
import type { Projection } from "./projection.js";

export function useAgent(client: PersonalAgentClient): Projection {
  return useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );
}
