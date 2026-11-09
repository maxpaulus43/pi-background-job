import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { AgentStream, agentArgs } from "./agent.ts";
import { Jobs, describe } from "./jobs.ts";

const message = (text, stopReason = "stop", errorMessage) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage },
});
const settled = { type: "agent_settled", aborted: false };
const feed = (stream, ...events) => stream.push(events.map(JSON.stringify).join("\n") + "\n");

test("agent arguments preserve prompts and model IDs as literal arguments", () => {
  const prompt = "@secret --help ' $(touch nope)\nsecond line";
  const args = agentArgs(prompt, "baseten/deepseek-ai/model");
  assert.deepEqual(args.slice(-4), ["--model", "baseten/deepseek-ai/model", "--", `Task: ${prompt}`]);
  assert.ok(args.includes("--no-session"));
  assert.ok(args.includes("--no-mcp"));
  assert.throws(() => agentArgs(" "), /empty/);
  assert.throws(() => agentArgs("review", " "), /empty/);
});

test("streams fragmented JSONL, tools and text; retains the authoritative answer separately", () => {
  let output = "";
  const stream = new AgentStream((text) => { output += text; });
  const events = [
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Reading…\u2028next" } },
    { type: "tool_execution_start", toolName: "read", args: { path: "README.md" } },
    { type: "tool_execution_end", toolName: "read", isError: false },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "not displayed" } },
    message("Final answer"), settled,
  ];
  const wire = events.map(JSON.stringify).join("\r\n");
  for (let i = 0; i < wire.length; i += 7) stream.push(wire.slice(i, i + 7));
  stream.finish();
  assert.match(output, /Reading…\u2028next/);
  assert.match(output, /\[tool\] read.*README.md/);
  assert.match(output, /\[done\] read/);
  assert.doesNotMatch(output, /not displayed/);
  assert.equal(stream.answer, "Final answer");
  assert.equal(stream.error, undefined);
});

test("provider errors, aborts and incomplete streams do not look successful", () => {
  for (const reason of ["error", "aborted"]) {
    const stream = new AgentStream(() => {});
    feed(stream, message("", reason, "Provider unavailable"), settled);
    stream.finish();
    assert.equal(stream.error, "Provider unavailable");
  }
  const aborted = new AgentStream(() => {});
  feed(aborted, { ...settled, aborted: true });
  aborted.finish();
  assert.match(aborted.error, /aborted/);
  const incomplete = new AgentStream(() => {});
  feed(incomplete, message("Partial answer"));
  incomplete.finish();
  assert.match(incomplete.error, /before agent_settled/);
});

test("successful retries clear transient errors and replace stale answers", () => {
  const stream = new AgentStream(() => {});
  feed(stream, message("old", "error", "retry me"), { type: "auto_retry_start", errorMessage: "retry me" },
    { type: "agent_start" }, message("recovered"), settled);
  stream.finish();
  assert.equal(stream.error, undefined);
  assert.equal(stream.answer, "recovered");
});

test("malformed and oversized records are bounded and reported, not thrown", () => {
  for (const bad of ["not json\n", "null\n", '{"type":"message_end","message":{"role":"assistant"}}\n', "x".repeat(8 * 1024 * 1024 + 1) + "\n"]) {
    const stream = new AgentStream(() => {});
    stream.push(bad);
    feed(stream, message("later"), settled);
    stream.finish();
    assert.ok(stream.error);
    assert.equal(stream.answer, "later");
  }
});

test("agent cost sums reported usage across assistant messages", () => {
  const priced = (text, total) => ({
    ...message(text),
    message: { ...message(text).message, usage: { cost: { total } } },
  });
  const stream = new AgentStream(() => {});
  feed(stream, priced("first", 0.0021), { type: "tool_execution_start", toolName: "read", args: {} },
    priced("second", 0.0004), settled);
  stream.finish();
  assert.equal(stream.cost.toFixed(4), "0.0025");
});

test("final answer has its own cap, independent of progress", () => {
  const stream = new AgentStream(() => {});
  feed(stream, message("a".repeat(40000)), settled);
  stream.finish();
  assert.equal(stream.answer.length, 32768);
  assert.equal(stream.answerTruncated, true);
});

test("agent jobs spawn Pi, stream before exit, preserve results and cancel their process group", { timeout: 10000 }, async () => {
  const tmp = join(process.cwd(), "tmp");
  await mkdir(tmp, { recursive: true });
  const dir = await mkdtemp(join(tmp, "agent-test-"));
  const oldPath = process.env.PATH;
  const finished = [];
  const jobs = new Jobs((job) => finished.push(describe(job, true)));
  try {
    const script = `#!${process.execPath}
const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const args = process.argv.slice(2);
send({type:"agent_start"});
send({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"live progress"}});
console.error("stderr diagnostic");
if (args.includes("wait")) setInterval(() => {}, 1000);
else setTimeout(() => {
  send(${JSON.stringify(message("saved answer"))});
  send({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"x".repeat(40000)}});
  if (args.includes("fail")) send(${JSON.stringify(message("", "error", "Provider failed"))});
  if (args.includes("echo")) send({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify(args)}],stopReason:"stop"}});
  send(${JSON.stringify(settled)});
}, 150);
`;
    await writeFile(join(dir, "pi"), script, { mode: 0o700 });
    process.env.PATH = `${dir}:${oldPath}`;
    const job = jobs.start({ prompt: "inspect" }, process.cwd());
    while (!job.output.includes("live progress")) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(job.status, "running");
    assert.match(job.output, /live progress/);
    await job.done;
    assert.equal(job.status, "completed");
    assert.equal(job.output.length, 32768);
    assert.equal(job.truncated, true);
    assert.match(finished[0], /saved answer/);
    assert.doesNotMatch(finished[0], /xxxx/);
    const prompt = "@secret; $(touch nope)\n'quoted'";
    const echo = jobs.start({ prompt, model: "echo" }, process.cwd());
    await echo.done;
    assert.deepEqual(JSON.parse(echo.agent.answer), agentArgs(prompt, "echo"));
    const failed = jobs.start({ prompt: "inspect", model: "fail" }, process.cwd());
    await failed.done;
    assert.equal(failed.code, 0);
    assert.equal(failed.status, "failed");
    assert.match(describe(failed, true), /Provider failed/);
    const waiting = jobs.start({ prompt: "inspect", model: "wait" }, process.cwd());
    while (!waiting.output.includes("live progress")) await new Promise((resolve) => setTimeout(resolve, 5));
    await jobs.stop(waiting.id);
    await waiting.done;
    assert.equal(waiting.status, "cancelled");
    assert.throws(() => process.kill(-waiting.child.pid, 0), { code: "ESRCH" });
  } finally {
    await jobs.close();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
    await rmdir(tmp).catch((error) => { if (error.code !== "ENOTEMPTY") throw error; });
  }
});
