import type {
  EnvironmentId,
  PmHarnessLearningCategory,
  PmWorkspacePipelinesSnapshot,
  ProjectId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { BookOpenCheckIcon, CheckIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toastManager } from "../components/ui/toast";
import { runPmCommand } from "./actions";
import { pmCommands, useHarnessLearnings } from "./state";

const SELECT_CLASS =
  "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground shadow-2xs transition focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground shadow-2xs transition focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";

export function StudioLearningsTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly snapshot: PmWorkspacePipelinesSnapshot | null;
  readonly onAppliedRoleChange: () => void;
}) {
  const gt = useGT();
  const learningsQuery = useHarnessLearnings(props.environmentId, props.projectId);
  const learnings = learningsQuery.data ?? [];

  const [roleName, setRoleName] = useState<string>("builder");
  const [category, setCategory] = useState<PmHarnessLearningCategory>("bug_pattern");
  const [title, setTitle] = useState<string>("");
  const [ruleText, setRuleText] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const roles = props.snapshot?.roles ?? [];
  const effectiveRole =
    roles.find((entry) => entry.role.name === roleName)?.role.name ??
    roles[0]?.role.name ??
    roleName;

  const handlePropose = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !title.trim() || !ruleText.trim()) return;
    setSaving(true);
    const created = await runPmCommand(
      pmCommands.learningPropose,
      {
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          roleName: effectiveRole,
          category,
          title: title.trim(),
          ruleText: ruleText.trim(),
        },
      },
      gt("Could not propose harness rule"),
    ).catch(() => null);
    setSaving(false);

    if (created !== null) {
      setTitle("");
      setRuleText("");
      learningsQuery.refresh();
    }
  };

  const handleApply = async (learningId: string, targetRole: string) => {
    if (saving) return;
    setSaving(true);
    const updated = await runPmCommand(
      pmCommands.learningApply,
      {
        environmentId: props.environmentId,
        input: { learningId },
      },
      gt("Could not apply learning to role"),
    ).catch(() => null);
    setSaving(false);
    if (updated !== null) {
      learningsQuery.refresh();
      props.onAppliedRoleChange();
      toastManager.add({
        type: "success",
        title: gt("Role harness upgraded"),
        description: gt("Appended rule to .pipelines/roles/{role}.yaml.", { role: targetRole }),
      });
    }
  };

  const handleDismiss = async (learningId: string) => {
    if (saving) return;
    setSaving(true);
    const updated = await runPmCommand(
      pmCommands.learningDismiss,
      {
        environmentId: props.environmentId,
        input: { learningId },
      },
      gt("Could not dismiss learning"),
    ).catch(() => null);
    setSaving(false);
    if (updated !== null) learningsQuery.refresh();
  };

  const pending = learnings.filter((item) => item.status === "proposed");
  const resolved = learnings.filter((item) => item.status !== "proposed");

  return (
    <div className="space-y-5">
      <form
        aria-labelledby="propose-learning-heading"
        onSubmit={(event) => void handlePropose(event)}
        className="space-y-3 rounded-xl border border-border bg-card p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <div>
            <div className="flex items-center gap-2">
              <BookOpenCheckIcon className="size-4 text-primary" aria-hidden />
              <h2 id="propose-learning-heading" className="text-sm font-semibold text-foreground">
                <T>Self-Improving Harnesses (Cross-Run Learnings)</T>
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <T>
                Reviewers and PMs automatically propose harness rules when runs hit recurring bugs
                via pm_learning_propose. Apply any proposal with 1 click to bake it into that
                role&apos;s permanent .pipelines/roles/*.yaml instructions.
              </T>
            </p>
          </div>
          <Button type="button" variant="ghost" size="xs" onClick={() => learningsQuery.refresh()}>
            <RefreshCwIcon className="size-3.5" aria-hidden />
            <T>Refresh</T>
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="learning-role" className="text-xs font-medium text-foreground">
              <T>Target role</T>
            </label>
            <select
              id="learning-role"
              value={effectiveRole}
              onChange={(event) => setRoleName(event.target.value)}
              className={SELECT_CLASS}
            >
              {roles.map((entry) => (
                <option key={entry.role.name} value={entry.role.name}>
                  {entry.role.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="learning-category" className="text-xs font-medium text-foreground">
              <T>Category</T>
            </label>
            <select
              id="learning-category"
              value={category}
              onChange={(event) => setCategory(event.target.value as PmHarnessLearningCategory)}
              className={SELECT_CLASS}
            >
              <option value="bug_pattern">{gt("Bug pattern")}</option>
              <option value="style_rule">{gt("Style / design rule")}</option>
              <option value="verification">{gt("Verification check")}</option>
              <option value="architecture">{gt("Architecture rule")}</option>
              <option value="skill_gap">{gt("Missing skill guidance")}</option>
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="learning-title" className="text-xs font-medium text-foreground">
              <T>Lesson title</T>
            </label>
            <Input
              id="learning-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={gt("Prevent mobile horizontal overflow on tables")}
              required
            />
          </div>
        </div>

        <div className="space-y-1">
          <label htmlFor="learning-rule" className="text-xs font-medium text-foreground">
            <T>Harness rule to add to role instructions</T>
          </label>
          <textarea
            id="learning-rule"
            rows={2}
            value={ruleText}
            onChange={(event) => setRuleText(event.target.value)}
            placeholder={gt(
              "Always wrap wide data tables in overflow-x-auto containers and verify 390px viewport.",
            )}
            className={TEXTAREA_CLASS}
            required
          />
        </div>

        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={saving}>
            <PlusIcon className="size-3.5" aria-hidden />
            <T>Propose Rule</T>
          </Button>
        </div>
      </form>

      <section className="space-y-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <T>Pending Proposals</T> ({pending.length})
        </h3>
        {pending.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
            <T>No pending harness proposals yet.</T>
          </div>
        ) : (
          <div className="space-y-2.5">
            {pending.map((item) => (
              <div
                key={item.learningId}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-card p-3.5"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" size="sm">
                      {item.roleName}
                    </Badge>
                    <Badge variant="outline" size="sm">
                      {item.category}
                    </Badge>
                    <span className="text-sm font-medium text-foreground">{item.title}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{item.ruleText}</p>
                </div>

                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="xs"
                    disabled={saving}
                    onClick={() => void handleApply(item.learningId, item.roleName)}
                  >
                    <CheckIcon className="size-3.5" aria-hidden />
                    <T>Apply to Role</T>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={saving}
                    onClick={() => void handleDismiss(item.learningId)}
                  >
                    <XIcon className="size-3.5" aria-hidden />
                    <T>Dismiss</T>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {resolved.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <T>History</T> ({resolved.length})
          </h3>
          <div className="space-y-1.5">
            {resolved.map((item) => (
              <div
                key={item.learningId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-xs"
              >
                <div className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-foreground">{item.title}</span>{" "}
                  <span className="text-muted-foreground">({item.roleName})</span>
                </div>
                <Badge variant={item.status === "applied" ? "default" : "outline"} size="sm">
                  {item.status}
                </Badge>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
