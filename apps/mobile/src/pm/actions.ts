import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type AtomCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { msg } from "gt-react-native";
import { Alert } from "react-native";

import { m } from "../i18n/messages";
import { appAtomRegistry } from "../state/atom-registry";
import { pmCommands } from "./state";

/** Runs a PM command and alerts its failure; returns the value or null. */
export async function runPm<W, A, E>(
  command: AtomCommand<W, A, E>,
  value: W,
  failureTitle: string,
): Promise<A | null> {
  const result = await runAtomCommand(appAtomRegistry, command, value, { label: command.label });
  if (result._tag === "Success") return result.value;
  if (!isAtomCommandInterrupted(result))
    Alert.alert(failureTitle, thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined);
  return null;
}

/** New PM: no dialog. It starts on the last model picked and opens the new PM's chat. */
export async function createPm(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  open: (target: { readonly environmentId: string; readonly threadId: string }) => void,
) {
  const created = await runPm(
    pmCommands.create,
    { environmentId, input: { projectId } },
    m(msg("Could not create the project manager")),
  );
  if (created !== null) open({ environmentId, threadId: created.threadId });
}

/** Make this a PM: the same thread, from its next turn on with the PM role and tools. */
export async function convertToPm(environmentId: EnvironmentId, threadId: ThreadId) {
  const done = await runPm(
    pmCommands.convert,
    { environmentId, input: { threadId } },
    m(msg("Could not make this thread a PM")),
  );
  if (done !== null)
    Alert.alert(
      m(msg("This thread is now a PM")),
      m(msg("Its next turn starts with the PM playbook and tools.")),
    );
}

/** Back to a normal thread. Its items stay for a return; its idle workers are let go. */
export async function revertPm(environmentId: EnvironmentId, pm: ThreadId) {
  const done = await runPm(
    pmCommands.revert,
    { environmentId, input: { pm } },
    m(msg("Could not turn this PM back into a normal thread")),
  );
  if (done !== null)
    Alert.alert(
      m(msg("This is a normal thread again")),
      m(msg("Its items are kept. Make it a PM again to pick them back up.")),
    );
}
