// =============================================================
// Phase 3 · Stage 6: Campus Notification App — Priority Inbox
// =============================================================
// Fetches notifications from the evaluation-service, applies
// priority ranking (Placement > Result > Event), and returns
// the top-10 most important + most recent notifications using
// an efficient partial-sort (no full re-sort needed).
//
// RULES:
//   - NO console.log — all output via Log()
//   - Bearer token from .env (never hardcoded)
//   - Data fetched live (never stored in a DB)
//   - Efficient top-N selection via PriorityInbox
// =============================================================

import axios, { AxiosError } from "axios";
import * as dotenv from "dotenv";
import * as path from "path";
import {
  Log,
  LogInfo,
  LogDebug,
  LogError,
  LogWarn,
  LogFatal,
  LogPackage,
} from "../logging_middleware/index";

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// ── Package identifier for all logs ──────────────────────────
const PKG: LogPackage = "notification_app_be";

// ── Types ────────────────────────────────────────────────────

/** Notification types — priority order: Placement > Result > Event */
type NotificationType = "Placement" | "Result" | "Event" | string;

/** Raw notification from the API */
interface Notification {
  ID: number;
  Type: NotificationType;
  Message: string;
  Timestamp: string; // ISO-8601
}

/** Notification enriched with computed priority score */
interface ScoredNotification extends Notification {
  priorityScore: number; // Higher = more important
  parsedTime: number;    // Unix timestamp for sorting
}

// ── Priority mapping ─────────────────────────────────────────

/**
 * Priority weights — Placement is the most urgent (a student
 * cannot miss a placement notification), followed by Result,
 * then Event.
 */
const PRIORITY_WEIGHTS: Record<string, number> = {
  Placement: 3, // Highest priority
  Result: 2,    // Medium priority
  Event: 1,     // Lowest priority
};

/**
 * Returns the numeric priority weight for a notification type.
 * Unknown types default to 0 (lowest).
 */
function getPriorityWeight(type: string): number {
  return PRIORITY_WEIGHTS[type] ?? 0;
}

// ── API helpers ──────────────────────────────────────────────

const API_BASE =
  process.env.API_BASE_URL || "http://20.207.122.201/evaluation-service";

function getAuthHeaders(): Record<string, string> {
  const token = process.env.ACCESS_TOKEN;
  if (!token || token === "your_bearer_token_here") {
    throw new Error(
      "ACCESS_TOKEN is missing in .env — cannot call protected APIs"
    );
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Fetches all notifications from the evaluation-service.
 */
async function fetchNotifications(): Promise<Notification[]> {
  await LogInfo(
    PKG,
    "Initiating GET request to /notifications endpoint to retrieve campus notifications"
  );

  try {
    const response = await axios.get(`${API_BASE}/notifications`, {
      headers: getAuthHeaders(),
      timeout: 15_000,
    });

    const notifications: Notification[] =
      response.data.notifications ?? response.data;

    // Count by type for descriptive logging
    const typeCounts: Record<string, number> = {};
    for (const n of notifications) {
      typeCounts[n.Type] = (typeCounts[n.Type] || 0) + 1;
    }

    await LogInfo(
      PKG,
      `Successfully fetched ${notifications.length} notifications — ` +
        `breakdown: ${Object.entries(typeCounts)
          .map(([t, c]) => `${t}=${c}`)
          .join(", ")}`
    );

    return notifications;
  } catch (err) {
    const msg =
      err instanceof AxiosError
        ? `Notifications API request failed [status=${err.response?.status ?? "N/A"}]: ${err.message}`
        : `Unexpected error fetching notifications: ${String(err)}`;

    await LogError(PKG, msg);
    throw new Error(msg);
  }
}

// ── Priority Inbox — Efficient Top-N Selection ───────────────

/**
 * PriorityInbox selects the top-N notifications WITHOUT fully
 * sorting the entire array. This is crucial when the dataset
 * grows large (thousands of notifications).
 *
 * Algorithm: Partial selection using a min-heap of size N.
 *
 * We maintain a min-heap of capacity N. For each notification:
 *   - If the heap has fewer than N items, push it in.
 *   - Otherwise, compare with the heap's minimum:
 *     if the new item has higher priority, replace the min.
 *
 * Time:  O(n × log N) where n = total notifications, N = inbox size
 * Space: O(N)
 *
 * This avoids the O(n × log n) cost of sorting the entire array
 * when N ≪ n.
 */
class PriorityInbox {
  private heap: ScoredNotification[] = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /**
   * Comparison: returns true if `a` has LOWER priority than `b`.
   * Lower-priority items sit at the top of the min-heap so they
   * can be evicted first.
   *
   * Primary sort:  priorityScore (higher is better)
   * Secondary sort: parsedTime   (later is better — more recent)
   */
  private isLowerPriority(
    a: ScoredNotification,
    b: ScoredNotification
  ): boolean {
    if (a.priorityScore !== b.priorityScore) {
      return a.priorityScore < b.priorityScore;
    }
    // Same priority type — prefer more recent (higher timestamp)
    return a.parsedTime < b.parsedTime;
  }

  /** Swap two elements in the heap array */
  private swap(i: number, j: number): void {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
  }

  /** Bubble-up to restore min-heap property after insertion */
  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.isLowerPriority(this.heap[index], this.heap[parent])) {
        this.swap(index, parent);
        index = parent;
      } else {
        break;
      }
    }
  }

  /** Sink-down to restore min-heap property after extraction */
  private sinkDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;

      if (
        left < length &&
        this.isLowerPriority(this.heap[left], this.heap[smallest])
      ) {
        smallest = left;
      }
      if (
        right < length &&
        this.isLowerPriority(this.heap[right], this.heap[smallest])
      ) {
        smallest = right;
      }

      if (smallest !== index) {
        this.swap(index, smallest);
        index = smallest;
      } else {
        break;
      }
    }
  }

  /** Push an item into the heap */
  private push(item: ScoredNotification): void {
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  /** View the minimum (lowest priority) item without removing */
  private peekMin(): ScoredNotification | undefined {
    return this.heap[0];
  }

  /** Remove and return the minimum (lowest priority) item */
  private popMin(): ScoredNotification | undefined {
    if (this.heap.length === 0) return undefined;
    const min = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return min;
  }

  /**
   * Process a single notification.
   * If the heap is not full, just insert it.
   * If full, compare with the current min — replace if better.
   */
  offer(item: ScoredNotification): void {
    if (this.heap.length < this.capacity) {
      this.push(item);
    } else {
      const min = this.peekMin();
      if (min && this.isLowerPriority(min, item)) {
        // Current min is worse than new item — evict and replace
        this.popMin();
        this.push(item);
      }
    }
  }

  /**
   * Extract all items from the heap, sorted from highest to
   * lowest priority (the final top-N result).
   */
  drain(): ScoredNotification[] {
    const result: ScoredNotification[] = [];
    while (this.heap.length > 0) {
      result.push(this.popMin()!);
    }
    // drain gives us lowest-first; reverse for highest-first
    return result.reverse();
  }
}

// ── Core logic ───────────────────────────────────────────────

/**
 * Scores each notification and selects the top N using the
 * PriorityInbox (min-heap).
 */
async function getTopNotifications(
  notifications: Notification[],
  topN: number = 10
): Promise<ScoredNotification[]> {
  await LogDebug(
    PKG,
    `Scoring ${notifications.length} notifications with priority weights: ` +
      `Placement=${PRIORITY_WEIGHTS.Placement}, Result=${PRIORITY_WEIGHTS.Result}, Event=${PRIORITY_WEIGHTS.Event}`
  );

  // Score and parse timestamps
  const scored: ScoredNotification[] = notifications.map((n) => ({
    ...n,
    priorityScore: getPriorityWeight(n.Type),
    parsedTime: new Date(n.Timestamp).getTime(),
  }));

  // Use PriorityInbox (min-heap) for efficient top-N selection
  const inbox = new PriorityInbox(topN);

  for (const item of scored) {
    inbox.offer(item);
  }

  const topItems = inbox.drain();

  await LogInfo(
    PKG,
    `PriorityInbox selected top ${topItems.length} notifications from ${notifications.length} total — ` +
      `IDs: [${topItems.map((t) => t.ID).join(", ")}], ` +
      `types: [${topItems.map((t) => t.Type).join(", ")}]`
  );

  return topItems;
}

// ── Entry point ──────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await LogInfo(
      PKG,
      "Campus Notification Priority Inbox starting — fetching notifications from evaluation-service"
    );

    // Fetch live data
    const notifications = await fetchNotifications();

    if (notifications.length === 0) {
      await LogWarn(
        PKG,
        "No notifications returned from the API — inbox will be empty"
      );
      return;
    }

    // Get top 10 by priority + recency
    const top10 = await getTopNotifications(notifications, 10);

    // Output results via Log()
    await LogInfo(
      PKG,
      `\n========== PRIORITY INBOX — TOP 10 ==========`
    );

    for (let i = 0; i < top10.length; i++) {
      const n = top10[i];
      await LogInfo(
        PKG,
        `  #${i + 1} | ID=${n.ID} | Type=${n.Type} (priority=${n.priorityScore}) | ` +
          `Time=${n.Timestamp} | Message="${n.Message}"`
      );
    }

    await LogInfo(
      PKG,
      `Priority Inbox complete — displayed ${top10.length} notifications ` +
        `sorted by priority (Placement > Result > Event) then by recency (latest first)`
    );
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : `Unknown error: ${String(err)}`;

    try {
      await LogFatal(
        PKG,
        `Notification App terminated with fatal error: ${errorMessage}`
      );
    } catch {
      process.stderr.write(
        `[FATAL] Notification app failed and logging is unavailable: ${errorMessage}\n`
      );
    }

    process.exit(1);
  }
}

// Run when executed directly
if (require.main === module) {
  main();
}

// Export for testing
export {
  fetchNotifications,
  getTopNotifications,
  PriorityInbox,
  getPriorityWeight,
};
