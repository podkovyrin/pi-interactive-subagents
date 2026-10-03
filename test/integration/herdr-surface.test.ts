import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import {
  closeSurface,
  createSurface,
  getMuxBackend,
  pollForExit,
  readScreen,
  readScreenAsync,
  sendLongCommand,
  shellEscape,
} from "../../pi-extension/subagents/mux.ts";

function layout(): any {
  const output = execFileSync(
    process.env.HERDR_BIN_PATH || "herdr",
    ["pane", "layout", "--current"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  return JSON.parse(output).result.layout;
}

// No model calls. The test closes only the pane that it creates.
it(
  "Herdr creates, runs, reads, polls, and closes a background pane",
  {
    skip: getMuxBackend() !== "herdr",
    timeout: 30_000,
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-herdr-integration-"));
    const before = layout();
    let surface: string | undefined;
    try {
      surface = createSurface("integration-test");
      const after = layout();
      assert.equal(after.focused_pane_id, before.focused_pane_id);
      assert.equal(after.panes.length, before.panes.length + 1);
      assert.ok(after.panes.some((pane: any) => pane.pane_id === surface));

      // Allow shell initialization before command submission, as the extension does.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const contextFile = join(dir, "context.txt");
      const marker = `herdr-test-${Date.now()}-${"x".repeat(300)}-end`;
      sendLongCommand(
        surface,
        [
          `printf '%s\\n' "$HERDR_PANE_ID" "$PWD" > ${shellEscape(contextFile)}`,
          `printf '%s\\n' ${shellEscape(marker)}`,
          "echo '__SUBAGENT_DONE_0__'",
        ].join("\n"),
        { scriptPath: join(dir, "launch script's.sh") },
      );
      assert.deepEqual(await pollForExit(surface, AbortSignal.timeout(15_000), { interval: 200 }), {
        reason: "sentinel",
        exitCode: 0,
      });
      assert.equal(readFileSync(contextFile, "utf8"), `${surface}\n${process.cwd()}\n`);
      const screen = await readScreenAsync(surface, 50);
      assert.ok(screen.includes(marker), "The read must join soft wraps.");
      assert.ok(!screen.includes("\x1b"), "Text reads must not contain ANSI escapes.");
      assert.ok(readScreen(surface, 50).includes(marker));
      closeSurface(surface);
      const closed = surface;
      surface = undefined;
      assert.equal(layout().panes.length, before.panes.length);
      await assert.rejects(
        pollForExit(closed, AbortSignal.timeout(2000), { interval: 100 }),
        /pane_not_found/,
      );
    } catch (error) {
      const screen = surface ? readScreen(surface, 100) : "";
      throw new Error(`${String(error)}\nLast screen:\n${screen}`, { cause: error });
    } finally {
      if (surface) {
        try {
          closeSurface(surface);
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
