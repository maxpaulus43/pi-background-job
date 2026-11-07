# pi-background-job

Run shell tasks or delegate work to Pi agents while continuing your conversation. Watch live progress in `/jobs`; when a job exits, Pi receives its result and automatically follows up.

## Try it

```sh
pi -e ./index.ts
```

Or install this directory with `pi install /absolute/path/to/pi-background-job`, then reload Pi.

Ask Pi:

> Watch PR #123's CI. When it finishes, summarize any failures.

Pi can start `gh pr checks 123 --watch` with the `background` tool. The command handles polling; the extension listens for output and exit. Shell jobs use no model calls unless the command itself invokes a model. Agent jobs and completion/check-in follow-ups use normal, billable model calls. When Pi is busy, the result queues as a follow-up rather than interrupting.

## Shell tasks and agents

Start a shell task:

```json
{"action":"start","command":"npm test","title":"Tests"}
```

Or delegate a self-contained task to a separate Pi process:

```json
{
  "action":"start",
  "prompt":"Inspect contracts for validation bugs. Do not edit files. Report paths and line numbers.",
  "model":"baseten/deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast",
  "title":"Contracts review"
}
```

Supply exactly one of `command` or `prompt`. `model` is optional, only valid with `prompt`, and defaults to the parent session's current model (or Pi's configured default if none is active). Use `provider/model-id` to choose a provider explicitly.

Agents run `pi --mode json --no-session --no-mcp --tools read,bash,edit,write` from PATH, in the parent working directory. They load their own Pi configuration and project instructions, but **do not receive the parent conversation**. Include the scope, constraints, and required context in the prompt. Provider configuration must be available to the child Pi process.

The viewer shows streamed assistant text, tool starts/completions, retries, and errors. Completion delivers the final answer separately from the rolling progress buffer. A provider error fails the job even if Pi exits with code zero. Agents share filesystem permissions and may edit files; assign disjoint scopes when running them concurrently. This is not isolation or a sandbox. Child model usage is not added to the parent's token totals.

Use `status` or `stop` with the returned job ID for either kind of job. Completion is automatic: do not poll. For watches, let the command handle polling.

## Controls

- `/jobs` or **Ctrl+Shift+M** opens the live viewer.
- In fullscreen Pi, click the job widget to open it.
- **Left/right** switches jobs; **up/down** scrolls output. In fullscreen Pi, the mouse wheel also scrolls inside the viewer; regular terminal mode leaves the wheel to terminal scrollback.
- Check-in and completion messages collapse to one line. Use Pi's expand toggle (default **Ctrl+O**) to expand or collapse their full output. Collapsed messages show your configured shortcut. In fullscreen Pi, click the message header to expand or collapse it.
- **s** stops a running job; **d** dismisses a finished job; **Escape** closes the viewer.
- The widget hides when no jobs are running. Finished jobs stay in `/jobs` until dismissed. Dismissing the last job closes the viewer; messages already delivered to the conversation remain.

The model-facing `background` tool accepts `action: "start" | "status" | "stop"`, plus `command` or `prompt`, optional `model` and `title`, or a job `id`. Status without an ID lists jobs. Cancellation does not trigger an automatic follow-up.

For a long-running job, the model can request a one-time check-in at creation:

```json
{
  "action": "start",
  "command": "gh pr checks 123 --watch",
  "checkAfterSeconds": 300
}
```

After five minutes, if the job is still running, Pi queues its current output for the assistant to review. This does not stop or restart the command. The check-in is one-time, not recurring; omit the parameter at creation for completion-only notifications. The delay must be a whole number from 1 to 2,147,483 seconds. Completion, cancellation, and session shutdown clear pending reminders. A reminder already queued behind a busy conversation may be read after the job finishes.

To inspect an existing job and schedule its next check-in without restarting it:

```json
{
  "action": "status",
  "id": "1",
  "checkAfterSeconds": 300
}
```

The delay starts from this call and replaces any pending reminder for that job. After each check-in, the assistant can choose whether and when to schedule another. Status without `checkAfterSeconds` leaves the pending reminder unchanged. Scheduling requires a job ID; finished or stopping jobs return their status without scheduling a reminder. Already-delivered reminders cannot be withdrawn.

## Scope

- macOS/Linux, tested against Pi 1.5.0.
- Jobs belong to the current session. Quit, reload, or session replacement stops them; jobs are not restored on resume.
- Commands run through `/bin/bash -c` in the session working directory, inherit your environment and permissions, and have no interactive stdin.
- Progress output is limited to the last 32,768 characters per job. Earlier output is discarded. Agent final answers are stored separately, limited to their first 32,768 characters with an explicit truncation notice. Terminal control sequences are removed before display or model delivery. JSON records over 8,388,608 characters fail agent-stream validation.
- Cancellation sends TERM to the process group, then KILL after 500 ms. Commands that deliberately daemonize into another process group are not supported. A forced Pi crash cannot run cleanup.
- This is not a sandbox. Only run commands you trust. Command output enters the conversation; avoid commands that print secrets. CI commands require your existing `gh` authentication.
- Keep Pi open for automatic follow-ups. Headless one-shot invocations are not a persistent job service.

## Releases

This package uses the same changelogger hook and GitHub Actions publishing workflow as `pi-cline` and `pi-linear`.

After cloning, install dependencies and the local hook:

```sh
npm install
npx --no-install changelogger install
```

The pre-commit hook generates and stages a changelog entry when the staged package version changes. It uses local LM Studio when available and falls back to commit subjects.

The `Publish` workflow runs on pushes to `main` or manual dispatch. If the local version differs from npm, it publishes `@maxpaulus/pi-background-job`, creates a version tag, and creates a GitHub release using `CHANGELOG.md`.

Before the first release, create/connect `maxpaulus43/pi-background-job` on GitHub and configure the npm package's trusted publisher for that repository and `publish.yml`. Repository metadata alone does not create a Git remote or configure npm authentication. The workflow uses OIDC, not an `NPM_TOKEN` secret.

For subsequent releases:

```sh
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "Release next version"
git push origin main
```

The commit hook stages the changelog; the workflow creates the tag after publishing. Pushing an unpublished version to `main` publishes it automatically.

## Tests

```sh
npm test
```

To include the extension integration test against an installed Pi:

```sh
PI_JOB_HOST="$(npm root -g)/@earendil-works/pi-coding-agent" npm test
```

Tests cover background completion, errors, bounded output, terminal sanitization, process-group cancellation, shutdown isolation, tool registration, viewer rendering, automatic follow-up options, and agent streaming/final-answer handling with a fake Pi executable (no model calls). No additional runtime dependencies are needed beyond Pi.
