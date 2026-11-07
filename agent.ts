import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

const RESULT_LIMIT = 32 * 1024;
const RECORD_LIMIT = 8 * 1024 * 1024;

export function agentArgs(prompt: string, model?: string) {
  if (!prompt.trim()) throw new Error("Prompt must not be empty");
  if (model !== undefined && !model.trim()) throw new Error("Model must not be empty");
  const args = ["--mode", "json", "--no-session", "--no-mcp", "--tools", "read,bash,edit,write"];
  if (model) args.push("--model", model);
  // Prefix prevents prompts beginning with @ or - from becoming CLI arguments.
  args.push("--", `Task: ${prompt}`);
  return args;
}

export class AgentStream {
  private buffer = "";
  private dropping = false;
  private protocolError?: string;
  private messageError?: string;
  private settled = false;
  answer = "";
  answerTruncated = false;

  private append: (text: string) => void;

  constructor(append: (text: string) => void) { this.append = append; }

  get error() { return this.protocolError ?? this.messageError; }

  push(chunk: string) {
    const lines = chunk.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!this.dropping) {
        this.buffer += lines[i];
        if (this.buffer.length > RECORD_LIMIT) {
          this.protocolError = "Agent JSON record exceeded 8,388,608 characters";
          this.buffer = "";
          this.dropping = true;
        }
      }
      if (i < lines.length - 1) {
        if (!this.dropping) this.line(this.buffer);
        this.buffer = "";
        this.dropping = false;
      }
    }
  }

  finish() {
    if (this.buffer.trim()) this.line(this.buffer);
    this.buffer = "";
    if (!this.settled && !this.error) this.protocolError = "Agent exited before agent_settled";
  }

  private line(line: string) {
    if (!line.trim()) return;
    try { this.event(JSON.parse(line)); }
    catch {
      this.protocolError = "Invalid JSON event in agent output";
      this.append(`\n[invalid JSON] ${line.slice(0, 500)}\n`);
      return;
    }
  }

  private event(event: JsonAgentSessionEvent) {
    if (!event || typeof event !== "object") {
      this.protocolError = "Invalid agent event";
      return;
    }
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent?.type === "text_delta") this.append(event.assistantMessageEvent.delta);
        break;
      case "message_end": {
        const message = event.message;
        if (message?.role !== "assistant") break;
        this.messageError = message.stopReason === "error" || message.stopReason === "aborted"
          ? message.errorMessage || `Agent ${message.stopReason}` : undefined;
        const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        this.answer = text.slice(0, RESULT_LIMIT);
        this.answerTruncated = text.length > RESULT_LIMIT;
        if (this.messageError) this.append(`\n[error] ${this.messageError}\n`);
        break;
      }
      case "tool_execution_start":
        this.append(`\n[tool] ${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 1000)}\n`);
        break;
      case "tool_execution_end":
        this.append(`\n[${event.isError ? "tool error" : "done"}] ${event.toolName}\n`);
        break;
      case "agent_start":
        this.settled = false;
        this.append("\n[agent started]\n");
        break;
      case "agent_settled":
        this.settled = true;
        if (event.aborted) this.messageError = "Agent aborted";
        this.append("\n[agent settled]\n");
        break;
      case "auto_retry_start":
        this.append(`\n[retry] ${event.errorMessage}\n`);
        break;
    }
  }
}
