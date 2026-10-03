/** tmux pane operations. Every split targets the parent pi pane. */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { hasCommand } from "./process.ts";

const execFileAsync = promisify(execFile);

export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && !!process.env.TMUX_PANE && hasCommand("tmux");
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error("Subagents require tmux. Start pi inside tmux (`tmux new -A -s pi 'pi'`).");
  }
}

/** Named tmux layout applied after each spawn and exit. */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";
let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounce layout changes. A failed resize must not prevent pane operations. */
function rebalanceSurfaces(hintPane?: string): void {
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
      });
    } catch {}
  }, 120);
}

export function createSurface(name: string): string {
  return createSurfaceSplit(name, "right", process.env.TMUX_PANE);
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name; // The pi process displays its own title.
  requireTmux();
  const args = ["split-window", "-d"];
  args.push(direction === "left" || direction === "right" ? "-h" : "-v");
  if (direction === "left" || direction === "up") args.push("-b");
  args.push("-t", fromSurface ?? process.env.TMUX_PANE!);
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!/^%\d+$/.test(pane)) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }
  rebalanceSurfaces(pane);
  return pane;
}

export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

export function closeSurface(surface: string): void {
  requireTmux();
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces();
}
