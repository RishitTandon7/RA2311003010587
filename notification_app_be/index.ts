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
const PKG: LogPackage = "service";

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
    "Fetching notifications"
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
      `Fetched ${notifications.length} notifications`
    );

    return notifications;
  } catch (err) {
    const msg =
      err instanceof AxiosError
        ? `Notifications API failed`
        : `Unexpected error fetching`;

    await LogError(PKG, msg);
    throw new Error(msg);
  }
}

// ── PriorityInbox — Efficient Top-N Selection via Min-Heap ───

/**
 * PriorityInbox selects the top-N notifications WITHOUT fully
 * sorting the entire array. This is crucial when the dataset
 * grows large (thousands of notifications).
 *
 * Approach: Min-heap of fixed capacity (maxSize).
 *
 * We maintain a min-heap where the "minimum" element is the
 * one with the LOWEST priority (i.e. least important). For
 * each incoming notification via add():
 *   - If the heap has fewer than maxSize items, push it in.
 *   - Otherwise, compare with the heap's minimum:
 *     if the new item has higher priority, replace the min.
 *
 * Time:  O(n × log N) where n = total notifications, N = maxSize
 * Space: O(N)
 *
 * This avoids the O(n × log n) cost of sorting the entire array
 * when N ≪ n (e.g. top 10 out of 10,000).
 */
class PriorityInbox {
  private heap: ScoredNotification[] = [];
  private readonly maxSize: number;

  /**
   * @param maxSize - Maximum number of top notifications to keep (default: 10)
   */
  constructor(maxSize: number = 10) {
    this.maxSize = maxSize;
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
   * add(notification) — Process a single notification.
   *
   * If the heap is not full, insert it directly.
   * If full, compare with the current minimum — replace if the
   * new notification has higher priority. This ensures we never
   * call .sort() on the full array.
   *
   * Includes a Log() call for observability on evictions.
   */
  async add(item: ScoredNotification): Promise<void> {
    if (this.heap.length < this.maxSize) {
      // Heap not full yet — simply insert
      this.push(item);
      const shortId = String(item.ID).substring(0, 8);
      await LogDebug(
        PKG,
        `Added ${shortId} (${this.heap.length}/${this.maxSize})`
      );
    } else {
      const min = this.peekMin();
      if (min && this.isLowerPriority(min, item)) {
        // Current min is worse than new item — evict and replace
        const evicted = this.popMin()!;
        this.push(item);
        const shortId = String(item.ID).substring(0, 8);
        const evId = String(evicted.ID).substring(0, 8);
        await LogDebug(
          PKG,
          `Repl ${evId} w/ ${shortId}`
        );
      }
      // else: new item is worse than current min — skip silently
    }
  }

  /**
   * getTop() — Extract all items from the heap, sorted from
   * highest to lowest priority (the final top-N result).
   *
   * This drains the heap; call only once after all add() calls.
   */
  getTop(): ScoredNotification[] {
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
    `Scoring ${notifications.length} notifications`
  );

  // Score and parse timestamps
  const scored: ScoredNotification[] = notifications.map((n) => ({
    ...n,
    priorityScore: getPriorityWeight(n.Type),
    parsedTime: new Date(n.Timestamp).getTime(),
  }));

  await LogInfo(
    PKG,
    `Inserting into PriorityInbox`
  );

  // Use PriorityInbox (min-heap) for efficient top-N selection
  const inbox = new PriorityInbox(topN);

  for (const item of scored) {
    await inbox.add(item);
  }

  const topItems = inbox.getTop();

  await LogInfo(
    PKG,
    `PriorityInbox returned top ${topItems.length}`
  );

  return topItems;
}

// ── Entry point ──────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await LogInfo(
      PKG,
      "Priority Inbox starting"
    );

    // Fetch live data
    const notifications = await fetchNotifications();

    if (notifications.length === 0) {
      await LogWarn(
        PKG,
        "No notifications returned"
      );
      return;
    }

    // Get top 10 by priority + recency
    const top10 = await getTopNotifications(notifications, 10);

    // Print formatted top-10 to stdout (process.stdout.write ≠ console.log)
    process.stdout.write("\n=== PRIORITY INBOX — TOP 10 NOTIFICATIONS ===\n\n");
    for (let i = 0; i < top10.length; i++) {
      const n = top10[i];
      const idx  = String(i + 1).padStart(2, " ");
      const type = `[${n.Type}]`.padEnd(11, " ");
      const msg  = (n.Message ?? "").substring(0, 45);
      const ts   = n.Timestamp ?? "";
      process.stdout.write(`#${idx} ${type} ${msg}   ${ts}\n`);

      // Also send to API Log
      const logText = `#${i + 1} [${n.Type}] ${(n.Message ?? "").substring(0, 30)}`;
      await LogInfo(PKG, logText.substring(0, 47));
    }

    process.stdout.write("\n");
    await LogInfo(
      PKG,
      `Priority Inbox complete`
    );
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : `Unknown error: ${String(err)}`;

    process.stderr.write(`[DEBUG FATAL] ${errorMessage}\n`);
    try {
      await LogFatal(
        PKG,
        `Notification App fatal error`
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
