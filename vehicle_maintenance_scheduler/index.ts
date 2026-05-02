// =============================================================
// Phase 2: Vehicle Maintenance Scheduler — 0/1 Knapsack
// =============================================================
// Fetches depots and vehicle tasks from the evaluation-service,
// then runs a dynamic-programming 0/1 knapsack per depot to
// maximise total operational impact within mechanic-hour budgets.
//
// RULES:
//   - NO external libraries for the knapsack algorithm
//   - NO console.log — all output via Log()
//   - Bearer token from .env (never hardcoded)
//   - Data fetched live (never stored in a DB)
// =============================================================

import axios, { AxiosError } from "axios";
import * as dotenv from "dotenv";
import * as path from "path";
import {
  Log,
  LogInfo,
  LogDebug,
  LogError,
  LogFatal,
  LogPackage,
} from "../logging_middleware/index";

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// ── Package identifier for all logs from this module ─────────
const PKG: LogPackage = "vehicle_maintenance_scheduler";

// ── Types ────────────────────────────────────────────────────

/** A depot with its daily mechanic-hour budget */
interface Depot {
  ID: number;
  MechanicHours: number;
}

/** A vehicle maintenance task with duration (weight) and impact (value) */
interface VehicleTask {
  TaskID: number;
  Duration: number; // hours — acts as "weight" in knapsack
  Impact: number;   // operational importance — acts as "value" in knapsack
  DepotID: number;
}

/** Result of the knapsack for a single depot */
interface DepotSchedule {
  depotId: number;
  mechanicHoursBudget: number;
  selectedTasks: VehicleTask[];
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
  await LogInfo(
    PKG,
    "Initiating GET request to /depots endpoint to retrieve depot data"
  );

  try {
    const response = await axios.get(`${API_BASE}/depots`, {
      headers: getAuthHeaders(),
      timeout: 15_000,
    });

    const depots: Depot[] = response.data.depots ?? response.data;

    await LogInfo(
      PKG,
      `Successfully fetched ${depots.length} depots — IDs: [${depots.map((d) => d.ID).join(", ")}], ` +
        `MechanicHours: [${depots.map((d) => d.MechanicHours).join(", ")}]`
    );

    return depots;
  } catch (err) {
    const msg =
      err instanceof AxiosError
        ? `Depot API request failed [status=${err.response?.status ?? "N/A"}]: ${err.message}`
        : `Unexpected error fetching depots: ${String(err)}`;

    await LogError(PKG, msg);
    throw new Error(msg);
  }
}

/**
 * Fetches the list of vehicle maintenance tasks.
 * Each task has a Duration (weight) and Impact (value).
 */
async function fetchVehicles(): Promise<VehicleTask[]> {
  await LogInfo(
    PKG,
    "Initiating GET request to /vehicles endpoint to retrieve vehicle task data"
  );

  try {
    const response = await axios.get(`${API_BASE}/vehicles`, {
      headers: getAuthHeaders(),
      timeout: 15_000,
    });

    const vehicles: VehicleTask[] = response.data.vehicles ?? response.data;

    await LogInfo(
      PKG,
      `Successfully fetched ${vehicles.length} vehicle tasks — ` +
        `TaskID range: [${Math.min(...vehicles.map((v) => v.TaskID))}–${Math.max(...vehicles.map((v) => v.TaskID))}], ` +
        `total Duration: ${vehicles.reduce((s, v) => s + v.Duration, 0)}h, ` +
        `total Impact: ${vehicles.reduce((s, v) => s + v.Impact, 0)}`
    );

    return vehicles;
  } catch (err) {
    const msg =
      err instanceof AxiosError
        ? `Vehicles API request failed [status=${err.response?.status ?? "N/A"}]: ${err.message}`
        : `Unexpected error fetching vehicles: ${String(err)}`;

    await LogError(PKG, msg);
    throw new Error(msg);
  }
}

// ── 0/1 Knapsack — Pure DP (no external libraries) ──────────

/**
 * Classic 0/1 Knapsack via bottom-up dynamic programming.
 *
 * Time:  O(n × capacity)
 * Space: O(n × capacity) — full DP table for backtracking
 *
 * @param tasks    - Array of vehicle tasks to consider
 * @param capacity - Available mechanic-hours (integer)
 * @returns        - Subset of tasks that maximises total Impact
 */
function knapsack01(tasks: VehicleTask[], capacity: number): VehicleTask[] {
  const n = tasks.length;

  // Capacity must be an integer for the DP table indices
  const W = Math.floor(capacity);

  if (n === 0 || W <= 0) return [];

  // ── Build DP table ────────────────────────────────────────
  // dp[i][w] = maximum impact achievable using first i items
  //            with capacity w
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(W + 1).fill(0)
  );

  for (let i = 1; i <= n; i++) {
    const task = tasks[i - 1];
    const weight = Math.floor(task.Duration); // Duration = weight
    const value = task.Impact;                // Impact   = value

    for (let w = 0; w <= W; w++) {
      if (weight <= w) {
        // Choose the better: skip this task, or include it
        dp[i][w] = Math.max(dp[i - 1][w], dp[i - 1][w - weight] + value);
      } else {
        dp[i][w] = dp[i - 1][w]; // Cannot fit — skip
      }
    }
  }

  // ── Backtrack to find which tasks were selected ───────────
  const selected: VehicleTask[] = [];
  let remainingCapacity = W;

  for (let i = n; i >= 1; i--) {
    if (dp[i][remainingCapacity] !== dp[i - 1][remainingCapacity]) {
      // Task i was included in the optimal solution
      selected.push(tasks[i - 1]);
      remainingCapacity -= Math.floor(tasks[i - 1].Duration);
    }
  }

  return selected.reverse(); // Return in original order
}

// ── Main scheduler logic ─────────────────────────────────────

/**
 * For each depot, filter its vehicle tasks and run the knapsack
 * to select the optimal maintenance schedule.
 */
async function scheduleMaintenanceForDepot(
  depot: Depot,
  allTasks: VehicleTask[]
): Promise<DepotSchedule> {
  // Filter tasks belonging to this depot
  const depotTasks = allTasks.filter((t) => t.DepotID === depot.ID);

  await LogDebug(
    PKG,
    `Depot ${depot.ID}: ${depotTasks.length} tasks available, ` +
      `mechanic-hour budget = ${depot.MechanicHours}h`
  );

  // Run 0/1 Knapsack DP
  const selectedTasks = knapsack01(depotTasks, depot.MechanicHours);

  const totalDuration = selectedTasks.reduce((s, t) => s + t.Duration, 0);
  const totalImpact = selectedTasks.reduce((s, t) => s + t.Impact, 0);

  await LogInfo(
    PKG,
    `Depot ${depot.ID} schedule optimised — selected ${selectedTasks.length}/${depotTasks.length} tasks, ` +
      `totalDuration=${totalDuration}h/${depot.MechanicHours}h budget, ` +
      `totalImpact=${totalImpact}, ` +
      `selectedTaskIDs=[${selectedTasks.map((t) => t.TaskID).join(", ")}]`
  );

  return {
    depotId: depot.ID,
    mechanicHoursBudget: depot.MechanicHours,
    selectedTasks,
    totalDuration,
    totalImpact,
    tasksConsidered: depotTasks.length,
  };
}

// ── Entry point ──────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await LogInfo(
      PKG,
      "Vehicle Maintenance Scheduler starting — fetching depot and vehicle data from evaluation-service"
    );

    // Fetch data live from APIs (never stored in DB)
    const [depots, vehicles] = await Promise.all([
      fetchDepots(),
      fetchVehicles(),
    ]);

    await LogInfo(
      PKG,
      `Data retrieval complete — ${depots.length} depots, ${vehicles.length} vehicle tasks loaded`
    );

    // Process each depot independently
    const schedules: DepotSchedule[] = [];

    for (const depot of depots) {
      const schedule = await scheduleMaintenanceForDepot(depot, vehicles);
      schedules.push(schedule);
    }

    // ── Summary output ──────────────────────────────────────
    const grandTotalImpact = schedules.reduce(
      (s, sch) => s + sch.totalImpact,
      0
    );
    const grandTotalDuration = schedules.reduce(
      (s, sch) => s + sch.totalDuration,
      0
    );
    const grandTotalSelected = schedules.reduce(
      (s, sch) => s + sch.selectedTasks.length,
      0
    );

    await LogInfo(
      PKG,
      `All depots processed — ${grandTotalSelected} tasks scheduled across ${depots.length} depots, ` +
        `combined duration=${grandTotalDuration}h, combined impact=${grandTotalImpact}`
    );

    // Print results per depot (using Log, never console.log)
    for (const sch of schedules) {
      await LogInfo(
        PKG,
        `\n=== Depot ${sch.depotId} ===\n` +
          `  Budget: ${sch.mechanicHoursBudget}h\n` +
          `  Tasks Considered: ${sch.tasksConsidered}\n` +
          `  Tasks Selected: ${sch.selectedTasks.length}\n` +
          `  Total Duration: ${sch.totalDuration}h\n` +
          `  Total Impact: ${sch.totalImpact}\n` +
          `  Selected Tasks:\n` +
          sch.selectedTasks
            .map(
              (t) =>
                `    - TaskID=${t.TaskID}, Duration=${t.Duration}h, Impact=${t.Impact}`
            )
            .join("\n")
      );
    }

    await LogInfo(
      PKG,
      "Vehicle Maintenance Scheduler completed successfully — all depot schedules optimised"
    );
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : `Unknown error: ${String(err)}`;

    try {
      await LogFatal(
        PKG,
        `Vehicle Maintenance Scheduler terminated with fatal error: ${errorMessage}`
      );
    } catch {
      // If logging itself fails, write to stderr as last resort
      process.stderr.write(
        `[FATAL] Scheduler failed and logging is unavailable: ${errorMessage}\n`
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
export { knapsack01, fetchDepots, fetchVehicles, scheduleMaintenanceForDepot };
