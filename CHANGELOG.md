# Changelog

## 1.0.3 - 2026-10-30
- wrap text in job window
- wrap text in job window
## 1.0.2 - 2026-10-30
- fix provenance
## 1.0.1 - 2026-10-23
- Support scheduling check-ins on existing jobs via `status` action with `checkAfterSeconds`
- Replace pending reminders when scheduling a new check-in without restarting the command
- Require job `id` to schedule a check-in on an existing job
- Prevent scheduling check-ins for finished, stopping, or missing jobs
- Validate `checkAfterSeconds` as an integer between 1 and 2,147,483
- Update tool description to document the new rescheduling capability
## 1.0.0

- Run session-scoped background commands with automatic completion follow-ups and optional scheduled check-ins.
- View live output, stop running jobs, and dismiss finished jobs in the job overlay.
- Expand job messages with the configured shortcut or fullscreen mouse clicks.
- Scroll output with arrow keys or the fullscreen mouse wheel, with a visible scroll indicator.
