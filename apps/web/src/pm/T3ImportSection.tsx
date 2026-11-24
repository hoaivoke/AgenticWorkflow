import type { EnvironmentId, PmT3ImportMode, PmT3ImportResult } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ArrowLeftRightIcon, ImportIcon } from "lucide-react";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Switch } from "../components/ui/switch";
import { useEnvironmentQuery } from "../state/query";
import { runPmCommand } from "./actions";
import { pmCommands, pmT3StatusQuery } from "./state";

/** Settings, Import from T3 Code: the launch read's switch, and whole-thread import or replace. */
export function T3ImportSection(props: {
  readonly environmentId: EnvironmentId | null;
  readonly canWrite: boolean;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { environmentId, canWrite } = props;
  const query = useEnvironmentQuery(
    environmentId === null || !canWrite ? null : pmT3StatusQuery({ environmentId, input: {} }),
  );
  const status = query.data;
  const [running, setRunning] = useState<PmT3ImportMode | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [result, setResult] = useState<PmT3ImportResult | null>(null);

  const setSync = async (enabled: boolean) => {
    if (environmentId === null) return;
    const saved = await runPmCommand(
      pmCommands.t3SetSync,
      { environmentId, input: { enabled } },
      gt("Could not save the setting"),
    );
    if (saved !== null) query.refresh();
  };
  const run = async (mode: PmT3ImportMode) => {
    if (environmentId === null) return;
    setConfirmReplace(false);
    setRunning(mode);
    const done = await runPmCommand(
      pmCommands.t3Import,
      { environmentId, input: { mode } },
      mode === "replace" ? gt("Could not replace the threads") : gt("Could not import the threads"),
    );
    setRunning(null);
    if (done !== null) setResult(done);
    query.refresh();
  };

  const source = status?.source ?? null;
  const last = status?.lastLaunch ?? null;
  const lastLine =
    last === null
      ? null
      : last.skipped !== null
        ? gt("Last launch: T3 Code was not found, nothing was read.")
        : gt("Last launch: {projects} projects added, {settings} settings updated.", {
            projects: last.projectsAdded,
            settings: last.settingsChanged,
          });
  const sourceLine =
    status == null
      ? null
      : source === null
        ? gt("T3 Code was not found on this computer.")
        : gt(
            "T3 Code ({home}): {threads} threads in {projects} projects. PM3code: {pmThreads} threads, {imported} of them imported.",
            {
              home: source.home,
              threads: source.threads,
              projects: source.projects,
              pmThreads: status.pmThreads,
              imported: status.importedThreads,
            },
          );
  const blocked = !canWrite || running !== null || source === null || source.newer;

  return (
    <SettingsSection id="pm-t3-import" title={gt("Import from T3 Code")}>
      <SettingsRow
        {...searchableSetting("pm-t3-import")}
        title={gt("Follow T3 Code on each launch")}
        description={
          <>
            {gt(
              "Each launch adds T3 Code's new projects and copies the settings you have not changed here. It reads a copy, so T3 Code's own files are never changed.",
            )}
            {lastLine === null ? null : (
              <span className="mt-1 block text-muted-foreground">{lastLine}</span>
            )}
          </>
        }
        control={
          <Switch
            checked={status?.syncEnabled ?? false}
            disabled={status == null || !canWrite}
            onCheckedChange={(checked) => void setSync(Boolean(checked))}
            aria-label={gt("Follow T3 Code on each launch")}
          />
        }
      />
      <SettingsRow
        title={gt("Threads")}
        description={
          <>
            {gt(
              "Import copies T3 Code's threads in full and puts them beside yours. Replace removes PM3code's threads first, after a backup. Threads running in T3 Code are left out.",
            )}
            {sourceLine === null ? null : <span className="mt-1 block">{sourceLine}</span>}
            {source?.newer === true ? (
              <span className="mt-1 block text-destructive-foreground">
                {gt(
                  "T3 Code's database is newer than this PM3code understands. Update PM3code, then import.",
                )}
              </span>
            ) : null}
          </>
        }
        control={
          <div className="flex gap-2">
            <Button
              size="compact"
              variant="outline"
              disabled={blocked}
              onClick={() => void run("import")}
            >
              <ImportIcon />
              {running === "import" ? gt("Importing…") : gt("Import threads")}
            </Button>
            <Button
              size="compact"
              variant="destructive-outline"
              disabled={blocked}
              onClick={() => setConfirmReplace(true)}
            >
              <ArrowLeftRightIcon />
              {running === "replace" ? gt("Replacing…") : gt("Replace threads…")}
            </Button>
          </div>
        }
      />
      {result === null ? null : (
        <SettingsRow title={gt("Last import")} description={<ImportResultText result={result} />} />
      )}
      <Dialog open={confirmReplace} onOpenChange={setConfirmReplace}>
        <DialogPopup className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{gt("Replace PM3code's threads?")}</DialogTitle>
            <DialogDescription>
              {gt(
                "PM3code's {pmThreads} threads, with their PMs, items and asks, are removed, and T3 Code's {threads} threads are copied in. Projects and settings stay.",
                { pmThreads: status?.pmThreads ?? 0, threads: source?.threads ?? 0 },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <p className="text-sm">
              {gt(
                "A backup of PM3code's database is saved first. The result shows where it is and how to put it back.",
              )}
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmReplace(false)}>
              {gt("Cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void run("replace")}>
              {gt("Back up and replace")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}

function ImportResultText({ result }: { readonly result: PmT3ImportResult }) {
  const gt = useGT();
  const skipped =
    result.skippedRunning +
    result.skippedAlreadyImported +
    result.skippedNoProject +
    result.skippedConflicts;
  return (
    <span className="flex flex-col gap-1">
      <span>
        {gt(
          "Before: {pmBefore} threads here, {t3} in T3 Code. After: {pmAfter} threads here. Imported {imported}, removed {removed}, skipped {skipped}.",
          {
            pmBefore: result.before.pmThreads,
            t3: result.before.t3Threads,
            pmAfter: result.after.pmThreads,
            imported: result.imported,
            removed: result.removed,
            skipped,
          },
        )}
      </span>
      {skipped > 0 ? (
        <span className="text-muted-foreground">
          {gt(
            "Skipped: {running} running in T3 Code, {already} imported before, {noProject} without a project, {conflicts} that failed.",
            {
              running: result.skippedRunning,
              already: result.skippedAlreadyImported,
              noProject: result.skippedNoProject,
              conflicts: result.skippedConflicts,
            },
          )}
        </span>
      ) : null}
      {result.backupPath === null ? null : (
        <span>
          {gt(
            "Backup: {path}. To put it back, quit PM3code, copy it over statev2.sqlite in the userdata folder above it, delete statev2.sqlite-wal and statev2.sqlite-shm beside it, then start PM3code.",
            { path: result.backupPath },
          )}
        </span>
      )}
    </span>
  );
}
