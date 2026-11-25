// t3code-pm: Settings, Updates: whether the desktop app looks for new PM3code releases on its own.
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { SettingResetButton, SettingsRow } from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Switch } from "../components/ui/switch";

export function PmAppUpdateChecksRow() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (typeof window === "undefined" || !window.desktopBridge) return null;
  const isDefault =
    settings.pmAutomaticAppUpdateChecks === DEFAULT_CLIENT_SETTINGS.pmAutomaticAppUpdateChecks;
  return (
    <SettingsRow
      {...setting("pm-app-update-checks")}
      description={gt(
        "Check PM3code's GitHub releases for a new version at launch and every four hours. When off, it checks only when you choose Check for Updates.",
      )}
      resetAction={
        isDefault ? null : (
          <SettingResetButton
            ariaLabel={gt("Reset app update checks to default")}
            onClick={() =>
              updateSettings({
                pmAutomaticAppUpdateChecks: DEFAULT_CLIENT_SETTINGS.pmAutomaticAppUpdateChecks,
              })
            }
          />
        )
      }
      control={
        <Switch
          checked={settings.pmAutomaticAppUpdateChecks}
          onCheckedChange={(checked) =>
            updateSettings({ pmAutomaticAppUpdateChecks: Boolean(checked) })
          }
          aria-label={gt("Check for app updates automatically")}
        />
      }
    />
  );
}
