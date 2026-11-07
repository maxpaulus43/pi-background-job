import { spawn, type ChildProcess } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { AgentStream, agentArgs } from "./agent.ts";

const OUTPUT_LIMIT = 32 * 1024;

interface Job {
  id: string;
  command: string;
  agent?: AgentStream;
  cwd: string;
  title: string;
  status: "running" | "cancelled" | "completed" | "failed";
  output: string;
  truncated: boolean;
  started: number;
  child?: ChildProcess;
  done?: Promise<void>;
  stopping?: Promise<void>;
  checkTimer?: ReturnType<typeof setTimeout>;
  error?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  ended?: number;
}

export function clean(text: string) {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function validateCheckDelay(seconds: number) {
  // Node timers overflow above 2^31 - 1 milliseconds.
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 2147483) {
    throw new Error("checkAfterSeconds must be an integer between 1 and 2147483");
  }
}

export class Jobs {
  jobs = new Map<string, Job>();
  onFinish: (job: Job) => void;
  onCheck: (job: Job) => void;
  nextId = 1;
  closed = false;

  constructor(onFinish: (job: Job) => void = () => {}, onCheck: (job: Job) => void = () => {}) {
    this.onFinish = onFinish;
    this.onCheck = onCheck;
  }

  start(task: string | { prompt: string; model?: string }, cwd: string, title?: string, checkAfterSeconds?: number) {
    if (this.closed) throw new Error("Monitor session is closed");
    if (process.platform === "win32") throw new Error("Monitor requires macOS or Linux");
    const isAgent = typeof task !== "string";
    const args = isAgent ? agentArgs(task.prompt, task.model) : ["-c", task];
    const command = isAgent ? `pi agent${task.model ? ` (${task.model})` : ""}: ${task.prompt}` : task;
    if (!command.trim()) throw new Error("Command must not be empty");
    if (checkAfterSeconds !== undefined) validateCheckDelay(checkAfterSeconds);
    const job: Job = {
      id: String(this.nextId++), command, cwd, title: title ?? (isAgent ? task.prompt.slice(0, 80) : command),
      status: "running", output: "", truncated: false, started: Date.now(),
    };
    const child = spawn(isAgent ? "pi" : "/bin/bash", args, {
      cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    job.child = child;
    this.jobs.set(job.id, job);
    const append = (chunk: string) => {
      job.output += chunk;
      if (job.output.length > OUTPUT_LIMIT) {
        job.output = job.output.slice(-OUTPUT_LIMIT);
        job.truncated = true;
      }
    };
    if (isAgent) job.agent = new AgentStream(append);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => job.agent ? job.agent.push(chunk) : append(chunk));
    child.stderr.on("data", append);
    child.on("error", (error) => { job.error = error.message; });
    job.done = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        clearTimeout(job.checkTimer);
        job.code = code;
        job.signal = signal;
        job.ended = Date.now();
        job.agent?.finish();
        job.error ??= job.agent?.error;
        job.status = job.stopping ? "cancelled" : code === 0 && !job.error ? "completed" : "failed";
        if (!this.closed) this.onFinish(job);
        resolve();
      });
    });
    if (checkAfterSeconds !== undefined) this.scheduleCheck(job.id, checkAfterSeconds);
    return job;
  }

  scheduleCheck(id: string, seconds: number) {
    if (this.closed) throw new Error("Monitor session is closed");
    validateCheckDelay(seconds);
    const job = this.get(id);
    clearTimeout(job.checkTimer);
    if (job.status !== "running" || job.stopping) return false;
    job.checkTimer = setTimeout(() => {
      if (!this.closed && job.status === "running" && !job.stopping) this.onCheck(job);
    }, seconds * 1000);
    return true;
  }

  get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown monitor: ${id}`);
    return job;
  }

  stop(id: string) {
    const job = this.get(id);
    clearTimeout(job.checkTimer);
    if (job.stopping) return job.stopping;
    if (job.status !== "running") return Promise.resolve();
    const kill = (signal: NodeJS.Signals) => {
      if (!job.child?.pid) return;
      try { process.kill(-job.child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    // Kill the group even if the shell exits before its children do.
    job.stopping = new Promise((resolve, reject) => {
      setTimeout(() => {
        try { kill("SIGKILL"); resolve(); } catch (error) { reject(error); }
      }, 500);
    });
    kill("SIGTERM");
    return job.stopping;
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.jobs.values()].map(async (job) => {
      await this.stop(job.id);
      await job.done;
    }));
  }
}

export function describe(job: Job, resultOnly = false) {
  const final = resultOnly && job.agent && job.status !== "running";
  return clean([
    `Monitor ${job.id}: ${job.title} — ${job.status}`,
    `Command: ${job.command}`, `Directory: ${job.cwd}`,
    `Exit code: ${job.code ?? "—"}${job.signal ? ` (${job.signal})` : ""}`,
    job.error ?? "",
    !final && job.truncated ? "[Earlier output discarded; showing last 32,768 characters]" : "",
    final ? job.agent!.answer || "(No final answer)" : job.output,
    final && job.agent!.answerTruncated ? "[Final answer truncated to first 32,768 characters]" : "",
    final && job.status === "failed" ? `Diagnostics:\n${job.output.slice(-4096)}` : "",
  ].filter(Boolean).join("\n"));
}
