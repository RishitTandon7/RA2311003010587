// =============================================================
// Phase 2: Vehicle Maintenance Scheduler — 0/1 Knapsack
// =============================================================
// Fetches depots and vehicle tasks from the evaluation-service,
// then runs a dynamic-programming 0/1 knapsack per depot to
// maximise total operational impact within mechanic-hour budgets.
//
// API shape (discovered from live data):
//   GET /depots   → [ { ID: number, MechanicHours: number } ]
//   GET /vehicles → [ { TaskID: string (UUID), Duration: number, Impact: number } ]
//
// NOTE: Vehicles have NO DepotID — they are a shared pool.
//       Each depot's knapsack runs over the FULL vehicle list.
//
// RULES:
//   - NO external libraries for the knapsack algorithm
//   - NO console.log — use process.stdout.write for terminal output
//   - Bearer token from .env (never hardcoded)
//   - Data fetched live (never stored in a DB)
// =============================================================

import axios, { AxiosError } from "axios";
import * as dotenv from "dotenv";
import * as path from "path";
import {
  LogInfo,
  LogDebug,
  LogError,
  LogFatal,
  LogPackage,
} from "../logging_middleware/index";

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// ── Package identifier for all logs from this module ─────────
const PKG: LogPackage = "service";

// ── Types ────────────────────────────────────────────────────

/** A depot with its daily mechanic-hour budget */
interface Depot {
  ID: number;
  MechanicHours: number;
}

/** A vehicle maintenance task with duration (weight) and impact (value) */
interface VehicleTask {
  TaskID: string;   // UUID string from API
  Duration: number; // hours — acts as "weight" in knapsack
  Impact: number;   // operational importance — acts as "value" in knapsack
}

/** Result of the knapsack for a single depot */
interface DepotSchedule {
  depotId: number;
  mechanicHoursBudget: number;
  selectedTaskIds: string[];
  totalDuration: number;
  totalImpact: number;
  tasksConsidered: number;
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
 * Fetches the list of depots from the evaluation-service.
 * Each depot defines a mechanic-hour budget (capacity).
 */
async function fetchDepots(): Promise<Depot[]> {
  await LogInfo(PKG, "Initiating GET request to /depots");

  try {
    const response = await axios.get(`${API_BASE}/depots`, {
      headers: getAuthHeaders(),
      timeout: 15_000,
    });

    // API may return { depots: [...] } or plain array
    const depots: Depot[] = response.data?.depots ?? response.data;

    await LogInfo(PKG, `Fetched ${depots.length} depots`);
    return depots;
  } catch (err) {
    const msg =
      err instanceof AxiosError
        ? `Depot API failed: ${err.response?.status}`
        : `Error fetching depots`;
    await LogError(PKG, msg);
    throw new Error(msg);
  }
}

/**
 * Fetches the list of vehicle maintenance tasks.
 * Tasks have NO DepotID — they form a shared pool across all depots.
 */
async function fetchVehicles(): Promise<VehicleTask[]> {
  await LogInfo(PKG, "Initiating GET request to /vehicles");

  try {
    const response = await axios.get(`${API_BASE}/vehicles`, {
      headers: getAuthHeaders(),
      timeout: 15_000,
    });

    // API may return { vehicles: [...] } or plain array
    const vehicles: VehicleTask[] = response.data?.vehicles ?? response.data;

    await LogInfo(PKG, `Fetched ${vehicles.length} vehicle tasks`);
    return vehicles;
  } catch (err) {
    const msg =
      err instanceof AxiosError
        ? `Vehicles API failed: ${err.response?.status}`
        : `Error fetching vehicles`;
    await LogError(PKG, msg);
    throw new Error(msg);
  }
}

// ── 0/1 Knapsack — Pure DP (no external libraries) ──────────

/**
 * Classic 0/1 Knapsack via bottom-up dynamic programming.
 *
 * Time:  O(n × W)  where W = capacity
 * Space: O(n × W)  full DP table used for backtracking
 *
 * @param tasks    - Array of vehicle tasks to consider (shared pool)
 * @param capacity - Available mechanic-hours for this depot (integer)
 * @returns        - Subset of tasks that maximises total Impact
 */
export function knapsack01(tasks: VehicleTask[], capacity: number): VehicleTask[] {
  const n = tasks.length;
  const W = Math.floor(capacity); // must be integer for DP indices

  if (n === 0 || W <= 0) return [];

  // ── Build DP table ────────────────────────────────────────
  // dp[i][w] = max impact using first i tasks with weight limit w
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(W + 1).fill(0)
  );

  for (let i = 1; i <= n; i++) {
    const weight = Math.floor(tasks[i - 1].Duration); // Duration = weight
    const value  = tasks[i - 1].Impact;               // Impact   = value

    for (let w = 0; w <= W; w++) {
      if (weight <= w) {
        // Include or skip — take the better option
        dp[i][w] = Math.max(dp[i - 1][w], dp[i - 1][w - weight] + value);
      } else {
        dp[i][w] = dp[i - 1][w]; // Cannot fit — skip
      }
    }
  }

  // ── Backtrack to find which tasks were selected ───────────
  const selected: VehicleTask[] = [];
  let rem = W;

  for (let i = n; i >= 1; i--) {
    if (dp[i][rem] !== dp[i - 1][rem]) {
      selected.push(tasks[i - 1]);
      rem -= Math.floor(tasks[i - 1].Duration);
    }
  }

  return selected.reverse(); // restore original order
}

// ── Per-depot scheduling ─────────────────────────────────────

/**
 * Runs knapsack over the FULL vehicle pool for a given depot.
 * Each depot sees all tasks (no DepotID filter needed).
 */
export async function scheduleMaintenanceForDepot(
  depot: Depot,
  allTasks: VehicleTask[]
): Promise<DepotSchedule> {
  await LogDebug(
    PKG,
    `Depot ${depot.ID}: running knapsack (cap=${depot.MechanicHours})`
  );

  // Run 0/1 Knapsack DP over the full task pool
  const selectedTasks = knapsack01(allTasks, depot.MechanicHours);

  const totalDuration = selectedTasks.reduce((s, t) => s + t.Duration, 0);
  const totalImpact   = selectedTasks.reduce((s, t) => s + t.Impact,   0);

  await LogInfo(PKG, `Depot ${depot.ID} schedule optimised`);

  return {
    depotId:             depot.ID,
    mechanicHoursBudget: depot.MechanicHours,
    selectedTaskIds:     selectedTasks.map((t) => t.TaskID),
    totalDuration,
    totalImpact,
    tasksConsidered:     allTasks.length,
  };
}

// ── Entry point ──────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await LogInfo(PKG, "Scheduler starting — fetching data");

    // Fetch both in parallel (never stored in DB)
    const [depots, vehicles] = await Promise.all([
      fetchDepots(),
      fetchVehicles(),
    ]);

    await LogInfo(PKG, `Data retrieval complete`);

    // Process each depot
    const schedules: DepotSchedule[] = [];
    for (const depot of depots) {
      const schedule = await scheduleMaintenanceForDepot(depot, vehicles);
      schedules.push(schedule);
    }

    await LogInfo(PKG, `All depots processed`);

    // ── Print formatted results to terminal ─────────────────
    // process.stdout.write is allowed (only console.log is banned)
    process.stdout.write("\n=== VEHICLE MAINTENANCE SCHEDULE RESULTS ===\n\n");

    for (const sch of schedules) {
      process.stdout.write(`Depot ${sch.depotId} (capacity: ${sch.mechanicHoursBudget})\n`);
      process.stdout.write(`  Selected tasks: [${sch.selectedTaskIds.join(", ")}]\n`);
      process.stdout.write(`  Total Duration: ${sch.totalDuration}\n`);
      process.stdout.write(`  Total Impact:   ${sch.totalImpact}\n\n`);

      // Log summary line to evaluation API
      await LogInfo(PKG, `Depot ${sch.depotId} tasks: ${sch.selectedTaskIds.length}`);
      await LogInfo(PKG, `Depot ${sch.depotId} impact: ${sch.totalImpact}`);
    }

    await LogInfo(PKG, "Scheduler completed successfully");
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : `Unknown error: ${String(err)}`;

    try {
      await LogFatal(PKG, `Scheduler fatal error`);
    } catch {
      process.stderr.write(
        `[FATAL] Scheduler failed and logging unavailable: ${errorMessage}\n`
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
export { fetchDepots, fetchVehicles };
