# Agent Space Capabilities Manifest

This document summarizes every workflow mode, slash command, orchestration tool, and skill family available to agents in Agent Space. Smart Mode passes a live version of this manifest (enriched with all locally installed skills) to the active agent so it can choose the right tools and ask before spending extra tokens on high-stakes verification.

## Modes & Slash Commands

- `/swarm` (**Swarm Mode**, high token cost): Coordinate parallel worker agents on a shared Swarm board with role routing, isolated worktrees, warm `fork`, stall monitor, and live failover. Supports `--pipeline <name>` and `--scorched-earth`.
- `/scorched-earth` (**Scorched Earth**, very-high token cost): Exhaustive verification pipeline (`surface-inventory.json` -> deterministic gates -> `scenario-generator` -> `playtester` -> `troubleshooter`/`fixer` loop capped at 3 cycles).
- `/plan` (**Plan Mode**, standard token cost): Research first and produce a concrete, step-by-step plan before editing code.
- `/goal` (**Goal Mode**, high token cost): Autonomous execution loop that keeps verifying and fixing until all acceptance criteria pass.
- `/boost` (**Boost Mode**, high token cost): Deep reasoning, multi-perspective design critique, edge-case analysis, and rigorous verification.
- `/grill-me` (**Grill Me**, standard token cost): Interactive interview to resolve ambiguities and lock in design decisions before coding.
- `/teamwork` (**Teamwork**, high token cost): Decompose a large request into parallel specialist workers via Swarm mode.
- `/learn` (**Learn**, standard token cost): Save a correction, setup, or reusable workflow as a persistent skill or rule.
- `/smart` (**Smart Mode**, standard token cost): Inspect the request against this manifest, attach relevant skills, and ask before spending extra tokens on Swarm or Scorched Earth.

## Orchestration, Verification & Skill Tools

- `swarm` (`title`, `status`, `models`, `pipeline`, `model`, `add`, `channel`, `kill`, `done`)
- `post_message`, `read_board`, `swarm_wait`
- `pm_ask`, `pm_pipelines`, `pm_roles`, `pm_run_gates`, `pm_verify_app`
- `t3_thread_read`

## Skill Discovery

Agent Space automatically discovers `SKILL.md` files from:

- Project: `.pipelines/skills`, `.agents/skills`, `.claude/skills`
- User: `~/.gemini/antigravity/skills`, `~/.gemini/config/skills`, `~/.gemini/skills`, `~/.agents/skills`, `~/.claude/skills`
- Installed Antigravity Plugins & Built-ins: `~/.gemini/config/plugins/*/skills/` (chemistry, genomics, structural-biology, scientific-literature, firebase, chrome-devtools, modern-web-guidance, gemini-api, android-cli, etc.) and `~/.gemini/antigravity/builtin/skills/`
