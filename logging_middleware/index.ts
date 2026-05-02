// =============================================================
// Phase 1: Logging Middleware
// =============================================================
// A reusable logging package that validates inputs and sends
// structured log entries to the evaluation-service /logs API.
//
// RULES:
//   - console.log is NEVER used (all output via Log())
//   - Bearer token is read from process.env.ACCESS_TOKEN
//   - All pkg values must be from the allowed list
//   - Messages must be descriptive (no bare "done" / "error")
// =============================================================

import axios, { AxiosError } from "axios";
import * as dotenv from "dotenv";

// Load environment variables from .env at project root
dotenv.config({ path: require("path").resolve(__dirname, "..", ".env") });

// ── Types ────────────────────────────────────────────────────

/** Allowed log levels matching the evaluation-service contract */
export type LogLevel = "info" | "debug" | "error" | "warn" | "fatal";

/** Allowed stack identifiers — "backend" or "frontend" */
export type LogStack = "backend" | "frontend";

/**
 * Allowed package names — every call to Log() must use one of
 * these so the evaluation service can categorise the entry.
 */
export type LogPackage =
  | "middleware"
  | "service"
  | "auth";

/** Shape of a single log entry sent to the API */
export interface LogEntry {
  stack: LogStack;
  level: LogLevel;
  package: LogPackage;
  message: string;
}

// ── Constants ────────────────────────────────────────────────

const ALLOWED_LEVELS: ReadonlySet<string> = new Set<LogLevel>([
  "info",
  "debug",
  "error",
  "warn",
  "fatal",
]);

const ALLOWED_STACKS: ReadonlySet<string> = new Set<LogStack>([
  "backend",
  "frontend",
]);

const ALLOWED_PACKAGES: ReadonlySet<string> = new Set<LogPackage>([
  "middleware",
  "service",
  "auth",
]);

const API_BASE_URL =
  process.env.API_BASE_URL || "http://20.207.122.201/evaluation-service";

const LOGS_ENDPOINT = `${API_BASE_URL}/logs`;

// ── Validation helpers ───────────────────────────────────────

/**
 * Validates that a given value belongs to the allowed set.
 * Returns a human-readable error string or null when valid.
 */
function validateField(
  fieldName: string,
  value: unknown,
  allowed: ReadonlySet<string>
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `${fieldName} is required and must be a non-empty string`;
  }
  if (!allowed.has(value)) {
    return `${fieldName} "${value}" is not allowed. Accepted values: ${[
      ...allowed,
    ].join(", ")}`;
  }
  return null;
}

/**
 * Validates the complete LogEntry before sending it to the API.
 * Throws a descriptive error when validation fails so invalid
 * values are never silently accepted.
 */
function validateLogEntry(entry: LogEntry): void {
  const errors: string[] = [];

  const stackErr = validateField("stack", entry.stack, ALLOWED_STACKS);
  if (stackErr) errors.push(stackErr);

  const levelErr = validateField("level", entry.level, ALLOWED_LEVELS);
  if (levelErr) errors.push(levelErr);

  const pkgErr = validateField("package", entry.package, ALLOWED_PACKAGES);
  if (pkgErr) errors.push(pkgErr);

  if (typeof entry.message !== "string" || entry.message.trim().length === 0) {
    errors.push("message is required and must be a non-empty string");
  }

  if (errors.length > 0) {
    throw new Error(
      `Log validation failed with ${errors.length} error(s): ${errors.join("; ")}`
    );
  }
}

// ── Core Log function ────────────────────────────────────────

/**
 * Log() — the single authorised way to emit log messages.
 *
 * Accepts 4 fields: stack, level, package (pkg), message.
 *
 * 1. Validates stack, level, package, and message
 * 2. POSTs the entry to the evaluation-service /logs endpoint
 * 3. Returns the API response data on success
 * 4. Catches and re-throws errors with descriptive context
 *
 * @example
 * await Log({
 *   stack: "backend",
 *   level: "info",
 *   package: "vehicle_maintenance_scheduler",
 *   message: "Fetched 5 depots and 42 vehicle tasks from API"
 * });
 */
export async function Log(entry: LogEntry): Promise<unknown> {
  // ── Step 1: Validate all 4 fields ───────────────────────
  validateLogEntry(entry);

  // ── Step 2: Read token (never hardcoded) ────────────────
  const token = process.env.ACCESS_TOKEN;
  if (!token || token === "your_bearer_token_here") {
    throw new Error(
      "ACCESS_TOKEN is not set in .env — cannot authenticate with the logging API"
    );
  }

  // ── Step 3: POST to evaluation-service /logs ────────────
  try {
    const response = await axios.post(
      LOGS_ENDPOINT,
      {
        stack: entry.stack,
        level: entry.level,
        package: entry.package,
        message: entry.message,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        timeout: 10_000, // 10-second timeout to avoid hanging
      }
    );

    return response.data;
  } catch (err) {
    // Provide descriptive context about what went wrong
    if (err instanceof AxiosError) {
      const status = err.response?.status ?? "no response";
      const detail =
        typeof err.response?.data === "string"
          ? err.response.data
          : JSON.stringify(err.response?.data ?? err.message);

      throw new Error(
        `Log API call failed [status=${status}]: ${detail} | ` +
          `Original entry: level=${entry.level}, pkg=${entry.package}, msg="${entry.message}"`
      );
    }
    throw err;
  }
}

// ── Convenience wrappers ─────────────────────────────────────

/** Shortcut for info-level backend logs */
export async function LogInfo(
  pkg: LogPackage,
  message: string
): Promise<unknown> {
  return Log({ stack: "backend", level: "info", package: pkg, message });
}

/** Shortcut for debug-level backend logs */
export async function LogDebug(
  pkg: LogPackage,
  message: string
): Promise<unknown> {
  return Log({ stack: "backend", level: "debug", package: pkg, message });
}

/** Shortcut for error-level backend logs */
export async function LogError(
  pkg: LogPackage,
  message: string
): Promise<unknown> {
  return Log({ stack: "backend", level: "error", package: pkg, message });
}

/** Shortcut for warn-level backend logs */
export async function LogWarn(
  pkg: LogPackage,
  message: string
): Promise<unknown> {
  return Log({ stack: "backend", level: "warn", package: pkg, message });
}

/** Shortcut for fatal-level backend logs */
export async function LogFatal(
  pkg: LogPackage,
  message: string
): Promise<unknown> {
  return Log({ stack: "backend", level: "fatal", package: pkg, message });
}

// ── Self-test (runs only when executed directly) ─────────────

async function selfTest(): Promise<void> {
  process.stdout.write("\n=== LOGGING MIDDLEWARE — SELF-TEST ===\n\n");
  try {
    await Log({
      stack: "backend",
      level: "info",
      package: "middleware",
      message: "Self-test: validating connection",
    });
    process.stdout.write("[OK] info  → API accepted log entry\n");

    await Log({
      stack: "backend",
      level: "debug",
      package: "middleware",
      message: "Self-test debug entry",
    });
    process.stdout.write("[OK] debug → API accepted log entry\n");

    await Log({
      stack: "backend",
      level: "warn",
      package: "middleware",
      message: "Self-test warn entry",
    });
    process.stdout.write("[OK] warn  → API accepted log entry\n");

    await Log({
      stack: "backend",
      level: "error",
      package: "middleware",
      message: "Self-test error entry",
    });
    process.stdout.write("[OK] error → API accepted log entry\n");

    await Log({
      stack: "backend",
      level: "info",
      package: "middleware",
      message: "Self-test completed successfully",
    });
    process.stdout.write("[OK] info  → API accepted log entry\n");

    process.stdout.write("\n✓ All 5 log entries sent successfully\n");
    process.stdout.write("  Endpoint: " + LOGS_ENDPOINT + "\n");
    process.stdout.write("  Stack: backend | Package: middleware\n\n");
  } catch (err) {
    // We intentionally write to stderr here ONLY during self-test
    // because the logging API itself failed and we need a fallback
    process.stderr.write(
      `[LOGGING SELF-TEST FAILED] ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

// Run self-test when this file is executed directly
if (require.main === module) {
  selfTest();
}
