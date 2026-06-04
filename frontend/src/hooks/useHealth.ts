import { useCallback, useState } from "react";
import { api } from "../api";
import type { HealthInfo } from "../types";

export function useHealth() {
  const [health, setHealth] = useState<HealthInfo | null>(null);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.getHealth());
    } catch {
      // Health is advisory UI state; keep startup usable if the endpoint is unavailable.
    }
  }, []);

  return { health, refreshHealth };
}
