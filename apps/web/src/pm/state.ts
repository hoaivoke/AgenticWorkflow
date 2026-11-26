import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type PmThreadDetail,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { asPmIndex, createPmClient, type PmIndex, pmKey } from "@t3tools/pm/client";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "../state/presentation";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";

export { pmKey };

const pmClient = createPmClient(connectionAtomRuntime, environmentPresentations.serverConfigsAtom);

export const {
  settingsQuery: pmSettingsQuery,
  t3StatusQuery: pmT3StatusQuery,
  commands: pmCommands,
  indexAtom: pmIndexAtom,
} = pmClient;
const pmThreadDetail = pmClient.threadDetail;
const pmSwarmBoardQuery = pmClient.swarmBoard;
const pmPipelinesSnapshotQuery = pmClient.pipelinesSnapshot;
const pmThreadHarnessQuery = pmClient.threadHarness;
const pmPipelineRunsQuery = pmClient.pipelineRuns;
const pmEvalRunsQuery = pmClient.evalRuns;
const pmLearningsQuery = pmClient.learnings;

/** Upstream tests that mock `useAtomValue` hand back their own values; those read as no PMs. */
export const usePmIndex = (): PmIndex => asPmIndex(useAtomValue(pmIndexAtom));

export function usePmSummary(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | string | null,
) {
  const index = usePmIndex();
  if (environmentId === null || threadId === null) return null;
  return index.pms.get(pmKey(environmentId, threadId)) ?? null;
}

/** Full detail of one open PM, subscribed only while a PM view shows it. */
export function usePmThreadDetail(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | string | null,
  enabled = true,
): PmThreadDetail | null {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const query = useEnvironmentQuery(
    environmentId === null || threadId === null || !enabled || !canRead
      ? null
      : pmThreadDetail({ environmentId, input: { pm: threadId as ThreadId } }),
  );
  return query.data ?? null;
}

/** Shared Swarm board for either the coordinator thread or one of its member threads. */
export function useSwarmBoard(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | string | null,
  enabled = true,
) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return useEnvironmentQuery(
    environmentId === null || threadId === null || !enabled || !canRead
      ? null
      : pmSwarmBoardQuery({ environmentId, input: { threadId: threadId as ThreadId } }),
  );
}

/** Project roles, pipelines, live providers and discovered skills for Pipelines Studio and composer picker. */
export function usePipelinesSnapshot(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | string | null,
  enabled = true,
) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return useEnvironmentQuery(
    environmentId === null || projectId === null || !enabled || !canRead
      ? null
      : pmPipelinesSnapshotQuery({ environmentId, input: { projectId: projectId as ProjectId } }),
  );
}

/** Active unified role/harness and live tracked skills/context files for a thread. */
export function useThreadHarness(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | string | null,
  enabled = true,
) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return useEnvironmentQuery(
    environmentId === null || threadId === null || !enabled || !canRead
      ? null
      : pmThreadHarnessQuery({ environmentId, input: { threadId: threadId as ThreadId } }),
  );
}

/** Tracked live pipeline execution runs (stages, token cost, savings, budget caps). */
export function usePipelineRuns(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | string | null,
  enabled = true,
) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return useEnvironmentQuery(
    environmentId === null || projectId === null || !enabled || !canRead
      ? null
      : pmPipelineRunsQuery({ environmentId, input: { projectId: projectId as ProjectId } }),
  );
}

/** A/B Eval Arena runs comparing raw single-model baseline vs pipeline treatment. */
export function useEvalRuns(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | string | null,
  enabled = true,
) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return useEnvironmentQuery(
    environmentId === null || projectId === null || !enabled || !canRead
      ? null
      : pmEvalRunsQuery({ environmentId, input: { projectId: projectId as ProjectId } }),
  );
}

/** Self-improving harness lessons proposed by reviewers/PMs or applied to role YAMLs. */
export function useHarnessLearnings(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | string | null,
  enabled = true,
) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return useEnvironmentQuery(
    environmentId === null || projectId === null || !enabled || !canRead
      ? null
      : pmLearningsQuery({ environmentId, input: { projectId: projectId as ProjectId } }),
  );
}
