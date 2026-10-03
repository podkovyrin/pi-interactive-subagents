/** Herdr pane operations through the inherited session and socket context. */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { hasCommand } from "./process.ts";

const execFileAsync = promisify(execFile);
const CLI_OPTIONS = {
  encoding: "utf8" as const,
  stdio: "pipe" as const,
  timeout: 10_000,
  maxBuffer: 4 * 1024 * 1024,
};

function binary(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID && hasCommand(binary());
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(
      "Subagents require a Herdr-managed pane and the Herdr CLI. Start pi inside Herdr.",
    );
  }
}

export class HerdrPaneNotFoundError extends Error {
  override name = "HerdrPaneNotFoundError";
}

function cliError(action: string, error: unknown): Error {
  const cause = error as { stderr?: string; message?: string };
  // Herdr reports server error codes and messages as JSON on stderr.
  const detail = cause.stderr?.trim() || cause.message || String(error);
  const message = `Herdr pane ${action} failed: ${detail}`;
  try {
    if (JSON.parse(detail)?.error?.code === "pane_not_found") {
      return new HerdrPaneNotFoundError(message, { cause: error });
    }
  } catch {}
  return new Error(message, { cause: error });
}

function run(args: string[]): string {
  requireHerdr();
  try {
    return execFileSync(binary(), ["pane", ...args], CLI_OPTIONS);
  } catch (error) {
    throw cliError(args[0], error);
  }
}

function result(output: string): Record<string, any> {
  let data: any;
  try {
    data = JSON.parse(output);
  } catch {
    throw new Error("Herdr returned invalid JSON.");
  }
  if (!data?.result || typeof data.result !== "object" || data.error) {
    throw new Error(`Herdr returned no result: ${output.trim()}`);
  }
  return data.result;
}

function paneId(pane: any): string {
  const id = pane?.pane_id;
  if (typeof id !== "string" || !id.trim() || id.startsWith("-") || id.startsWith("%")) {
    throw new Error("Herdr returned no valid pane_id.");
  }
  return id;
}

/** Resolve caller context first because Herdr can move a pane into another workspace. */
export function createSurface(name: string): string {
  const parent = paneId(result(run(["current", "--current"])).pane);
  const layout = result(run(["layout", "--pane", parent])).layout;
  const rect = Array.isArray(layout?.panes)
    ? layout.panes.find((pane: any) => pane.pane_id === parent)?.rect
    : undefined;
  if (
    !Number.isFinite(rect?.width) ||
    !Number.isFinite(rect?.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new Error("Herdr returned no valid dimensions for the parent pane.");
  }
  // Terminal cells are about twice as tall as they are wide.
  const direction = rect.width >= 2 * rect.height ? "right" : "down";
  return createSurfaceSplit(name, direction, parent);
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name; // The pi process displays its own title.
  if (direction !== "right" && direction !== "down") {
    throw new Error(`Herdr does not support ${direction} splits. Use right or down.`);
  }
  const target = fromSurface ? ["--pane", fromSurface] : ["--current"];
  const response = run([
    "split",
    ...target,
    "--direction",
    direction,
    "--cwd",
    process.cwd(),
    "--no-focus",
  ]);
  return paneId(result(response).pane);
}

/** Herdr writes literal text and Enter as one ordered submission. Do not retry a failed write. */
export function sendCommand(surface: string, command: string): void {
  // COMMAND is a trailing argument list. Herdr treats a `--` separator as literal text.
  run(["run", surface, command]);
}

function readArgs(surface: string, lines: number): string[] {
  return [
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(1, Math.floor(lines))),
    "--format",
    "text",
  ];
}

export function readScreen(surface: string, lines = 50): string {
  return run(readArgs(surface, lines));
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  try {
    const { stdout } = await execFileAsync(
      binary(),
      ["pane", ...readArgs(surface, lines)],
      CLI_OPTIONS,
    );
    return stdout;
  } catch (error) {
    throw cliError("read", error);
  }
}

export function closeSurface(surface: string): void {
  run(["close", surface]);
}
