import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { PM_PLAYBOOK } from "@t3tools/pm";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { BookOpenIcon } from "lucide-react";
import { useState } from "react";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { runPmCommand } from "./actions";
import { pmCommands, pmSettingsQuery } from "./state";
import { T3ImportSection } from "./T3ImportSection";

/** Whether PMs can start workers on the user's other computers: upstream's Linked environments. */
function PmOtherComputersRow(props: { readonly linked: boolean }) {
  const gt = useGT();
  return (
    <SettingsRow
      title={gt("Workers on other computers")}
      description={
        props.linked ? (
          <T>
            On. A PM can start workers on computers you linked in{" "}
            <Link to="/settings/connections" className="underline underline-offset-2">
              Environments
            </Link>
            , by your rules and by each computer's load and usage left.
          </T>
        ) : (
          <T>
            Off. Turn on Linked environments in{" "}
            <Link to="/settings/labs" className="underline underline-offset-2">
              Labs
            </Link>{" "}
            here and on the other computer, then link them in{" "}
            <Link to="/settings/connections" className="underline underline-offset-2">
              Environments
            </Link>
            .
          </T>
        )
      }
    />
  );
}

/** Settings, Project managers: the switch and the playbook overrides every PM follows. */
export function PmSettingsPanel() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const primary = usePrimaryEnvironment();
  const environmentId = primary?.environmentId ?? null;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const query = useEnvironmentQuery(
    environmentId === null ? null : pmSettingsQuery({ environmentId, input: {} }),
  );
  const settings = query.data;
  const [overrides, setOverrides] = useState<string | null>(null);
  const [playbookOpen, setPlaybookOpen] = useState(false);
  const save = async (input: {
    readonly enabled?: boolean;
    readonly playbookOverrides?: ReadonlyArray<string>;
  }) => {
    if (environmentId === null) return;
    const saved = await runPmCommand(
      pmCommands.settingsSet,
      { environmentId, input },
      gt("Could not save the setting"),
    );
    if (saved !== null) query.refresh();
  };
  const overridesText = overrides ?? settings?.playbookOverrides.join("\n") ?? "";
  const linkedOn = primary?.serverConfig?.settings.linkedEnvironmentsEnabled === true;
  return (
    <SettingsPageContainer>
      <SettingsSection id="project-managers" title={gt("Project managers")}>
        <SettingsRow
          {...searchableSetting("project-managers")}
          description={gt(
            "Adds Project Manager threads: they plan work in a project, start worker threads and follow them. Turning it off hides every PM view, tool and watcher; PM threads show as normal threads, and nothing is deleted.",
          )}
          control={
            <Switch
              checked={settings?.enabled ?? false}
              disabled={settings === null || !canWrite}
              onCheckedChange={(checked) => void save({ enabled: Boolean(checked) })}
              aria-label={gt("Project Managers (PM3code)")}
            />
          }
        />
        <PmOtherComputersRow linked={linkedOn} />
      </SettingsSection>
      <SettingsSection id="pm-playbook" title={gt("Playbook")}>
        <SettingsRow
          title={gt("Shipped playbook")}
          description={gt(
            "Version {version}. Every PM reads it when it starts, after a compaction, and when the version goes up.",
            { version: settings?.playbookVersion ?? 1 },
          )}
          control={
            <Button size="compact" variant="outline" onClick={() => setPlaybookOpen(true)}>
              <BookOpenIcon />
              {gt("View")}
            </Button>
          }
        />
        <SettingsRow
          {...searchableSetting("pm-playbook-overrides")}
          description={gt(
            "Rules added after the playbook for every PM, one per line. A PM's own standing instructions come after these.",
          )}
        >
          <div className="mt-2 flex flex-col gap-2">
            <Textarea
              value={overridesText}
              disabled={settings === null || !canWrite}
              aria-label={gt("Playbook overrides")}
              placeholder={gt("Brief workers in English, reply to me in short sections.")}
              onChange={(event) => setOverrides(event.target.value)}
            />
            <div className="flex justify-end">
              <Button
                size="compact"
                disabled={overrides === null || !canWrite}
                onClick={() =>
                  void save({
                    playbookOverrides: overridesText
                      .split("\n")
                      .filter((rule) => rule.trim().length > 0),
                  }).then(() => setOverrides(null))
                }
              >
                {gt("Save overrides")}
              </Button>
            </div>
          </div>
        </SettingsRow>
      </SettingsSection>
      <T3ImportSection environmentId={environmentId} canWrite={canWrite} />
      <Dialog open={playbookOpen} onOpenChange={setPlaybookOpen}>
        <DialogPopup className="max-h-[80dvh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{gt("PM playbook")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <pre className="whitespace-pre-wrap text-xs leading-relaxed">{PM_PLAYBOOK}</pre>
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => setPlaybookOpen(false)}>{gt("Done")}</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}
