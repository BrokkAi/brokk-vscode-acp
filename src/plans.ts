export type PlanEntryPriority = "high" | "medium" | "low";
export type PlanEntryStatus = "pending" | "in_progress" | "completed";

export interface SessionPlanEntry {
  content: string;
  priority: PlanEntryPriority;
  status: PlanEntryStatus;
}

interface LegacyPlanTranscriptEntry {
  kind?: unknown;
  plan?: unknown;
}

const PRIORITIES = new Set<PlanEntryPriority>(["high", "medium", "low"]);
const STATUSES = new Set<PlanEntryStatus>(["pending", "in_progress", "completed"]);

export function normalizePlanEntries(value: unknown): SessionPlanEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries: SessionPlanEntry[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      continue;
    }
    const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
    const priority = candidate.priority;
    const status = candidate.status;
    if (
      !content ||
      typeof priority !== "string" ||
      !PRIORITIES.has(priority as PlanEntryPriority) ||
      typeof status !== "string" ||
      !STATUSES.has(status as PlanEntryStatus)
    ) {
      continue;
    }
    entries.push({
      content,
      priority: priority as PlanEntryPriority,
      status: status as PlanEntryStatus,
    });
  }
  return entries;
}

export function latestLegacyPlan(
  entries: readonly LegacyPlanTranscriptEntry[],
): SessionPlanEntry[] | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind === "plan") {
      return normalizePlanEntries(entry.plan);
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
