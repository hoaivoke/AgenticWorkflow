import type {
  EnvironmentId,
  PmPipelineAccess,
  PmPipelineCandidate,
  PmPipelineDefinition,
  PmPipelineRole,
  PmPipelineStage,
  PmPipelineTier,
  PmPipelineWorkspaceMode,
  PmWorkspacePipelinesSnapshot,
  ProjectId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, Var } from "gt-react";
import {
  ActivityIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BookOpenCheckIcon,
  BotIcon,
  CpuIcon,
  GitBranchIcon,
  LayersIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  ScaleIcon,
  ShieldCheckIcon,
  TerminalIcon,
  Trash2Icon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useComposerDraftStore } from "../composerDraftStore";
import { m } from "../i18n/messages";
import { cn } from "../lib/utils";
import { useProjects } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { runPmCommand } from "./actions";
import {
  pmCommands,
  useEvalRuns,
  useHarnessLearnings,
  usePipelineRuns,
  usePipelinesSnapshot,
} from "./state";
import { StudioArenaTab } from "./StudioArenaTab";
import { StudioLearningsTab } from "./StudioLearningsTab";
import { StudioLiveRunsTab } from "./StudioLiveRunsTab";
import { StudioVerifyTab } from "./StudioVerifyTab";

type StudioTab = "pipelines" | "runs" | "arena" | "verify" | "roles" | "learnings" | "skills";

interface CandidateDraft extends PmPipelineCandidate {
  readonly _key: string;
}

interface StageDraft extends PmPipelineStage {
  readonly _key: string;
}

let draftKeyCounter = 0;
function nextDraftKey(prefix: string): string {
  draftKeyCounter += 1;
  return `${prefix}-${draftKeyCounter}`;
}

interface RoleDraft {
  readonly previousName: string | undefined;
  readonly isNew: boolean;
  readonly name: string;
  readonly description: string;
  readonly tier: PmPipelineTier;
  readonly maxTier: PmPipelineTier | "";
  readonly access: PmPipelineAccess;
  readonly multimodal: boolean;
  readonly candidates: ReadonlyArray<CandidateDraft>;
  readonly skills: ReadonlyArray<string>;
  readonly contextFilesText: string;
  readonly toolkitsText: string;
  readonly outputContract: string;
  readonly instructions: string;
}

interface PipelineDraft {
  readonly previousName: string | undefined;
  readonly isNew: boolean;
  readonly name: string;
  readonly description: string;
  readonly when: string;
  readonly escalateAfter: string;
  readonly replanAfter: string;
  readonly stages: ReadonlyArray<StageDraft>;
}

const INPUT_CLASS =
  "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground shadow-2xs transition focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";
const SELECT_CLASS =
  "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground shadow-2xs transition focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground shadow-2xs transition focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";

const DEFAULT_CONTEXT_FILE_PATH = "AGENTS.md";

function parseLines(text: string): ReadonlyArray<string> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseCommaList(text: string): ReadonlyArray<string> {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function roleToDraft(role: PmPipelineRole): RoleDraft {
  return {
    previousName: role.name,
    isNew: false,
    name: role.name,
    description: role.description,
    tier: role.tier,
    maxTier: role.maxTier ?? "",
    access: role.access,
    multimodal: role.multimodal === true,
    candidates: (role.candidates ?? []).map((candidate) => ({
      ...candidate,
      _key: nextDraftKey("cand"),
    })),
    skills: role.skills ? [...role.skills] : [],
    contextFilesText: (role.contextFiles ?? []).join("\n"),
    toolkitsText: (role.toolkits ?? []).join(", "),
    outputContract: role.outputContract ?? "",
    instructions: role.instructions ?? "",
  };
}

function emptyRoleDraft(): RoleDraft {
  return {
    previousName: undefined,
    isNew: true,
    name: "custom-agent",
    description: m(msg("Describe what this agent role is responsible for.")),
    tier: "mid",
    maxTier: "",
    access: "write",
    multimodal: false,
    candidates: [],
    skills: [],
    contextFilesText: DEFAULT_CONTEXT_FILE_PATH,
    toolkitsText: "",
    outputContract: "",
    instructions: "",
  };
}

function pipelineToDraft(pipeline: PmPipelineDefinition): PipelineDraft {
  return {
    previousName: pipeline.name,
    isNew: false,
    name: pipeline.name,
    description: pipeline.description,
    when: pipeline.when ?? "",
    escalateAfter: pipeline.escalateAfter !== undefined ? String(pipeline.escalateAfter) : "",
    replanAfter: pipeline.replanAfter !== undefined ? String(pipeline.replanAfter) : "",
    stages: pipeline.stages.map((stage) => ({ ...stage, _key: nextDraftKey("stage") })),
  };
}

function emptyPipelineDraft(defaultRole: string): PipelineDraft {
  return {
    previousName: undefined,
    isNew: true,
    name: "custom-pipeline",
    description: m(msg("Describe what this workflow builds or verifies.")),
    when: "",
    escalateAfter: "2",
    replanAfter: "3",
    stages: [
      {
        _key: nextDraftKey("stage"),
        id: "plan",
        role: defaultRole,
        goal: m(msg("Inspect the codebase and draft a clear implementation plan.")),
        produces: ["plan.md"],
      },
      {
        _key: nextDraftKey("stage"),
        id: "build",
        role: "builder",
        goal: m(msg("Implement the changes following the plan and run targeted checks.")),
        reads: ["plan.md"],
        workspace: "worktree",
      },
      {
        _key: nextDraftKey("stage"),
        id: "review",
        role: "reviewer",
        goal: m(msg("Review the diff independently and report PASS or FAIL with concrete issues.")),
        differentProviderFrom: "build",
        onFail: "build",
      },
    ],
  };
}

function resolvedModelLabel(
  snapshot: PmWorkspacePipelinesSnapshot | null,
  roleName: string,
): string | null {
  const entry = snapshot?.roles.find((candidate) => candidate.role.name === roleName);
  if (!entry?.resolvedModel) return null;
  const { provider, model, effort } = entry.resolvedModel;
  return `${provider}/${model}${effort ? ` (${effort})` : ""}`;
}

export function PipelinesStudioPage() {
  const gt = useGT();
  const navigate = useNavigate();
  const projects = useProjects();

  const selectableProjects = projects.filter((project) => !project.isScratch);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string>("");
  const activeProject =
    selectableProjects.find(
      (project) => `${project.environmentId}:${project.id}` === selectedProjectKey,
    ) ??
    selectableProjects[0] ??
    null;

  const activeEnvironmentId: EnvironmentId | null = activeProject?.environmentId ?? null;
  const activeProjectId: ProjectId | null = activeProject?.id ?? null;

  const snapshotQuery = usePipelinesSnapshot(activeEnvironmentId, activeProjectId);
  const snapshot = snapshotQuery.data ?? null;
  const runsQuery = usePipelineRuns(activeEnvironmentId, activeProjectId);
  const evalsQuery = useEvalRuns(activeEnvironmentId, activeProjectId);
  const learningsQuery = useHarnessLearnings(activeEnvironmentId, activeProjectId);
  const runsCount = runsQuery.data?.length ?? 0;
  const evalsCount = evalsQuery.data?.length ?? 0;
  const pendingLearningsCount = (learningsQuery.data ?? []).filter(
    (entry) => entry.status === "proposed",
  ).length;

  const [activeTab, setActiveTab] = useState<StudioTab>("pipelines");
  const [selectedPipelineName, setSelectedPipelineName] = useState<string | null>(null);
  const [pipelineDraft, setPipelineDraft] = useState<PipelineDraft | null>(null);
  const [selectedStageIndex, setSelectedStageIndex] = useState<number>(0);

  const [selectedRoleName, setSelectedRoleName] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<RoleDraft | null>(null);
  const [customSkillInput, setCustomSkillInput] = useState<string>("");
  const [skillFilter, setSkillFilter] = useState<string>("");

  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("");

  const effectivePipelineEntry =
    snapshot?.pipelines.find((entry) => entry.pipeline.name === selectedPipelineName) ??
    snapshot?.pipelines[0] ??
    null;
  const currentPipelineDraft: PipelineDraft | null =
    pipelineDraft ??
    (effectivePipelineEntry ? pipelineToDraft(effectivePipelineEntry.pipeline) : null);

  const effectiveRoleEntry =
    snapshot?.roles.find((entry) => entry.role.name === selectedRoleName) ??
    snapshot?.roles[0] ??
    null;
  const currentRoleDraft: RoleDraft | null =
    roleDraft ?? (effectiveRoleEntry ? roleToDraft(effectiveRoleEntry.role) : null);

  const clampedStageIndex =
    currentPipelineDraft && currentPipelineDraft.stages.length > 0
      ? Math.min(selectedStageIndex, currentPipelineDraft.stages.length - 1)
      : 0;
  const activeStage = currentPipelineDraft?.stages[clampedStageIndex] ?? null;

  const selectPipeline = (name: string) => {
    setSelectedPipelineName(name);
    const entry = snapshot?.pipelines.find((candidate) => candidate.pipeline.name === name);
    setPipelineDraft(entry ? pipelineToDraft(entry.pipeline) : null);
    setSelectedStageIndex(0);
    setStatusMessage("");
  };

  const selectRole = (name: string) => {
    setSelectedRoleName(name);
    const entry = snapshot?.roles.find((candidate) => candidate.role.name === name);
    setRoleDraft(entry ? roleToDraft(entry.role) : null);
    setStatusMessage("");
  };

  const updatePipelineDraft = (updater: (draft: PipelineDraft) => PipelineDraft) => {
    if (!currentPipelineDraft) return;
    setPipelineDraft(updater(currentPipelineDraft));
  };

  const updateActiveStage = (patch: Partial<PmPipelineStage>) => {
    updatePipelineDraft((draft) => ({
      ...draft,
      stages: draft.stages.map((stage, index) =>
        index === clampedStageIndex ? { ...stage, ...patch } : stage,
      ),
    }));
  };

  const moveStage = (fromIndex: number, toIndex: number) => {
    updatePipelineDraft((draft) => {
      if (toIndex < 0 || toIndex >= draft.stages.length) return draft;
      const next = [...draft.stages];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return draft;
      next.splice(toIndex, 0, moved);
      return { ...draft, stages: next };
    });
    setSelectedStageIndex(toIndex);
  };

  const addStage = () => {
    const defaultRole = snapshot?.roles[0]?.role.name ?? "builder";
    updatePipelineDraft((draft) => {
      const nextIndex = draft.stages.length + 1;
      const newStage: StageDraft = {
        _key: nextDraftKey("stage"),
        id: `stage-${nextIndex}`,
        role: defaultRole,
        goal: gt("Describe what this stage accomplishes."),
      };
      setSelectedStageIndex(draft.stages.length);
      return { ...draft, stages: [...draft.stages, newStage] };
    });
  };

  const removeStage = (index: number) => {
    updatePipelineDraft((draft) => {
      if (draft.stages.length <= 1) return draft;
      const next = draft.stages.filter((_, idx) => idx !== index);
      setSelectedStageIndex(Math.max(0, index - 1));
      return { ...draft, stages: next };
    });
  };

  const handleSavePipeline = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeEnvironmentId || !activeProjectId || !currentPipelineDraft || saving) return;
    const trimmedName = currentPipelineDraft.name.trim();
    const trimmedDescription = currentPipelineDraft.description.trim();
    if (!trimmedName || !trimmedDescription) {
      toastManager.add({
        type: "error",
        title: gt("Pipeline name and description are required"),
      });
      return;
    }
    const escalateNum = Number(currentPipelineDraft.escalateAfter);
    const replanNum = Number(currentPipelineDraft.replanAfter);
    const pipeline: PmPipelineDefinition = {
      name: trimmedName,
      description: trimmedDescription,
      ...(currentPipelineDraft.when.trim() ? { when: currentPipelineDraft.when.trim() } : {}),
      ...(currentPipelineDraft.escalateAfter.trim() &&
      Number.isFinite(escalateNum) &&
      escalateNum >= 1
        ? { escalateAfter: Math.floor(escalateNum) }
        : {}),
      ...(currentPipelineDraft.replanAfter.trim() && Number.isFinite(replanNum) && replanNum >= 1
        ? { replanAfter: Math.floor(replanNum) }
        : {}),
      stages: currentPipelineDraft.stages.map((stage) => ({
        id: stage.id.trim() || "stage",
        ...(stage.role?.trim() ? { role: stage.role.trim() } : {}),
        goal: stage.goal.trim() || gt("Complete this stage."),
        ...(stage.reads && stage.reads.length > 0 ? { reads: stage.reads } : {}),
        ...(stage.produces && stage.produces.length > 0 ? { produces: stage.produces } : {}),
        ...(stage.workspace ? { workspace: stage.workspace } : {}),
        ...(stage.parallel && stage.parallel > 1 ? { parallel: stage.parallel } : {}),
        ...(stage.foreach ? { foreach: stage.foreach } : {}),
        ...(stage.differentProviderFrom?.trim()
          ? { differentProviderFrom: stage.differentProviderFrom.trim() }
          : {}),
        ...(stage.approval ? { approval: true } : {}),
        ...(stage.skipWhen?.trim() ? { skipWhen: stage.skipWhen.trim() } : {}),
        ...(stage.onFail?.trim() ? { onFail: stage.onFail.trim() } : {}),
        ...(stage.run && stage.run.length > 0 ? { run: stage.run } : {}),
      })),
    };
    setSaving(true);
    const updated = await runPmCommand(
      pmCommands.pipelineSave,
      {
        environmentId: activeEnvironmentId,
        input: {
          projectId: activeProjectId,
          pipeline,
          ...(currentPipelineDraft.previousName
            ? { previousName: currentPipelineDraft.previousName }
            : {}),
        },
      },
      gt("Could not save pipeline"),
    ).catch(() => null);
    setSaving(false);
    if (updated !== null) {
      setSelectedPipelineName(trimmedName);
      setPipelineDraft(null);
      snapshotQuery.refresh();
      setStatusMessage(
        gt("Saved {name} to .pipelines/pipelines/{name}.yaml", { name: trimmedName }),
      );
      toastManager.add({
        type: "success",
        title: gt("Pipeline saved"),
        description: gt("Written to .pipelines/pipelines/{name}.yaml", { name: trimmedName }),
      });
    }
  };

  const handleDeletePipeline = async () => {
    if (!activeEnvironmentId || !activeProjectId || !currentPipelineDraft || saving) return;
    const name = currentPipelineDraft.previousName ?? currentPipelineDraft.name.trim();
    if (!name) return;
    setSaving(true);
    const updated = await runPmCommand(
      pmCommands.pipelineDelete,
      {
        environmentId: activeEnvironmentId,
        input: { projectId: activeProjectId, name },
      },
      gt("Could not remove pipeline override"),
    ).catch(() => null);
    setSaving(false);
    if (updated !== null) {
      setPipelineDraft(null);
      setSelectedPipelineName(null);
      snapshotQuery.refresh();
      setStatusMessage(gt("Removed project override for {name}", { name }));
    }
  };

  const updateRoleDraft = (updater: (draft: RoleDraft) => RoleDraft) => {
    if (!currentRoleDraft) return;
    setRoleDraft(updater(currentRoleDraft));
  };

  const toggleRoleSkill = (skillName: string) => {
    updateRoleDraft((draft) => {
      const exists = draft.skills.includes(skillName);
      return {
        ...draft,
        skills: exists
          ? draft.skills.filter((skill) => skill !== skillName)
          : [...draft.skills, skillName],
      };
    });
  };

  const addCustomSkill = () => {
    const trimmed = customSkillInput.trim();
    if (!trimmed) return;
    updateRoleDraft((draft) =>
      draft.skills.includes(trimmed) ? draft : { ...draft, skills: [...draft.skills, trimmed] },
    );
    setCustomSkillInput("");
  };

  const addModelCandidate = () => {
    const firstEnabled =
      snapshot?.providers.find((provider) => provider.enabled && provider.models.length > 0) ??
      snapshot?.providers.find((provider) => provider.models.length > 0);
    const providerId = firstEnabled?.driver ?? "claude";
    const modelSlug = firstEnabled?.models[0]?.slug ?? "claude-sonnet-4-6";
    updateRoleDraft((draft) => ({
      ...draft,
      candidates: [
        ...draft.candidates,
        { _key: nextDraftKey("cand"), provider: providerId, model: modelSlug },
      ],
    }));
  };

  const handleSaveRole = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeEnvironmentId || !activeProjectId || !currentRoleDraft || saving) return;
    const trimmedName = currentRoleDraft.name.trim();
    const trimmedDescription = currentRoleDraft.description.trim();
    if (!trimmedName || !trimmedDescription) {
      toastManager.add({
        type: "error",
        title: gt("Role name and description are required"),
      });
      return;
    }
    const contextFiles = parseLines(currentRoleDraft.contextFilesText);
    const toolkits = parseCommaList(currentRoleDraft.toolkitsText);
    const candidates = currentRoleDraft.candidates
      .filter(
        (candidate) => candidate.provider.trim().length > 0 && candidate.model.trim().length > 0,
      )
      .map(({ _key: _unused, ...candidate }) => candidate);
    const role: PmPipelineRole = {
      name: trimmedName,
      description: trimmedDescription,
      tier: currentRoleDraft.tier,
      ...(currentRoleDraft.maxTier !== "" ? { maxTier: currentRoleDraft.maxTier } : {}),
      access: currentRoleDraft.access,
      ...(currentRoleDraft.multimodal ? { multimodal: true } : {}),
      ...(candidates.length > 0 ? { candidates } : {}),
      ...(currentRoleDraft.skills.length > 0 ? { skills: currentRoleDraft.skills } : {}),
      ...(contextFiles.length > 0 ? { contextFiles } : {}),
      ...(toolkits.length > 0 ? { toolkits } : {}),
      ...(currentRoleDraft.outputContract.trim()
        ? { outputContract: currentRoleDraft.outputContract.trim() }
        : {}),
      ...(currentRoleDraft.instructions.trim()
        ? { instructions: currentRoleDraft.instructions.trim() }
        : {}),
    };
    setSaving(true);
    const updated = await runPmCommand(
      pmCommands.roleSave,
      {
        environmentId: activeEnvironmentId,
        input: {
          projectId: activeProjectId,
          role,
          ...(currentRoleDraft.previousName ? { previousName: currentRoleDraft.previousName } : {}),
        },
      },
      gt("Could not save role"),
    ).catch(() => null);
    setSaving(false);
    if (updated !== null) {
      setSelectedRoleName(trimmedName);
      setRoleDraft(null);
      snapshotQuery.refresh();
      setStatusMessage(
        gt("Saved role {name} to .pipelines/roles/{name}.yaml", { name: trimmedName }),
      );
      toastManager.add({
        type: "success",
        title: gt("Role harness saved"),
        description: gt("Written to .pipelines/roles/{name}.yaml", { name: trimmedName }),
      });
    }
  };

  const handleDeleteRole = async () => {
    if (!activeEnvironmentId || !activeProjectId || !currentRoleDraft || saving) return;
    const name = currentRoleDraft.previousName ?? currentRoleDraft.name.trim();
    if (!name) return;
    setSaving(true);
    const updated = await runPmCommand(
      pmCommands.roleDelete,
      {
        environmentId: activeEnvironmentId,
        input: { projectId: activeProjectId, name },
      },
      gt("Could not remove role override"),
    ).catch(() => null);
    setSaving(false);
    if (updated !== null) {
      setRoleDraft(null);
      setSelectedRoleName(null);
      snapshotQuery.refresh();
      setStatusMessage(gt("Removed project override for role {name}", { name }));
    }
  };

  const openAgentDesignThread = async (mode: "design" | "run") => {
    if (!activeEnvironmentId || !activeProjectId || launching) return;
    setLaunching(true);
    const created = await runPmCommand(
      pmCommands.create,
      {
        environmentId: activeEnvironmentId,
        input: { projectId: activeProjectId },
      },
      gt("Could not open an agent thread"),
    ).catch(() => null);
    setLaunching(false);
    if (created === null) return;

    const targetRef = scopeThreadRef(activeEnvironmentId, created.threadId);
    const targetName =
      mode === "run"
        ? (currentPipelineDraft?.name ?? effectivePipelineEntry?.pipeline.name ?? "feature")
        : activeTab === "roles"
          ? (currentRoleDraft?.name ?? effectiveRoleEntry?.role.name ?? "builder")
          : (currentPipelineDraft?.name ?? effectivePipelineEntry?.pipeline.name ?? "feature");

    const draftPrompt =
      mode === "run"
        ? `Run the "${targetName}" pipeline on this project. Call pm_pipelines(name: "${targetName}") and pm_roles() first, then coordinate the stages and report progress.`
        : `Inspect our current roles (pm_roles) and pipelines (pm_pipelines). Suggest improvements to our agent roles, model assignments, harnesses (skills, contextFiles, instructions), and pipeline "${targetName}", and save any approved changes directly using pm_role_save and pm_pipeline_save.`;

    useComposerDraftStore.getState().setPrompt(targetRef, draftPrompt);
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetRef),
    });
  };

  const filteredSkills = (snapshot?.discoveredSkills ?? []).filter((skill) => {
    const query = skillFilter.trim().toLowerCase();
    if (!query) return true;
    return (
      skill.name.toLowerCase().includes(query) ||
      skill.path.toLowerCase().includes(query) ||
      skill.scope.toLowerCase().includes(query)
    );
  });

  const currentPipelineMeta = snapshot?.pipelines.find(
    (entry) =>
      entry.pipeline.name === (currentPipelineDraft?.previousName ?? currentPipelineDraft?.name),
  );
  const currentRoleMeta = snapshot?.roles.find(
    (entry) => entry.role.name === (currentRoleDraft?.previousName ?? currentRoleDraft?.name),
  );

  return (
    <ScrollArea className="h-full min-h-0 flex-1">
      <WorkspacePageContainer width="expanded" className="gap-5">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <WorkflowIcon className="size-5 text-primary" aria-hidden />
              <h1 className="text-lg font-semibold tracking-tight text-foreground">
                <T>Pipelines & Agent Harnesses</T>
              </h1>
            </div>
            <p className="text-sm text-muted-foreground">
              <T>
                Design custom multi-agent pipelines, assign models and harnesses per role, and share
                skills and repository context across Claude, Codex, and Antigravity.
              </T>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {selectableProjects.length > 0 ? (
              <div className="flex items-center gap-2">
                <label
                  htmlFor="pipelines-project-select"
                  className="text-xs font-medium text-muted-foreground"
                >
                  <T>Project</T>
                </label>
                <select
                  id="pipelines-project-select"
                  value={activeProject ? `${activeProject.environmentId}:${activeProject.id}` : ""}
                  onChange={(event) => {
                    setSelectedProjectKey(event.target.value);
                    setSelectedPipelineName(null);
                    setPipelineDraft(null);
                    setSelectedRoleName(null);
                    setRoleDraft(null);
                    setSelectedStageIndex(0);
                    setStatusMessage("");
                  }}
                  className={cn(SELECT_CLASS, "w-56 py-1 text-xs")}
                >
                  {selectableProjects.map((project) => {
                    const key = `${project.environmentId}:${project.id}`;
                    return (
                      <option key={key} value={key}>
                        {project.title}
                      </option>
                    );
                  })}
                </select>
              </div>
            ) : null}

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => snapshotQuery.refresh()}
                    disabled={!activeProject}
                    aria-label={gt("Refresh pipelines and skills")}
                  >
                    <RefreshCwIcon className="size-3.5" aria-hidden />
                  </Button>
                }
              />
              <TooltipPopup>
                <T>Reload .pipelines/ config and skills</T>
              </TooltipPopup>
            </Tooltip>

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!activeProject || launching}
              onClick={() => void openAgentDesignThread("design")}
            >
              <BotIcon className="size-3.5" aria-hidden />
              <T>Ask Agent to Suggest</T>
            </Button>

            <Button
              type="button"
              size="sm"
              disabled={!activeProject || launching}
              onClick={() => void openAgentDesignThread("run")}
            >
              <PlayIcon className="size-3.5" aria-hidden />
              <T>Run Pipeline</T>
            </Button>
          </div>
        </header>

        <div aria-live="polite" className="sr-only">
          {statusMessage}
        </div>

        {!activeProject ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            <T>Open or add a project first to design custom roles and pipelines.</T>
          </div>
        ) : (
          <>
            {snapshot && snapshot.problems.length > 0 ? (
              <div
                role="alert"
                className="rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-xs text-warning-foreground"
              >
                <p className="font-medium">
                  <T>Ignored configuration issues in .pipelines/</T>
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {snapshot.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div
              role="tablist"
              aria-label={gt("Pipelines studio sections")}
              className="flex flex-wrap items-center gap-1 border-b border-border pb-2"
            >
              <Button
                type="button"
                role="tab"
                aria-selected={activeTab === "pipelines"}
                variant={activeTab === "pipelines" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("pipelines")}
              >
                <WorkflowIcon className="size-3.5" aria-hidden />
                <T>Pipelines</T>
                {snapshot ? (
                  <Badge variant="outline" size="sm" className="ml-1">
                    {snapshot.pipelines.length}
                  </Badge>
                ) : null}
              </Button>
              <Button
                type="button"
                role="tab"
                aria-selected={activeTab === "runs"}
                variant={activeTab === "runs" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("runs")}
              >
                <ActivityIcon className="size-3.5" aria-hidden />
                <T>Live Runs</T>
                {runsCount > 0 ? (
                  <Badge variant="outline" size="sm" className="ml-1">
                    {runsCount}
                  </Badge>
                ) : null}
              </Button>
              <Button
                type="button"
                role="tab"
                aria-selected={activeTab === "arena"}
                variant={activeTab === "arena" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("arena")}
              >
                <ScaleIcon className="size-3.5" aria-hidden />
                <T>A/B Eval Arena</T>
                {evalsCount > 0 ? (
                  <Badge variant="outline" size="sm" className="ml-1">
                    {evalsCount}
                  </Badge>
                ) : null}
              </Button>
              <Button
                type="button"
                role="tab"
                aria-selected={activeTab === "verify"}
                variant={activeTab === "verify" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("verify")}
              >
                <ShieldCheckIcon className="size-3.5" aria-hidden />
                <T>App Verification</T>
              </Button>
              <Button
                type="button"
                role="tab"
                aria-selected={activeTab === "roles"}
                variant={activeTab === "roles" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("roles")}
              >
                <BotIcon className="size-3.5" aria-hidden />
                <T>Roles & Harnesses</T>
                {snapshot ? (
                  <Badge variant="outline" size="sm" className="ml-1">
                    {snapshot.roles.length}
                  </Badge>
                ) : null}
              </Button>
              <Button
                type="button"
                role="tab"
                aria-selected={activeTab === "learnings"}
                variant={activeTab === "learnings" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("learnings")}
              >
                <BookOpenCheckIcon className="size-3.5" aria-hidden />
                <T>Learnings</T>
                {pendingLearningsCount > 0 ? (
                  <Badge variant="warning" size="sm" className="ml-1">
                    {pendingLearningsCount}
                  </Badge>
                ) : null}
              </Button>
              <Button
                type="button"
                role="tab"
                aria-selected={activeTab === "skills"}
                variant={activeTab === "skills" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("skills")}
              >
                <WrenchIcon className="size-3.5" aria-hidden />
                <T>Discovered Skills</T>
                {snapshot ? (
                  <Badge variant="outline" size="sm" className="ml-1">
                    {snapshot.discoveredSkills.length}
                  </Badge>
                ) : null}
              </Button>
            </div>

            {activeTab === "pipelines" ? (
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
                <aside className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <T>Workflows</T>
                    </h2>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        const defaultRole = snapshot?.roles[0]?.role.name ?? "architect";
                        setSelectedPipelineName(null);
                        setPipelineDraft(emptyPipelineDraft(defaultRole));
                        setSelectedStageIndex(0);
                      }}
                    >
                      <PlusIcon className="size-3" aria-hidden />
                      <T>New pipeline</T>
                    </Button>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    {(snapshot?.pipelines ?? []).map((entry) => {
                      const active =
                        !currentPipelineDraft?.isNew &&
                        currentPipelineDraft?.name === entry.pipeline.name;
                      return (
                        <button
                          key={entry.pipeline.name}
                          type="button"
                          aria-pressed={active}
                          onClick={() => selectPipeline(entry.pipeline.name)}
                          className={cn(
                            "flex w-full flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                            active
                              ? "border-primary/60 bg-accent/60"
                              : "border-border bg-card hover:bg-accent/30",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {entry.pipeline.name}
                            </span>
                            <Badge variant={entry.isOverridden ? "info" : "outline"} size="sm">
                              {entry.isOverridden ? gt("Project") : gt("Built-in")}
                            </Badge>
                          </div>
                          <p className="line-clamp-2 text-xs text-muted-foreground">
                            {entry.pipeline.description}
                          </p>
                          <div className="text-2xs text-muted-foreground">
                            <T>
                              <Var>{entry.pipeline.stages.length}</Var> stages
                            </T>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </aside>

                <section className="flex min-w-0 flex-col gap-5">
                  {currentPipelineDraft ? (
                    <>
                      <div className="rounded-xl border border-border bg-card/60 p-4">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <h2 className="text-sm font-semibold text-foreground">
                              <T>Visual Workflow Graph</T>
                            </h2>
                            <p className="text-xs text-muted-foreground">
                              <T>
                                Click any stage to edit its assigned role, model routing, review
                                vendor separation, or deterministic shell gates.
                              </T>
                            </p>
                          </div>
                          <Button type="button" variant="outline" size="xs" onClick={addStage}>
                            <PlusIcon className="size-3" aria-hidden />
                            <T>Add stage</T>
                          </Button>
                        </div>

                        <ol
                          aria-label={gt("Pipeline stage workflow")}
                          className="flex flex-wrap items-stretch gap-2.5"
                        >
                          {currentPipelineDraft.stages.map((stage, index) => {
                            const selected = index === clampedStageIndex;
                            const resolved = stage.role
                              ? resolvedModelLabel(snapshot, stage.role)
                              : null;
                            return (
                              <li key={stage._key} className="flex items-center gap-2">
                                <button
                                  type="button"
                                  aria-current={selected ? "step" : undefined}
                                  onClick={() => setSelectedStageIndex(index)}
                                  className={cn(
                                    "flex w-56 flex-col gap-1.5 rounded-lg border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                    selected
                                      ? "border-primary bg-primary/5 ring-1 ring-inset ring-primary/40"
                                      : "border-border bg-background hover:border-primary/40",
                                  )}
                                >
                                  <div className="flex items-center justify-between gap-1.5">
                                    <span className="truncate text-xs font-semibold text-foreground">
                                      {index + 1}. {stage.id}
                                    </span>
                                    <Badge variant="secondary" size="sm">
                                      {stage.role ?? gt("gatekeeper")}
                                    </Badge>
                                  </div>
                                  <p className="line-clamp-2 text-2xs text-muted-foreground">
                                    {stage.goal}
                                  </p>
                                  {resolved ? (
                                    <div className="flex items-center gap-1 text-2xs text-muted-foreground">
                                      <CpuIcon className="size-3 shrink-0" aria-hidden />
                                      <span className="truncate">{resolved}</span>
                                    </div>
                                  ) : null}
                                  <div className="flex flex-wrap gap-1 pt-0.5">
                                    {stage.workspace === "worktree" ? (
                                      <Badge variant="outline" size="sm">
                                        <GitBranchIcon className="mr-0.5 size-2.5" aria-hidden />
                                        <T>worktree</T>
                                      </Badge>
                                    ) : null}
                                    {stage.parallel && stage.parallel > 1 ? (
                                      <Badge variant="outline" size="sm">
                                        <LayersIcon className="mr-0.5 size-2.5" aria-hidden />×
                                        {stage.parallel}
                                      </Badge>
                                    ) : null}
                                    {stage.approval ? (
                                      <Badge variant="warning" size="sm">
                                        <ShieldCheckIcon className="mr-0.5 size-2.5" aria-hidden />
                                        <T>Approval</T>
                                      </Badge>
                                    ) : null}
                                    {stage.differentProviderFrom ? (
                                      <Badge variant="info" size="sm">
                                        ≠ {stage.differentProviderFrom}
                                      </Badge>
                                    ) : null}
                                    {stage.onFail ? (
                                      <Badge variant="outline" size="sm">
                                        <RotateCcwIcon className="mr-0.5 size-2.5" aria-hidden />
                                        {stage.onFail}
                                      </Badge>
                                    ) : null}
                                    {stage.run && stage.run.length > 0 ? (
                                      <Badge variant="outline" size="sm">
                                        <TerminalIcon className="mr-0.5 size-2.5" aria-hidden />
                                        {stage.run.length}
                                      </Badge>
                                    ) : null}
                                  </div>
                                </button>
                                {index < currentPipelineDraft.stages.length - 1 ? (
                                  <ArrowRightIcon
                                    className="size-4 shrink-0 text-muted-foreground"
                                    aria-hidden
                                  />
                                ) : null}
                              </li>
                            );
                          })}
                        </ol>
                      </div>

                      <form
                        aria-labelledby="pipeline-editor-heading"
                        onSubmit={(event) => void handleSavePipeline(event)}
                        className="flex flex-col gap-5 rounded-xl border border-border bg-card p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                          <div>
                            <h2
                              id="pipeline-editor-heading"
                              className="text-sm font-semibold text-foreground"
                            >
                              {currentPipelineDraft.isNew
                                ? gt("New custom pipeline")
                                : gt("Edit pipeline: {name}", { name: currentPipelineDraft.name })}
                            </h2>
                            <p className="text-xs text-muted-foreground">
                              {currentPipelineMeta?.source
                                ? gt("Source: {source}", { source: currentPipelineMeta.source })
                                : gt("Saves to .pipelines/pipelines/{name}.yaml", {
                                    name: currentPipelineDraft.name || "custom",
                                  })}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            {currentPipelineMeta?.isOverridden ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={saving}
                                onClick={() => void handleDeletePipeline()}
                              >
                                <Trash2Icon className="size-3.5" aria-hidden />
                                {currentPipelineMeta.isBuiltIn
                                  ? gt("Reset to built-in")
                                  : gt("Delete pipeline")}
                              </Button>
                            ) : null}
                            <Button type="submit" size="sm" disabled={saving}>
                              <SaveIcon className="size-3.5" aria-hidden />
                              {saving ? gt("Saving...") : gt("Save pipeline")}
                            </Button>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <label
                              htmlFor="pipeline-name"
                              className="text-xs font-medium text-foreground"
                            >
                              <T>Pipeline slug</T>
                            </label>
                            <Input
                              id="pipeline-name"
                              value={currentPipelineDraft.name}
                              onChange={(event) =>
                                updatePipelineDraft((draft) => ({
                                  ...draft,
                                  name: event.target.value,
                                }))
                              }
                              autoCorrect="off"
                              autoCapitalize="none"
                              spellCheck={false}
                              required
                            />
                          </div>
                          <div className="space-y-1">
                            <label
                              htmlFor="pipeline-when"
                              className="text-xs font-medium text-foreground"
                            >
                              <T>When to suggest this pipeline</T>
                            </label>
                            <Input
                              id="pipeline-when"
                              value={currentPipelineDraft.when}
                              onChange={(event) =>
                                updatePipelineDraft((draft) => ({
                                  ...draft,
                                  when: event.target.value,
                                }))
                              }
                              placeholder={gt("e.g. Multi-file feature or architecture refactor")}
                            />
                          </div>
                          <div className="space-y-1 sm:col-span-2">
                            <label
                              htmlFor="pipeline-description"
                              className="text-xs font-medium text-foreground"
                            >
                              <T>Description</T>
                            </label>
                            <Input
                              id="pipeline-description"
                              value={currentPipelineDraft.description}
                              onChange={(event) =>
                                updatePipelineDraft((draft) => ({
                                  ...draft,
                                  description: event.target.value,
                                }))
                              }
                              required
                            />
                          </div>
                          <div className="space-y-1">
                            <label
                              htmlFor="pipeline-escalate"
                              className="text-xs font-medium text-foreground"
                            >
                              <T>Escalate tier after failed attempts</T>
                            </label>
                            <Input
                              id="pipeline-escalate"
                              type="number"
                              min={1}
                              max={10}
                              value={currentPipelineDraft.escalateAfter}
                              onChange={(event) =>
                                updatePipelineDraft((draft) => ({
                                  ...draft,
                                  escalateAfter: event.target.value,
                                }))
                              }
                            />
                          </div>
                          <div className="space-y-1">
                            <label
                              htmlFor="pipeline-replan"
                              className="text-xs font-medium text-foreground"
                            >
                              <T>Replan after failed attempts</T>
                            </label>
                            <Input
                              id="pipeline-replan"
                              type="number"
                              min={1}
                              max={10}
                              value={currentPipelineDraft.replanAfter}
                              onChange={(event) =>
                                updatePipelineDraft((draft) => ({
                                  ...draft,
                                  replanAfter: event.target.value,
                                }))
                              }
                            />
                          </div>
                        </div>

                        {activeStage ? (
                          <fieldset className="space-y-3 rounded-lg border border-border/80 bg-background/60 p-3.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                <T>
                                  Stage <Var>{clampedStageIndex + 1}</Var>:{" "}
                                  <Var>{activeStage.id}</Var>
                                </T>
                              </legend>
                              <div className="flex items-center gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  disabled={clampedStageIndex === 0}
                                  aria-label={gt("Move stage left")}
                                  onClick={() =>
                                    moveStage(clampedStageIndex, clampedStageIndex - 1)
                                  }
                                >
                                  <ArrowLeftIcon className="size-3.5" aria-hidden />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  disabled={
                                    clampedStageIndex >= currentPipelineDraft.stages.length - 1
                                  }
                                  aria-label={gt("Move stage right")}
                                  onClick={() =>
                                    moveStage(clampedStageIndex, clampedStageIndex + 1)
                                  }
                                >
                                  <ArrowRightIcon className="size-3.5" aria-hidden />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  disabled={currentPipelineDraft.stages.length <= 1}
                                  onClick={() => removeStage(clampedStageIndex)}
                                >
                                  <Trash2Icon className="size-3.5" aria-hidden />
                                  <T>Remove</T>
                                </Button>
                              </div>
                            </div>

                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                              <div className="space-y-1">
                                <label
                                  htmlFor="stage-id"
                                  className="text-xs font-medium text-foreground"
                                >
                                  <T>Stage ID</T>
                                </label>
                                <Input
                                  id="stage-id"
                                  value={activeStage.id}
                                  onChange={(event) =>
                                    updateActiveStage({ id: event.target.value })
                                  }
                                  autoCorrect="off"
                                  autoCapitalize="none"
                                  spellCheck={false}
                                />
                              </div>

                              <div className="space-y-1">
                                <label
                                  htmlFor="stage-role"
                                  className="text-xs font-medium text-foreground"
                                >
                                  <T>Assigned role</T>
                                </label>
                                <select
                                  id="stage-role"
                                  value={activeStage.role ?? ""}
                                  onChange={(event) =>
                                    updateActiveStage({
                                      role: event.target.value || undefined,
                                    })
                                  }
                                  className={SELECT_CLASS}
                                >
                                  <option value="">{gt("Gatekeeper (run commands only)")}</option>
                                  {(snapshot?.roles ?? []).map((entry) => (
                                    <option key={entry.role.name} value={entry.role.name}>
                                      {entry.role.name} ({entry.role.tier})
                                    </option>
                                  ))}
                                </select>
                              </div>

                              <div className="space-y-1">
                                <label
                                  htmlFor="stage-workspace"
                                  className="text-xs font-medium text-foreground"
                                >
                                  <T>Workspace</T>
                                </label>
                                <select
                                  id="stage-workspace"
                                  value={activeStage.workspace ?? "shared"}
                                  onChange={(event) =>
                                    updateActiveStage({
                                      workspace: event.target.value as PmPipelineWorkspaceMode,
                                    })
                                  }
                                  className={SELECT_CLASS}
                                >
                                  <option value="shared">{gt("Shared workspace")}</option>
                                  <option value="worktree">{gt("Isolated git worktree")}</option>
                                </select>
                              </div>
                            </div>

                            <div className="space-y-1">
                              <label
                                htmlFor="stage-goal"
                                className="text-xs font-medium text-foreground"
                              >
                                <T>Stage goal / prompt focus</T>
                              </label>
                              <textarea
                                id="stage-goal"
                                rows={2}
                                value={activeStage.goal}
                                onChange={(event) =>
                                  updateActiveStage({ goal: event.target.value })
                                }
                                className={TEXTAREA_CLASS}
                              />
                            </div>

                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                              <div className="space-y-1">
                                <label
                                  htmlFor="stage-parallel"
                                  className="text-xs font-medium text-foreground"
                                >
                                  <T>Parallel workers</T>
                                </label>
                                <Input
                                  id="stage-parallel"
                                  type="number"
                                  min={1}
                                  max={16}
                                  value={activeStage.parallel ?? 1}
                                  onChange={(event) => {
                                    const num = Number(event.target.value);
                                    updateActiveStage({
                                      parallel: Number.isFinite(num) && num > 1 ? num : undefined,
                                    });
                                  }}
                                />
                              </div>

                              <div className="space-y-1">
                                <label
                                  htmlFor="stage-diff-vendor"
                                  className="text-xs font-medium text-foreground"
                                >
                                  <T>Different provider from</T>
                                </label>
                                <select
                                  id="stage-diff-vendor"
                                  value={activeStage.differentProviderFrom ?? ""}
                                  onChange={(event) =>
                                    updateActiveStage({
                                      differentProviderFrom: event.target.value || undefined,
                                    })
                                  }
                                  className={SELECT_CLASS}
                                >
                                  <option value="">{gt("Any provider")}</option>
                                  {currentPipelineDraft.stages
                                    .filter((_, idx) => idx !== clampedStageIndex)
                                    .map((other) => (
                                      <option key={other.id} value={other.id}>
                                        {other.id}
                                      </option>
                                    ))}
                                </select>
                              </div>

                              <div className="space-y-1">
                                <label
                                  htmlFor="stage-on-fail"
                                  className="text-xs font-medium text-foreground"
                                >
                                  <T>On fail loop back to</T>
                                </label>
                                <select
                                  id="stage-on-fail"
                                  value={activeStage.onFail ?? ""}
                                  onChange={(event) =>
                                    updateActiveStage({
                                      onFail: event.target.value || undefined,
                                    })
                                  }
                                  className={SELECT_CLASS}
                                >
                                  <option value="">{gt("None")}</option>
                                  {currentPipelineDraft.stages.map((other) => (
                                    <option key={other.id} value={other.id}>
                                      {other.id}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>

                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                              <div className="space-y-1">
                                <label
                                  htmlFor="stage-reads"
                                  className="text-xs font-medium text-foreground"
                                >
                                  <T>Reads artifacts (comma-separated)</T>
                                </label>
                                <Input
                                  id="stage-reads"
                                  value={(activeStage.reads ?? []).join(", ")}
                                  onChange={(event) => {
                                    const list = parseCommaList(event.target.value);
                                    updateActiveStage({
                                      reads: list.length > 0 ? list : undefined,
                                    });
                                  }}
                                  placeholder={gt("spec.md, plan.md")}
                                />
                              </div>

                              <div className="space-y-1">
                                <label
                                  htmlFor="stage-produces"
                                  className="text-xs font-medium text-foreground"
                                >
                                  <T>Produces artifacts (comma-separated)</T>
                                </label>
                                <Input
                                  id="stage-produces"
                                  value={(activeStage.produces ?? []).join(", ")}
                                  onChange={(event) => {
                                    const list = parseCommaList(event.target.value);
                                    updateActiveStage({
                                      produces: list.length > 0 ? list : undefined,
                                    });
                                  }}
                                  placeholder={gt("review.md")}
                                />
                              </div>
                            </div>

                            <div className="space-y-1">
                              <label
                                htmlFor="stage-run"
                                className="text-xs font-medium text-foreground"
                              >
                                <T>Deterministic shell gate commands (one per line)</T>
                              </label>
                              <textarea
                                id="stage-run"
                                rows={2}
                                value={(activeStage.run ?? []).join("\n")}
                                onChange={(event) => {
                                  const commands = parseLines(event.target.value);
                                  updateActiveStage({
                                    run: commands.length > 0 ? commands : undefined,
                                  });
                                }}
                                placeholder={gt("pnpm lint\npnpm test")}
                                className={cn(TEXTAREA_CLASS, "font-mono text-xs")}
                              />
                            </div>

                            <div className="flex items-center gap-2 pt-1">
                              <input
                                id="stage-approval"
                                type="checkbox"
                                checked={activeStage.approval === true}
                                onChange={(event) =>
                                  updateActiveStage({
                                    approval: event.target.checked ? true : undefined,
                                  })
                                }
                                className="size-4 rounded border-input accent-primary"
                              />
                              <label
                                htmlFor="stage-approval"
                                className="text-xs font-medium text-foreground"
                              >
                                <T>Pause for user approval before moving to the next stage</T>
                              </label>
                            </div>
                          </fieldset>
                        ) : null}
                      </form>
                    </>
                  ) : null}
                </section>
              </div>
            ) : null}

            {activeTab === "roles" ? (
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
                <aside className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <T>Agent Roles</T>
                    </h2>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        setSelectedRoleName(null);
                        setRoleDraft(emptyRoleDraft());
                      }}
                    >
                      <PlusIcon className="size-3" aria-hidden />
                      <T>New role</T>
                    </Button>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    {(snapshot?.roles ?? []).map((entry) => {
                      const active =
                        !currentRoleDraft?.isNew && currentRoleDraft?.name === entry.role.name;
                      return (
                        <button
                          key={entry.role.name}
                          type="button"
                          aria-pressed={active}
                          onClick={() => selectRole(entry.role.name)}
                          className={cn(
                            "flex w-full flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                            active
                              ? "border-primary/60 bg-accent/60"
                              : "border-border bg-card hover:bg-accent/30",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {entry.role.name}
                            </span>
                            <Badge variant={entry.isOverridden ? "info" : "outline"} size="sm">
                              {entry.role.tier}
                            </Badge>
                          </div>
                          <p className="line-clamp-2 text-xs text-muted-foreground">
                            {entry.role.description}
                          </p>
                          <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
                            <span>
                              {entry.resolvedModel
                                ? `${entry.resolvedModel.provider}/${entry.resolvedModel.model}`
                                : gt("Auto")}
                            </span>
                            {(entry.role.skills?.length ?? 0) > 0 ? (
                              <Badge variant="secondary" size="sm">
                                <T>
                                  <Var>{entry.role.skills?.length ?? 0}</Var> skills
                                </T>
                              </Badge>
                            ) : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </aside>

                <section className="min-w-0">
                  {currentRoleDraft ? (
                    <form
                      aria-labelledby="role-editor-heading"
                      onSubmit={(event) => void handleSaveRole(event)}
                      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                        <div>
                          <h2
                            id="role-editor-heading"
                            className="text-sm font-semibold text-foreground"
                          >
                            {currentRoleDraft.isNew
                              ? gt("New custom role harness")
                              : gt("Role harness: {name}", { name: currentRoleDraft.name })}
                          </h2>
                          <p className="text-xs text-muted-foreground">
                            {currentRoleMeta?.resolvedModel
                              ? gt("Currently resolves to {provider}/{model}", {
                                  provider: currentRoleMeta.resolvedModel.provider,
                                  model: currentRoleMeta.resolvedModel.model,
                                })
                              : (currentRoleMeta?.resolvedNote ??
                                gt("Saved roles work across Claude, Codex, and Antigravity."))}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {currentRoleMeta?.isOverridden ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={saving}
                              onClick={() => void handleDeleteRole()}
                            >
                              <Trash2Icon className="size-3.5" aria-hidden />
                              {currentRoleMeta.isBuiltIn
                                ? gt("Reset to built-in")
                                : gt("Delete role")}
                            </Button>
                          ) : null}
                          <Button type="submit" size="sm" disabled={saving}>
                            <SaveIcon className="size-3.5" aria-hidden />
                            {saving ? gt("Saving...") : gt("Save role")}
                          </Button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label
                            htmlFor="role-name"
                            className="text-xs font-medium text-foreground"
                          >
                            <T>Role slug</T>
                          </label>
                          <Input
                            id="role-name"
                            value={currentRoleDraft.name}
                            onChange={(event) =>
                              updateRoleDraft((draft) => ({ ...draft, name: event.target.value }))
                            }
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            required
                          />
                        </div>

                        <div className="space-y-1">
                          <label
                            htmlFor="role-access"
                            className="text-xs font-medium text-foreground"
                          >
                            <T>Workspace access</T>
                          </label>
                          <select
                            id="role-access"
                            value={currentRoleDraft.access}
                            onChange={(event) =>
                              updateRoleDraft((draft) => ({
                                ...draft,
                                access: event.target.value as PmPipelineAccess,
                              }))
                            }
                            className={SELECT_CLASS}
                          >
                            <option value="write">
                              {gt("Write (can edit files and run tools)")}
                            </option>
                            <option value="read-only">{gt("Read-only (review & analysis)")}</option>
                          </select>
                        </div>

                        <div className="space-y-1 sm:col-span-2">
                          <label
                            htmlFor="role-description"
                            className="text-xs font-medium text-foreground"
                          >
                            <T>Description</T>
                          </label>
                          <Input
                            id="role-description"
                            value={currentRoleDraft.description}
                            onChange={(event) =>
                              updateRoleDraft((draft) => ({
                                ...draft,
                                description: event.target.value,
                              }))
                            }
                            required
                          />
                        </div>

                        <div className="space-y-1">
                          <label
                            htmlFor="role-tier"
                            className="text-xs font-medium text-foreground"
                          >
                            <T>Default tier</T>
                          </label>
                          <select
                            id="role-tier"
                            value={currentRoleDraft.tier}
                            onChange={(event) =>
                              updateRoleDraft((draft) => ({
                                ...draft,
                                tier: event.target.value as PmPipelineTier,
                              }))
                            }
                            className={SELECT_CLASS}
                          >
                            <option value="small">{gt("Small (fast, low cost)")}</option>
                            <option value="mid">{gt("Mid (balanced coding)")}</option>
                            <option value="frontier">{gt("Frontier (deep reasoning)")}</option>
                          </select>
                        </div>

                        <div className="space-y-1">
                          <label
                            htmlFor="role-max-tier"
                            className="text-xs font-medium text-foreground"
                          >
                            <T>Max escalation tier</T>
                          </label>
                          <select
                            id="role-max-tier"
                            value={currentRoleDraft.maxTier}
                            onChange={(event) =>
                              updateRoleDraft((draft) => ({
                                ...draft,
                                maxTier: event.target.value as PmPipelineTier | "",
                              }))
                            }
                            className={SELECT_CLASS}
                          >
                            <option value="">{gt("Default (up to frontier)")}</option>
                            <option value="small">{gt("Small")}</option>
                            <option value="mid">{gt("Mid")}</option>
                            <option value="frontier">{gt("Frontier")}</option>
                          </select>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          id="role-multimodal"
                          type="checkbox"
                          checked={currentRoleDraft.multimodal}
                          onChange={(event) =>
                            updateRoleDraft((draft) => ({
                              ...draft,
                              multimodal: event.target.checked,
                            }))
                          }
                          className="size-4 rounded border-input accent-primary"
                        />
                        <label
                          htmlFor="role-multimodal"
                          className="text-xs font-medium text-foreground"
                        >
                          <T>Prefer multimodal models (screenshots, diagrams, UI inspection)</T>
                        </label>
                      </div>

                      <fieldset className="space-y-2.5 rounded-lg border border-border/80 bg-background/60 p-3.5">
                        <div className="flex items-center justify-between gap-2">
                          <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            <T>Assigned Model Candidates (optional override)</T>
                          </legend>
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            onClick={addModelCandidate}
                          >
                            <PlusIcon className="size-3" aria-hidden />
                            <T>Pin model</T>
                          </Button>
                        </div>

                        {currentRoleDraft.candidates.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            <T>
                              Automatic tier routing is active. Pin one or more provider models if
                              this role should always prefer specific models.
                            </T>
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {currentRoleDraft.candidates.map((candidate, index) => {
                              const matchingProvider = snapshot?.providers.find(
                                (provider) =>
                                  provider.driver === candidate.provider ||
                                  provider.instanceId === candidate.provider,
                              );
                              const providerModels = matchingProvider?.models ?? [];
                              const matchingModel = providerModels.find(
                                (model) => model.slug === candidate.model,
                              );
                              return (
                                <div
                                  key={candidate._key}
                                  className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.4fr_120px_auto]"
                                >
                                  <select
                                    aria-label={gt("Provider for model candidate {index}", {
                                      index: index + 1,
                                    })}
                                    value={candidate.provider}
                                    onChange={(event) => {
                                      const nextProvider = event.target.value;
                                      const nextProviderObj = snapshot?.providers.find(
                                        (p) =>
                                          p.driver === nextProvider ||
                                          p.instanceId === nextProvider,
                                      );
                                      const nextModel =
                                        nextProviderObj?.models[0]?.slug ?? candidate.model;
                                      updateRoleDraft((draft) => ({
                                        ...draft,
                                        candidates: draft.candidates.map((item) =>
                                          item._key === candidate._key
                                            ? {
                                                _key: item._key,
                                                provider: nextProvider,
                                                model: nextModel,
                                              }
                                            : item,
                                        ),
                                      }));
                                    }}
                                    className={SELECT_CLASS}
                                  >
                                    {(snapshot?.providers ?? []).map((provider) => (
                                      <option key={provider.instanceId} value={provider.driver}>
                                        {provider.displayName ?? provider.driver}
                                        {provider.enabled ? "" : ` (${gt("signed out")})`}
                                      </option>
                                    ))}
                                    {!(snapshot?.providers ?? []).some(
                                      (p) =>
                                        p.driver === candidate.provider ||
                                        p.instanceId === candidate.provider,
                                    ) ? (
                                      <option value={candidate.provider}>
                                        {candidate.provider}
                                      </option>
                                    ) : null}
                                  </select>

                                  {providerModels.length > 0 ? (
                                    <select
                                      aria-label={gt("Model for candidate {index}", {
                                        index: index + 1,
                                      })}
                                      value={candidate.model}
                                      onChange={(event) =>
                                        updateRoleDraft((draft) => ({
                                          ...draft,
                                          candidates: draft.candidates.map((item) =>
                                            item._key === candidate._key
                                              ? { ...item, model: event.target.value }
                                              : item,
                                          ),
                                        }))
                                      }
                                      className={SELECT_CLASS}
                                    >
                                      {providerModels.map((model) => (
                                        <option key={model.slug} value={model.slug}>
                                          {model.name} ({model.slug})
                                        </option>
                                      ))}
                                      {!providerModels.some(
                                        (model) => model.slug === candidate.model,
                                      ) ? (
                                        <option value={candidate.model}>{candidate.model}</option>
                                      ) : null}
                                    </select>
                                  ) : (
                                    <Input
                                      aria-label={gt("Model slug for candidate {index}", {
                                        index: index + 1,
                                      })}
                                      value={candidate.model}
                                      onChange={(event) =>
                                        updateRoleDraft((draft) => ({
                                          ...draft,
                                          candidates: draft.candidates.map((item) =>
                                            item._key === candidate._key
                                              ? { ...item, model: event.target.value }
                                              : item,
                                          ),
                                        }))
                                      }
                                    />
                                  )}

                                  <select
                                    aria-label={gt("Effort for candidate {index}", {
                                      index: index + 1,
                                    })}
                                    value={candidate.effort ?? ""}
                                    onChange={(event) =>
                                      updateRoleDraft((draft) => ({
                                        ...draft,
                                        candidates: draft.candidates.map((item) =>
                                          item._key === candidate._key
                                            ? {
                                                ...item,
                                                effort: event.target.value || undefined,
                                              }
                                            : item,
                                        ),
                                      }))
                                    }
                                    className={SELECT_CLASS}
                                  >
                                    <option value="">{gt("Default effort")}</option>
                                    {(matchingModel?.reasoningChoices.length
                                      ? matchingModel.reasoningChoices
                                      : ["low", "medium", "high"]
                                    ).map((choice) => (
                                      <option key={choice} value={choice}>
                                        {choice}
                                      </option>
                                    ))}
                                  </select>

                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={gt("Remove model candidate")}
                                    onClick={() =>
                                      updateRoleDraft((draft) => ({
                                        ...draft,
                                        candidates: draft.candidates.filter(
                                          (item) => item._key !== candidate._key,
                                        ),
                                      }))
                                    }
                                  >
                                    <Trash2Icon className="size-3.5" aria-hidden />
                                  </Button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </fieldset>

                      <fieldset className="space-y-2.5 rounded-lg border border-border/80 bg-background/60 p-3.5">
                        <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          <T>Attached Skills (loaded into Claude, Codex, and Antigravity)</T>
                        </legend>

                        {currentRoleDraft.skills.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {currentRoleDraft.skills.map((skill) => (
                              <button
                                key={skill}
                                type="button"
                                aria-pressed="true"
                                onClick={() => toggleRoleSkill(skill)}
                                className="inline-flex items-center gap-1 rounded-full border border-primary/50 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary transition hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                              >
                                {skill}
                                <span aria-hidden>×</span>
                              </button>
                            ))}
                          </div>
                        ) : null}

                        <div className="flex gap-2">
                          <Input
                            aria-label={gt("Attach custom skill name or markdown path")}
                            value={customSkillInput}
                            onChange={(event) => setCustomSkillInput(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                addCustomSkill();
                              }
                            }}
                            placeholder={gt("Add skill name or path (e.g. modern-web-guidance)")}
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={addCustomSkill}
                          >
                            <PlusIcon className="size-3.5" aria-hidden />
                            <T>Attach</T>
                          </Button>
                        </div>

                        {(snapshot?.discoveredSkills.length ?? 0) > 0 ? (
                          <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto pt-1">
                            {(snapshot?.discoveredSkills ?? []).map((skill) => {
                              const attached = currentRoleDraft.skills.includes(skill.name);
                              return (
                                <button
                                  key={`${skill.scope}:${skill.name}`}
                                  type="button"
                                  aria-pressed={attached}
                                  onClick={() => toggleRoleSkill(skill.name)}
                                  className={cn(
                                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                    attached
                                      ? "border-primary/60 bg-primary/15 text-primary"
                                      : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
                                  )}
                                >
                                  <span>{skill.name}</span>
                                  <span className="text-3xs opacity-70">{skill.scope}</span>
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                      </fieldset>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label
                            htmlFor="role-context-files"
                            className="text-xs font-medium text-foreground"
                          >
                            <T>Repository context files (one path per line)</T>
                          </label>
                          <textarea
                            id="role-context-files"
                            rows={3}
                            value={currentRoleDraft.contextFilesText}
                            onChange={(event) =>
                              updateRoleDraft((draft) => ({
                                ...draft,
                                contextFilesText: event.target.value,
                              }))
                            }
                            placeholder={gt("AGENTS.md\ndocs/architecture.md")}
                            className={cn(TEXTAREA_CLASS, "font-mono text-xs")}
                          />
                        </div>

                        <div className="space-y-1">
                          <label
                            htmlFor="role-output-contract"
                            className="text-xs font-medium text-foreground"
                          >
                            <T>Output contract</T>
                          </label>
                          <textarea
                            id="role-output-contract"
                            rows={3}
                            value={currentRoleDraft.outputContract}
                            onChange={(event) =>
                              updateRoleDraft((draft) => ({
                                ...draft,
                                outputContract: event.target.value,
                              }))
                            }
                            placeholder={gt(
                              "e.g. End with PASS or FAIL and list verification commands.",
                            )}
                            className={TEXTAREA_CLASS}
                          />
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label
                          htmlFor="role-toolkits"
                          className="text-xs font-medium text-foreground"
                        >
                          <T>Toolkits (comma-separated, optional)</T>
                        </label>
                        <Input
                          id="role-toolkits"
                          value={currentRoleDraft.toolkitsText}
                          onChange={(event) =>
                            updateRoleDraft((draft) => ({
                              ...draft,
                              toolkitsText: event.target.value,
                            }))
                          }
                          placeholder={gt("git, browser, tests")}
                        />
                      </div>

                      <div className="space-y-1">
                        <label
                          htmlFor="role-instructions"
                          className="text-xs font-medium text-foreground"
                        >
                          <T>Role system prompt & instructions</T>
                        </label>
                        <textarea
                          id="role-instructions"
                          rows={6}
                          value={currentRoleDraft.instructions}
                          onChange={(event) =>
                            updateRoleDraft((draft) => ({
                              ...draft,
                              instructions: event.target.value,
                            }))
                          }
                          placeholder={gt(
                            "Standing rules and playbook injected whenever this role runs...",
                          )}
                          className={TEXTAREA_CLASS}
                        />
                      </div>
                    </form>
                  ) : null}
                </section>
              </div>
            ) : null}

            {activeTab === "skills" ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="w-full max-w-sm">
                    <label htmlFor="skills-search" className="sr-only">
                      <T>Filter discovered skills</T>
                    </label>
                    <input
                      id="skills-search"
                      type="search"
                      value={skillFilter}
                      onChange={(event) => setSkillFilter(event.target.value)}
                      placeholder={gt("Filter skills by name, scope, or path...")}
                      className={INPUT_CLASS}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <T>
                      Scanned from .pipelines/skills, .agents/skills, .claude/skills, ~/.gemini, and
                      installed plugins.
                    </T>
                  </p>
                </div>

                {filteredSkills.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                    <T>No matching SKILL.md files found.</T>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                    {filteredSkills.map((skill) => {
                      const usedByRoles = (snapshot?.roles ?? [])
                        .filter((entry) => entry.role.skills?.includes(skill.name))
                        .map((entry) => entry.role.name);
                      return (
                        <div
                          key={`${skill.scope}:${skill.name}`}
                          className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {skill.name}
                            </span>
                            <Badge variant="outline" size="sm">
                              {skill.scope}
                            </Badge>
                          </div>
                          <p className="truncate font-mono text-2xs text-muted-foreground">
                            {skill.path}
                          </p>
                          <div className="flex flex-wrap items-center gap-1 pt-1">
                            {usedByRoles.length > 0 ? (
                              usedByRoles.map((roleName) => (
                                <Badge key={roleName} variant="secondary" size="sm">
                                  {roleName}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-2xs text-muted-foreground">
                                <T>Available to attach to any role or thread</T>
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}

            {activeTab === "runs" && activeEnvironmentId && activeProjectId ? (
              <StudioLiveRunsTab
                environmentId={activeEnvironmentId}
                projectId={activeProjectId}
                snapshot={snapshot}
              />
            ) : null}

            {activeTab === "arena" && activeEnvironmentId && activeProjectId ? (
              <StudioArenaTab
                environmentId={activeEnvironmentId}
                projectId={activeProjectId}
                snapshot={snapshot}
              />
            ) : null}

            {activeTab === "verify" && activeEnvironmentId && activeProjectId ? (
              <StudioVerifyTab environmentId={activeEnvironmentId} projectId={activeProjectId} />
            ) : null}

            {activeTab === "learnings" && activeEnvironmentId && activeProjectId ? (
              <StudioLearningsTab
                environmentId={activeEnvironmentId}
                projectId={activeProjectId}
                snapshot={snapshot}
                onAppliedRoleChange={() => snapshotQuery.refresh()}
              />
            ) : null}
          </>
        )}
      </WorkspacePageContainer>
    </ScrollArea>
  );
}
