import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";

import * as api from "../api";
import type { DecisionInboxItem } from "../components/chat/decision-inbox";
import type { Agent, CompanyStats, Task } from "../types";
import { mapWorkflowDecisionItemsRaw } from "./decision-inbox";
import { areAgentListsEquivalent, areTaskListsEquivalent } from "./utils";

type UseLiveSyncSchedulerParams = {
  setTasks: Dispatch<SetStateAction<Task[]>>;
  setAgents: Dispatch<SetStateAction<Agent[]>>;
  setStats: Dispatch<SetStateAction<CompanyStats | null>>;
  setDecisionInboxItems: Dispatch<SetStateAction<DecisionInboxItem[]>>;
  shouldIncludeSeedAgents?: () => boolean;
};

export function useLiveSyncScheduler({
  setTasks,
  setAgents,
  setStats,
  setDecisionInboxItems,
  shouldIncludeSeedAgents,
}: UseLiveSyncSchedulerParams): (delayMs?: number) => void {
  const liveSyncInFlightRef = useRef(false);
  const liveSyncQueuedRef = useRef(false);
  const liveSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runLiveSync = useCallback(() => {
    if (liveSyncInFlightRef.current) {
      liveSyncQueuedRef.current = true;
      return;
    }
    liveSyncInFlightRef.current = true;
    const includeSeedAgents = shouldIncludeSeedAgents?.() === true;
    Promise.all([
      api.getTasks(),
      api.getAgents({ includeSeed: includeSeedAgents }),
      api.getStats(),
      api.getDecisionInbox(),
    ])
      .then(([nextTasks, nextAgents, nextStats, nextDecisionItems]) => {
        setTasks((prev) => (areTaskListsEquivalent(prev, nextTasks) ? prev : nextTasks));
        setAgents((prev) => (areAgentListsEquivalent(prev, nextAgents) ? prev : nextAgents));
        setStats(nextStats);
        setDecisionInboxItems((prev) => {
          const preservedAgentRequests = prev.filter((item) => item.kind === "agent_request");
          const workflowItems = mapWorkflowDecisionItemsRaw(nextDecisionItems);
          const merged = [...workflowItems, ...preservedAgentRequests];
          const deduped = new Map<string, DecisionInboxItem>();
          for (const entry of merged) deduped.set(entry.id, entry);
          return Array.from(deduped.values()).sort((a, b) => b.createdAt - a.createdAt);
        });
      })
      .catch(console.error)
      .finally(() => {
        liveSyncInFlightRef.current = false;
        if (!liveSyncQueuedRef.current) return;
        liveSyncQueuedRef.current = false;
        setTimeout(() => runLiveSync(), 120);
      });
  }, [setAgents, setDecisionInboxItems, setStats, setTasks, shouldIncludeSeedAgents]);

  const scheduleLiveSync = useCallback(
    (delayMs = 120) => {
      if (liveSyncTimerRef.current) return;
      liveSyncTimerRef.current = setTimeout(
        () => {
          liveSyncTimerRef.current = null;
          runLiveSync();
        },
        Math.max(0, delayMs),
      );
    },
    [runLiveSync],
  );

  useEffect(() => {
    return () => {
      if (!liveSyncTimerRef.current) return;
      clearTimeout(liveSyncTimerRef.current);
      liveSyncTimerRef.current = null;
    };
  }, []);

  return scheduleLiveSync;
}
