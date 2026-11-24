import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type PmT3ImportMode,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Alert } from "react-native";

import { ListActionRow } from "../components/ui/ListActionRow";
import { ListToggleRow } from "../components/ui/ListToggleRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { useEnvironmentServerConfig } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { runPm } from "./actions";
import { pmCommands, pmSettingsQuery, pmT3StatusQuery } from "./state";

/** The environment's PM switch. Off hides every PM view; nothing is deleted. */
export function PmSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const config = useEnvironmentServerConfig(props.environmentId);
  const served = config?.environment.capabilities.pm === true;
  const query = useEnvironmentQuery(
    served ? pmSettingsQuery({ environmentId: props.environmentId, input: {} }) : null,
  );
  if (!served || query.data === null) return null;
  return (
    <>
      <PmSettingsSwitch environmentId={props.environmentId} enabled={query.data.enabled} />
      <PmT3ImportSection environmentId={props.environmentId} />
    </>
  );
}

function PmSettingsSwitch(props: {
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    pmSettingsQuery({ environmentId: props.environmentId, input: {} }),
  );
  return (
    <SettingsSection
      title={gt("Project managers")}
      footer={gt(
        "Off hides PM views, tools and watchers on this environment. PM threads stay as normal threads and nothing is deleted.",
      )}
    >
      <ListToggleRow
        icon="list.number"
        label={gt("Project managers (PM3code)")}
        value={props.enabled}
        onValueChange={async (enabled) => {
          const saved = await runPm(
            pmCommands.settingsSet,
            { environmentId: props.environmentId, input: { enabled } },
            gt("Could not save the setting"),
          );
          if (saved !== null) query.refresh();
        }}
      />
    </SettingsSection>
  );
}

/** Import from T3 Code, run on the environment's own computer. */
function PmT3ImportSection(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const query = useEnvironmentQuery(
    canWrite ? pmT3StatusQuery({ environmentId: props.environmentId, input: {} }) : null,
  );
  const [running, setRunning] = useState<PmT3ImportMode | null>(null);
  const status = query.data;
  if (!canWrite || status === null) return null;
  const source = status.source;
  const run = async (mode: PmT3ImportMode) => {
    setRunning(mode);
    const result = await runPm(
      pmCommands.t3Import,
      { environmentId: props.environmentId, input: { mode } },
      mode === "replace" ? gt("Could not replace the threads") : gt("Could not import the threads"),
    );
    setRunning(null);
    query.refresh();
    if (result === null) return;
    const skipped =
      result.skippedRunning +
      result.skippedAlreadyImported +
      result.skippedNoProject +
      result.skippedConflicts;
    Alert.alert(
      gt("Import finished"),
      [
        gt(
          "Before: {pmBefore} threads here, {t3} in T3 Code. After: {pmAfter} threads here. Imported {imported}, removed {removed}, skipped {skipped}.",
          {
            pmBefore: result.before.pmThreads,
            t3: result.before.t3Threads,
            pmAfter: result.after.pmThreads,
            imported: result.imported,
            removed: result.removed,
            skipped,
          },
        ),
        result.backupPath === null
          ? null
          : gt(
              "Backup: {path}. To put it back, quit PM3code, copy it over statev2.sqlite in the userdata folder above it, delete statev2.sqlite-wal and statev2.sqlite-shm beside it, then start PM3code.",
              { path: result.backupPath },
            ),
      ]
        .filter((line) => line !== null)
        .join("\n\n"),
    );
  };
  const confirmReplace = () =>
    Alert.alert(
      gt("Replace PM3code's threads?"),
      gt(
        "PM3code's {pmThreads} threads, with their PMs, items and asks, are removed, and T3 Code's {threads} threads are copied in. A backup is saved first.",
        { pmThreads: status.pmThreads, threads: source?.threads ?? 0 },
      ),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: gt("Back up and replace"),
          style: "destructive",
          onPress: () => void run("replace"),
        },
      ],
    );
  const blocked = running !== null || source === null || source.newer;
  return (
    <SettingsSection
      title={gt("Import from T3 Code")}
      footer={
        source === null
          ? gt("T3 Code was not found on this computer.")
          : source.newer
            ? gt(
                "T3 Code's database is newer than this PM3code understands. Update PM3code, then import.",
              )
            : gt(
                "T3 Code ({home}): {threads} threads in {projects} projects. PM3code: {pmThreads} threads, {imported} of them imported.",
                {
                  home: source.home,
                  threads: source.threads,
                  projects: source.projects,
                  pmThreads: status.pmThreads,
                  imported: status.importedThreads,
                },
              )
      }
    >
      <ListToggleRow
        icon="arrow.clockwise"
        label={gt("Follow T3 Code on each launch")}
        value={status.syncEnabled}
        onValueChange={async (enabled) => {
          const saved = await runPm(
            pmCommands.t3SetSync,
            { environmentId: props.environmentId, input: { enabled } },
            gt("Could not save the setting"),
          );
          if (saved !== null) query.refresh();
        }}
      />
      <ListActionRow
        icon="tray.and.arrow.down"
        label={gt("Import threads")}
        disabled={blocked}
        loading={running === "import"}
        onPress={() => void run("import")}
      />
      <ListActionRow
        icon="arrow.left.arrow.right"
        tone="danger"
        label={gt("Replace threads…")}
        disabled={blocked}
        loading={running === "replace"}
        onPress={confirmReplace}
      />
    </SettingsSection>
  );
}
