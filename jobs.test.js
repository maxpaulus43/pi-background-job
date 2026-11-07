import assert from "node:assert/strict";
import { test } from "node:test";
import { Jobs, clean, describe } from "./jobs.ts";

const cwd = process.cwd();

test("returns immediately, captures both streams, and notifies exactly once", async () => {
  const finished = [];
  const jobs = new Jobs((job) => finished.push(job.id));
  try {
    const job = jobs.start("sleep 0.1; printf hello; printf error >&2", cwd);
    assert.equal(job.status, "running");
    assert.deepEqual(finished, []);
    await job.done;
    assert.equal(job.status, "completed");
    assert.match(job.output, /hello/);
    assert.match(job.output, /error/);
    assert.deepEqual(finished, [job.id]);
  } finally { await jobs.close(); }
});

test("nonzero exit and spawn failure are reported", async () => {
  const jobs = new Jobs();
  try {
    const failed = jobs.start("exit 7", cwd);
    const missing = jobs.start("true", `${cwd}/nonexistent-directory`);
    await Promise.all([failed.done, missing.done]);
    assert.equal(failed.status, "failed");
    assert.equal(failed.code, 7);
    assert.equal(missing.status, "failed");
    assert.match(missing.error, /ENOENT/);
  } finally { await jobs.close(); }
});

test("bounds output and strips terminal controls", async () => {
  const jobs = new Jobs();
  try {
    const job = jobs.start(`"${process.execPath}" -e 'process.stdout.write("x".repeat(70000))'`, cwd);
    await job.done;
    assert.equal(job.output.length, 32768);
    assert.equal(job.truncated, true);
    assert.match(describe(job), /Earlier output discarded/);
    assert.equal(clean("\x1b[31mred\x1b[0m\x07\x1b]52;c;secret\x07"), "red");
  } finally { await jobs.close(); }
});

test("stop kills a TERM-resistant descendant and is idempotent", { timeout: 5000 }, async () => {
  const jobs = new Jobs();
  try {
    const job = jobs.start("bash -c 'trap \"\" TERM; echo ready; while :; do sleep 1; done' & wait", cwd);
    while (!job.output.includes("ready")) await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.all([jobs.stop(job.id), jobs.stop(job.id), job.done]);
    assert.equal(job.status, "cancelled");
    assert.throws(() => process.kill(-job.child.pid, 0), { code: "ESRCH" });
  } finally { await jobs.close(); }
});

test("shutdown suppresses completion delivery and rejects new jobs", async () => {
  const finished = [];
  const jobs = new Jobs((job) => finished.push(job.id));
  const job = jobs.start("sleep 30", cwd);
  await jobs.close();
  await jobs.close();
  assert.equal(job.status, "cancelled");
  assert.deepEqual(finished, []);
  assert.throws(() => jobs.start("true", cwd), /closed/);
});

test("scheduled check-in fires once while running; omitted delay stays silent", async (t) => {
  const checks = [];
  const jobs = new Jobs(undefined, (job) => checks.push(job.id));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const job = jobs.start("sleep 30", cwd, "long job", 10);
    jobs.start("sleep 30", cwd);
    t.mock.timers.tick(9999);
    assert.deepEqual(checks, []);
    t.mock.timers.tick(1);
    assert.deepEqual(checks, [job.id]);
    assert.equal(job.status, "running");
    t.mock.timers.tick(20000);
    assert.deepEqual(checks, [job.id]);
  } finally {
    t.mock.timers.reset();
    await jobs.close();
  }
});

test("check-ins can be replaced and rearmed without restarting the job", async (t) => {
  const checks = [];
  const jobs = new Jobs(undefined, (job) => checks.push(job.id));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const job = jobs.start("sleep 30", cwd, "long job", 10);
    const child = job.child;
    t.mock.timers.tick(5000);
    assert.equal(jobs.scheduleCheck(job.id, 20), true);
    t.mock.timers.tick(5000);
    assert.deepEqual(checks, []);
    t.mock.timers.tick(14999);
    assert.deepEqual(checks, []);
    t.mock.timers.tick(1);
    assert.deepEqual(checks, [job.id]);
    assert.equal(jobs.scheduleCheck(job.id, 5), true);
    t.mock.timers.tick(5000);
    assert.deepEqual(checks, [job.id, job.id]);
    t.mock.timers.tick(30000);
    assert.deepEqual(checks, [job.id, job.id]);
    assert.equal(jobs.jobs.size, 1);
    assert.equal(job.child, child);
  } finally {
    t.mock.timers.reset();
    await jobs.close();
  }
});

test("invalid rescheduling preserves reminders; finished jobs cannot be rearmed", async (t) => {
  const checks = [];
  const jobs = new Jobs(undefined, (job) => checks.push(job.id));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const job = jobs.start("sleep 30", cwd, "long job", 10);
    for (const seconds of [0, -1, 0.5, NaN, Infinity, 2147484]) {
      assert.throws(() => jobs.scheduleCheck(job.id, seconds), /checkAfterSeconds/);
    }
    assert.throws(() => jobs.scheduleCheck("missing", 10), /Unknown monitor/);
    t.mock.timers.tick(10000);
    assert.deepEqual(checks, [job.id]);
    const finished = jobs.start("true", cwd);
    await finished.done;
    assert.equal(jobs.scheduleCheck(finished.id, 10), false);
    t.mock.timers.tick(10000);
    assert.deepEqual(checks, [job.id]);
  } finally {
    t.mock.timers.reset();
    const job = [...jobs.jobs.values()][0];
    const stopping = jobs.stop(job.id);
    assert.equal(jobs.scheduleCheck(job.id, 10), false);
    await stopping;
    await jobs.close();
  }
  assert.throws(() => jobs.scheduleCheck("1", 10), /closed/);
});

test("completion, cancellation, and shutdown cancel pending check-ins", async (t) => {
  const checks = [];
  const jobs = new Jobs(undefined, (job) => checks.push(job.id));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const finished = jobs.start("true", cwd, "quick job", 10);
    await finished.done;
    t.mock.timers.tick(10000);
    assert.deepEqual(checks, []);
    const cancelled = jobs.start("sleep 30", cwd, "cancelled job", 10);
    const stopped = jobs.stop(cancelled.id);
    // Let TERM finish before the mocked clock jumps past the KILL grace period.
    await cancelled.done;
    t.mock.timers.tick(10000);
    await stopped;
    await cancelled.done;
    assert.deepEqual(checks, []);
    const shutdown = jobs.start("sleep 30", cwd, "shutdown job", 10);
    const closed = jobs.close();
    await shutdown.done;
    t.mock.timers.tick(10000);
    await closed;
    assert.deepEqual(checks, []);
  } finally {
    t.mock.timers.reset();
    await jobs.close();
  }
});

test("rejects invalid check-in delays before spawning", async () => {
  const jobs = new Jobs();
  for (const seconds of [0, -1, 0.5, NaN, Infinity, 2147484]) {
    assert.throws(() => jobs.start("true", cwd, "invalid", seconds), /checkAfterSeconds/);
  }
  assert.equal(jobs.jobs.size, 0);
  await jobs.close();
});

test("rejects empty commands and unknown ids", async () => {
  const jobs = new Jobs();
  assert.throws(() => jobs.start("  ", cwd), /empty/);
  assert.throws(() => jobs.get("missing"), /Unknown/);
  await jobs.close();
});
