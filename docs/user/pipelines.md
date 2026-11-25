# Pipelines and roles

Pipelines let a Project Manager (PM) run work through fixed stages, such as spec, plan, build,
checks, QA, review and security. Each stage's workers run in a **role**, and the role picks the
model. Small jobs go to small, cheap models. Planning, hard bugs and checking security findings go
to frontier models. Every tier lists models from several vendors, so when one account hits its
usage limit, new workers move to another account or vendor instead of waiting.

Nothing changes until a PM uses it: `pm_worker_start` without a `role` behaves exactly as before.

## What the PM gets

| Tool                                                            | What it does                                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pm_worker_start({ ..., role, escalate?, avoid_provider_of? })` | Picks the worker's model from the role, adds the role's instructions above the brief, and says in its result which model ran and why. |
| `pm_roles`                                                      | Every role, its tier, and the model it would get right now, plus any accounts at their limit.                                         |
| `pm_worker_schedule({ ..., schedule })`                         | Same fields as `pm_worker_start`, plus when to run. Each run, the PM starts the worker.                                               |
| `pm_pipelines({ name? })`                                       | The pipelines, one line each; or one pipeline as a numbered checklist with its rules.                                                 |

The PM playbook (version 6) tells the PM to give every worker a role, pick a pipeline for anything
bigger than a quick fix, make one work item per stage, and move on from checks and reviews only by
the verdict the worker wrote (PASS/FAIL, APPROVE/CHANGES REQUESTED), not by its summary.

## Scheduled workers

Ask a PM to run a worker later or on a repeat, such as "run a security audit every night at 3" or
"retry this build when my Claude limit resets". The PM calls `pm_worker_schedule` with the worker's
brief and role plus a schedule: once at a time, every so many minutes (at least one), daily or on
chosen weekdays at a time, or when a webhook URL is called.

Each run posts a message in the PM's thread, and the PM starts the worker then. The worker reports
back like any other, and its role picks the model at that moment, so a run skips accounts that are
at their limit. Schedules show in **Settings → Scheduled tasks** as "Worker: <title>", where you
can pause or delete them; the PM can do the same.

## How a model is picked

1. **Tier.** The role's tier (`small`, `mid` or `frontier`), plus `escalate` tiers, up to the
   role's `maxTier`. The playbook asks for `escalate: 1` after two failed attempts on one card.
2. **Candidates.** The role's own `candidates`, if it has any, then the tier's list. Each candidate
   names a provider (`claude`, `codex`, `antigravity`, or a specific account id such as
   `claude-work`) and model words (`opus`, `sol`, `gpt 6.1 sol`). The newest installed model whose
   id or name has all the words wins, so `opus` follows Anthropic's releases by itself.
3. **Accounts.** A candidate is skipped when its account is off, not installed, signed out, or
   has a worker of this PM stopped at a usage limit that has not reset yet. A candidate that names a
   vendor tries every account of that vendor, so a second Claude account is used before Codex.
4. **Fallback.** With nothing left in the tier, the router tries higher tiers (up to `maxTier`),
   then lower ones, and the result says so.
5. **Independent review.** `avoid_provider_of` lists threads whose vendor to avoid, such as the
   builder a reviewer checks. The router takes another vendor in the same tier when there is one.
   With only one vendor available, the reviewer runs as a fresh session on the same vendor, and the
   result says so. It never drops a tier just to switch vendor.
6. **Effort.** The candidate's `effort` (or the role's) maps onto each provider's own control
   (`effort` for Claude, `reasoningEffort` for Codex, and so on), using the nearest level the model
   offers.

Default tiers (November 2026):

| Tier     | Effort | Claude | Codex         | Antigravity       | Order tried            |
| -------- | ------ | ------ | ------------- | ----------------- | ---------------------- |
| small    | medium | Haiku  | GPT-6.1 Terra | Gemini 4 Hydrogen | Haiku, Hydrogen, Terra |
| mid      | high   | Sonnet | GPT Sol       | Gemini 4 Neon     | Sonnet, Sol, Neon      |
| frontier | high   | Opus   | GPT Astra     | Gemini 4 Carbon   | Opus, Astra, Carbon    |

Roles marked `multimodal` (`ui-builder`, `qa`) try Neon and Terra first within a tier, because
those vendors lead with image understanding.

## Built-in roles

| Role               | Tier              | Access                | Job                                            |
| ------------------ | ----------------- | --------------------- | ---------------------------------------------- |
| triage             | small (up to mid) | read-only             | Size a request and pick a pipeline.            |
| product            | mid               | read-only             | Spec, acceptance criteria and `features.json`. |
| researcher         | small (up to mid) | read-only             | Answer one question with citations.            |
| architect          | frontier          | read-only             | Plan, task cards and threat model.             |
| plan-reviewer      | frontier          | read-only             | Challenge the plan before code.                |
| builder            | mid               | write                 | Implement one task card with tests.            |
| ui-builder         | mid, multimodal   | write                 | Build UI and check it in a browser.            |
| gatekeeper         | small only        | read-only             | Run check commands, report exit codes.         |
| qa                 | mid, multimodal   | write (only `passes`) | Test features end to end.                      |
| reviewer           | mid               | read-only             | Review a diff against spec and plan.           |
| security-scout     | small             | read-only             | Choose which security reviewers a diff needs.  |
| security-reviewer  | mid               | read-only             | Hunt one vulnerability class.                  |
| security-validator | frontier          | read-only             | Re-prove or reject every finding.              |
| writer             | small             | write                 | PR description and doc fixes.                  |

`read-only` is an instruction in the brief, not a sandbox: the PM still chooses the runtime mode.

## Built-in pipelines

| Pipeline       | Stages                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| feature        | spec → research → plan → plan-review → build → gates → qa → review → security-scope → security-review → security-validate → docs |
| bugfix         | reproduce → fix → gates → review → security (only if the fix touches auth, input handling, data access or dependencies)          |
| quick-fix      | build → gates → review                                                                                                           |
| research-spike | questions → research (parallel) → synthesis                                                                                      |
| refactor       | plan → build (one worker per shard) → gates → review                                                                             |
| ui             | spec → build → gates → qa → review                                                                                               |
| security-audit | shard → security-review (per shard) → security-validate                                                                          |
| code-review    | review-a → review-b (other vendor) → security                                                                                    |

A run keeps its files (spec, plan, task cards, findings, verdicts) in `.pipelines/runs/<name>/`
under the project root. Add `.pipelines/runs/` to `.gitignore`.

## Customizing a project

Put files in a `.pipelines` folder at the project root. Each file replaces the built-in of the same
name; everything else stays built-in. A file that does not parse or does not match is ignored, and
`pm_roles` and `pm_pipelines` list it, so a typo never stops a PM.

`.pipelines/tiers.yaml` replaces whole tiers. Here only Claude is used for the mid tier, a second
Claude account first:

```yaml
mid:
  - { provider: claude-work, model: sonnet, effort: high }
  - { provider: claude, model: sonnet, effort: high }
```

`.pipelines/roles/builder.yaml` (the file name is the role name):

```yaml
description: Implements one task card with tests.
tier: mid
maxTier: frontier
access: write
candidates:
  - { provider: codex, model: sol, effort: high } # try Codex first for builds
instructions: |
  Implement exactly the task card in the brief. Run `pnpm test` before committing.
```

`.pipelines/pipelines/feature.yaml`, with this project's real check commands:

```yaml
description: Our feature path.
when: Any new feature.
escalateAfter: 2
replanAfter: 3
stages:
  - {
      id: spec,
      role: product,
      goal: Write the spec.,
      produces: [spec.md, features.json],
      approval: true,
    }
  - {
      id: plan,
      role: architect,
      goal: Plan and split into cards.,
      produces: [plan.md, tasks/, threat-model.md],
    }
  - {
      id: build,
      role: builder,
      goal: Build each card.,
      foreach: each-task,
      parallel: 3,
      workspace: worktree,
    }
  - id: gates
    goal: Run the checks.
    run: [pnpm fmt --check, pnpm lint, pnpm typecheck, pnpm test, gitleaks detect --no-banner]
    onFail: build
  - {
      id: review,
      role: reviewer,
      goal: Review each diff.,
      differentProviderFrom: build,
      onFail: build,
    }
```

Stage fields: `id`, `role`, `goal`, `reads`, `produces`, `run`, `foreach: each-task`, `parallel`,
`workspace` (`shared` or `worktree`), `differentProviderFrom`, `approval`, `skipWhen`, `onFail`.
Role fields: `name`, `description`, `tier`, `maxTier`, `access`, `multimodal`, `candidates`,
`effort`, `instructions`.

## Limits of this first version

- **The PM drives the stages.** Ordering, loops and approvals are rules in the playbook and the
  checklist, followed by the PM model, not enforced by the server.
- **Checks run through a small-model worker.** The `gatekeeper` role runs the commands and copies
  exit codes into `gates.json`; a server-side command runner would make this fully deterministic.
- **Usage limits are seen through this PM's workers.** An account counts as limited once one of
  the PM's workers stopped on its limit. Limits hit elsewhere are not seen until then.
- **No UI yet.** Roles and pipelines are files and tool output; there is no editor or board.
