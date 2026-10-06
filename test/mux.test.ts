import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  closeSurface,
  createSurface,
  createSurfaceSplit,
  getMuxBackend,
  isMuxAvailable,
  pollForExit,
  readScreen,
  readScreenAsync,
  sendCommand,
  sendLongCommand,
} from "../pi-extension/subagents/mux.ts";
import subagentsExtension from "../pi-extension/subagents/index.ts";
import { registerName, writeSubagentLoadout } from "../pi-extension/subagents/session.ts";

let dir: string;
let savedEnv: NodeJS.ProcessEnv;

function calls(): { binary: string; args: string[] }[] {
  if (!existsSync(join(dir, "calls.jsonl"))) return [];
  return readFileSync(join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  savedEnv = { ...process.env };
  dir = mkdtempSync(join(tmpdir(), "pi-mux-test-"));
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "wOld:p1";
  process.env.FAKE_CALL_LOG = join(dir, "calls.jsonl");
  delete process.env.HERDR_BIN_PATH;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  const fake = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const binary = path.basename(process.argv[1]);
fs.appendFileSync(process.env.FAKE_CALL_LOG, JSON.stringify({ binary, args }) + "\\n");
if (args[1] === process.env.FAKE_FAIL_ACTION) {
  process.stderr.write(JSON.stringify({ error: { code: process.env.FAKE_FAIL_CODE || "pane_not_found", message: "The operation failed" } }));
  process.exit(1);
}
if (binary === "tmux") {
  if (args[0] === "split-window") process.stdout.write("%42\\n");
} else if (args[1] === "read") {
  process.stdout.write(process.env.FAKE_SCREEN || "literal $text\\n__SUBAGENT_DONE_7__\\n");
} else if (process.env.FAKE_RESPONSE) {
  process.stdout.write(process.env.FAKE_RESPONSE);
} else {
  const result = args[1] === "current" ? { pane: { pane_id: "wNew:p1" } }
    : args[1] === "layout" ? { layout: { panes: [{ pane_id: "wNew:p1", rect: {
        width: Number(process.env.FAKE_WIDTH || 200), height: Number(process.env.FAKE_HEIGHT || 50),
      } }] } }
    : { pane: { pane_id: "wNew:p2" } };
  process.stdout.write(JSON.stringify({ result }));
}
`;
  for (const binary of ["herdr", "tmux"]) writeFileSync(join(dir, binary), fake, { mode: 0o755 });
});

afterEach(async () => {
  // Let tmux's debounced layout run against the fake binary before restoring PATH.
  await new Promise((resolve) => setTimeout(resolve, 160));
  process.env = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("pane backend selection", () => {
  it("requires a managed Herdr caller, not just an installed binary", () => {
    assert.equal(getMuxBackend(), "herdr");
    process.env.HERDR_ENV = "0";
    assert.equal(isMuxAvailable(), false);
    process.env.HERDR_ENV = "1";
    delete process.env.HERDR_PANE_ID;
    assert.equal(isMuxAvailable(), false);
    assert.deepEqual(calls(), []);
    assert.throws(() => createSurface("scout"), /No supported pane backend/);
  });

  it("uses HERDR_BIN_PATH when the executable path contains spaces", () => {
    const binary = join(dir, "herdr with spaces");
    copyFileSync(join(dir, "herdr"), binary);
    process.env.HERDR_BIN_PATH = binary;
    assert.equal(getMuxBackend(), "herdr");
    assert.equal(createSurface("scout"), "wNew:p2");
    assert.equal(calls()[0].binary, "herdr with spaces");
  });

  it("rejects a missing Herdr executable without controlling another backend", () => {
    process.env.HERDR_BIN_PATH = join(dir, "missing");
    assert.equal(isMuxAvailable(), false);
    assert.deepEqual(calls(), []);
  });

  it("prefers nested tmux and does not escape an incomplete tmux context", () => {
    process.env.TMUX = "/fake/socket,1,0";
    assert.equal(getMuxBackend(), null);
    process.env.TMUX_PANE = "%1";
    assert.equal(getMuxBackend(), "tmux");
    assert.equal(createSurface("scout"), "%42");
    assert.deepEqual(calls()[0], {
      binary: "tmux",
      args: ["split-window", "-d", "-h", "-t", "%1", "-P", "-F", "#{pane_id}"],
    });
  });
});

describe("Herdr panes", () => {
  it("resolves the caller after a move and creates a background right split in the same cwd", () => {
    assert.equal(createSurface("scout"), "wNew:p2");
    assert.deepEqual(
      calls().map((call) => call.args),
      [
        ["pane", "current", "--current"],
        ["pane", "layout", "--pane", "wNew:p1"],
        [
          "pane",
          "split",
          "--pane",
          "wNew:p1",
          "--direction",
          "right",
          "--cwd",
          process.cwd(),
          "--no-focus",
        ],
      ],
    );
  });

  it("splits a narrow pane down", () => {
    process.env.FAKE_WIDTH = "80";
    createSurface("scout");
    assert.equal(calls()[2].args[5], "down");
  });

  it("targets an explicit pane and rejects unsupported directions before mutation", () => {
    createSurfaceSplit("scout", "down", "wOther:p3");
    assert.deepEqual(calls()[0].args.slice(0, 7), [
      "pane",
      "split",
      "--pane",
      "wOther:p3",
      "--direction",
      "down",
      "--cwd",
    ]);
    assert.throws(() => createSurfaceSplit("scout", "left"), /does not support left/);
    assert.throws(() => createSurfaceSplit("scout", "up"), /does not support up/);
    assert.equal(calls().length, 1);
  });

  it("does not guess a target or direction when caller geometry is invalid", () => {
    process.env.FAKE_WIDTH = "NaN";
    assert.throws(() => createSurface("scout"), /valid dimensions/);
    assert.equal(calls().length, 2);
  });

  it("validates JSON and pane IDs instead of accepting terminal IDs", () => {
    for (const response of [
      "bad json",
      "{}",
      '{"error":{"code":"failed"}}',
      '{"result":{"pane":{"terminal_id":"term_1"}}}',
    ]) {
      process.env.FAKE_RESPONSE = response;
      assert.throws(() => createSurfaceSplit("scout", "right"), /Herdr returned/);
    }
  });

  it("submits literal text and Enter with one command, even for flag-like text", () => {
    const command = "--literal 'quoted' $value; echo hello\nworld";
    sendCommand("wNew:p2", command);
    assert.deepEqual(calls()[0].args, ["pane", "run", "wNew:p2", command]);
    assert.equal(calls().length, 1);
  });

  it("keeps existing Herdr handles on Herdr when tmux becomes the preferred backend", () => {
    process.env.TMUX = "/fake/socket,1,0";
    process.env.TMUX_PANE = "%1";
    sendCommand("wNew:p2", "hello");
    closeSurface("wNew:p2");
    assert.deepEqual(
      calls().map((call) => call.binary),
      ["herdr", "herdr"],
    );
    assert.deepEqual(calls()[1].args, ["pane", "close", "wNew:p2"]);
  });

  it("returns raw unwrapped text from synchronous and asynchronous reads", async () => {
    const expected = "literal $text\n__SUBAGENT_DONE_7__\n";
    assert.equal(readScreen("wNew:p2", 0), expected);
    assert.equal(await readScreenAsync("wNew:p2", 9), expected);
    assert.deepEqual(calls()[0].args, [
      "pane",
      "read",
      "wNew:p2",
      "--source",
      "recent-unwrapped",
      "--lines",
      "1",
      "--format",
      "text",
    ]);
    assert.equal(calls()[1].args[6], "9");
  });

  it("preserves server error codes and does not retry command delivery", async () => {
    process.env.FAKE_FAIL_ACTION = "run";
    assert.throws(() => sendCommand("wNew:p2", "hello"), /pane_not_found/);
    assert.equal(calls().length, 1);
    process.env.FAKE_FAIL_ACTION = "read";
    await assert.rejects(readScreenAsync("wNew:p2"), /pane_not_found/);
  });

  it("preserves launch scripts and uses the same atomic submission", () => {
    const path = join(dir, "scripts", "launch with quotes'.sh");
    assert.equal(
      sendLongCommand("wNew:p2", "echo '$task'", { scriptPath: path, scriptPreamble: "# test" }),
      path,
    );
    assert.equal(readFileSync(path, "utf8"), "#!/bin/bash\n# test\necho '$task'\n");
    assert.equal(calls().length, 1);
    assert.ok(calls()[0].args[3].startsWith("bash '"));
    assert.ok(calls()[0].args[3].includes("'\\''"));
  });
});

describe("shared completion polling", () => {
  it("detects an exit code from Herdr's unwrapped screen", async () => {
    assert.deepEqual(await pollForExit("wNew:p2", new AbortController().signal, { interval: 1 }), {
      reason: "sentinel",
      exitCode: 7,
    });
  });

  it("checks error sidecars and Claude sentinels before reading the pane", async () => {
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      `${sessionFile}.exit`,
      JSON.stringify({ type: "error", errorMessage: "Provider failed" }),
    );
    assert.deepEqual(
      await pollForExit("wNew:p2", new AbortController().signal, { interval: 1, sessionFile }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Provider failed",
      },
    );
    assert.equal(existsSync(`${sessionFile}.exit`), false);
    const sentinelFile = join(dir, "claude.done");
    writeFileSync(sentinelFile, "Done");
    assert.deepEqual(
      await pollForExit("wNew:p2", new AbortController().signal, { interval: 1, sentinelFile }),
      {
        reason: "sentinel",
        exitCode: 0,
      },
    );
    assert.deepEqual(calls(), []);
  });

  it("reports a closed pane instead of polling forever", async () => {
    process.env.FAKE_FAIL_ACTION = "read";
    await assert.rejects(
      pollForExit("wNew:p2", new AbortController().signal, { interval: 10_000 }),
      /pane_not_found/,
    );
    assert.equal(calls().length, 1);
  });

  it("supports cancellation after a transient screen-read failure", async () => {
    process.env.FAKE_FAIL_ACTION = "read";
    process.env.FAKE_FAIL_CODE = "connection_error";
    const abort = new AbortController();
    const pending = pollForExit("wNew:p2", abort.signal, {
      interval: 10_000,
      onTick: () => abort.abort(),
    });
    await assert.rejects(pending, /Aborted/);
    assert.equal(calls().length, 1);
  });
});

describe("subagent lifecycle over Herdr", () => {
  it("spawns, steers, delivers completion, and resumes with the same name", async () => {
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.FAKE_SCREEN = "__SUBAGENT_DONE_0__";
    const tools = new Map<string, any>();
    const events = new Map<string, Function>();
    const messages: any[] = [];
    subagentsExtension({
      on(name: string, handler: Function) {
        events.set(name, handler);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      sendMessage(message: any) {
        messages.push(message);
      },
    } as any);
    const parent = join(dir, "parent.jsonl");
    writeFileSync(
      parent,
      JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) + "\n",
    );
    const ctx = {
      hasUI: false,
      cwd: dir,
      sessionManager: {
        getSessionFile: () => parent,
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      },
    };
    const waitForResult = async (count: number) => {
      const deadline = Date.now() + 5000;
      while (messages.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(messages.length, count);
    };
    const assistantEntry = (text: string) =>
      JSON.stringify({
        type: "message",
        id: text,
        message: { role: "assistant", content: [{ type: "text", text }] },
      }) + "\n";
    events.get("session_start")!({}, ctx);
    try {
      const spawn = await tools
        .get("subagent")
        .execute(
          "test",
          { agent: "scout", name: "scout", task: "Read" },
          undefined,
          undefined,
          ctx,
        );
      assert.equal(spawn.details.status, "started");
      const child = spawn.details.sessionFile;
      writeFileSync(
        child,
        JSON.stringify({ type: "session", version: 3, id: "child", cwd: dir }) +
          "\n" +
          assistantEntry("First result"),
      );
      const steer = await tools
        .get("subagent_message")
        .execute(
          "test",
          { name: "scout", message: "Also\ncheck tests" },
          undefined,
          undefined,
          ctx,
        );
      assert.equal(steer.details.status, "steered");
      assert.deepEqual(
        calls()
          .filter((call) => call.args[1] === "run")
          .at(-1)?.args,
        ["pane", "run", "wNew:p2", "Also check tests"],
      );
      // Simulate a pane that disappears between completion and cleanup.
      process.env.FAKE_FAIL_ACTION = "close";
      await waitForResult(1);
      assert.ok(messages[0].content.includes("First result"));
      assert.equal(messages[0].details.exitCode, 0);
      delete process.env.FAKE_FAIL_ACTION;

      const resume = await tools
        .get("subagent_message")
        .execute("test", { name: "scout", message: "Continue" }, undefined, undefined, ctx);
      assert.equal(resume.details.status, "started");
      assert.equal(resume.details.sessionFile, child);
      appendFileSync(child, assistantEntry("Second result"));
      await waitForResult(2);
      assert.ok(messages[1].content.includes("Second result"));
      assert.equal(messages[1].details.name, "scout");
      assert.equal(calls().filter((call) => call.args[1] === "close").length, 2);
      const resumeScript = readFileSync(resume.details.launchScriptFile, "utf8");
      assert.ok(resumeScript.includes("PI_SUBAGENT_AUTO_EXIT=1"));
      assert.ok(!resumeScript.includes("--no-extensions"));
      assert.ok(resumeScript.includes("PI_SUBAGENT_SPAWNING=0"));
      assert.ok(resumeScript.includes("--tools"));
    } finally {
      events.get("session_shutdown")!({}, ctx);
    }
  });

  it("closes panes on session shutdown", async () => {
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.FAKE_SCREEN = "Still working";
    const tools = new Map<string, any>();
    const events = new Map<string, Function>();
    subagentsExtension({
      on(name: string, handler: Function) {
        events.set(name, handler);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
    } as any);
    const parent = join(dir, "parent.jsonl");
    writeFileSync(
      parent,
      JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) + "\n",
    );
    const ctx = {
      hasUI: false,
      cwd: dir,
      sessionManager: {
        getSessionFile: () => parent,
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      },
    };
    events.get("session_start")!({}, ctx);
    try {
      await tools
        .get("subagent")
        .execute(
          "test",
          { agent: "scout", name: "scout", task: "Read" },
          undefined,
          undefined,
          ctx,
        );
    } finally {
      events.get("session_shutdown")!({}, ctx);
    }
    const deadline = Date.now() + 5000;
    while (!calls().some((call) => call.args[1] === "close") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(calls().filter((call) => call.args[1] === "close").length, 1);
  });
});

describe("failed launches", () => {
  it("closes newly created Herdr panes when spawn or resume delivery fails", async () => {
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.FAKE_FAIL_ACTION = "run";
    const tools = new Map<string, any>();
    subagentsExtension({
      on() {},
      registerCommand() {},
      registerMessageRenderer() {},
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
    } as any);
    const sessionFile = join(dir, "parent.jsonl");
    writeFileSync(
      sessionFile,
      JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) + "\n",
    );
    const ctx = {
      cwd: dir,
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      },
    };
    await assert.rejects(
      tools
        .get("subagent")
        .execute(
          "test",
          { agent: "scout", name: "scout", task: "Read" },
          undefined,
          undefined,
          ctx,
        ),
      /pane_not_found/,
    );
    assert.deepEqual(calls().at(-1)?.args, ["pane", "close", "wNew:p2"]);

    const child = join(dir, "child.jsonl");
    writeFileSync(
      child,
      JSON.stringify({ type: "session", version: 3, id: "child", cwd: dir }) + "\n",
    );
    registerName(join(dir, "artifacts", "parent"), "scout", {
      sessionFile: child,
      sessionId: "child",
    });
    writeSubagentLoadout(child, {
      agent: "scout",
      toolAllowlist: "read,ask_question",
      model: null,
      thinking: null,
      systemPromptMode: null,
      identity: null,
      spawnable: null,
      autoExit: true,
      cwd: dir,
      agentDir: dir,
    });
    await assert.rejects(
      tools
        .get("subagent_message")
        .execute("test", { name: "scout", message: "Continue" }, undefined, undefined, ctx),
      /pane_not_found/,
    );
    assert.deepEqual(calls().at(-1)?.args, ["pane", "close", "wNew:p2"]);
    assert.equal(calls().filter((call) => call.args[1] === "close").length, 2);
  });
});
