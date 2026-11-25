// t3code-pm: the notice once an app update has downloaded, with Restart beside Later.
import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { msg } from "gt-react";

import {
  getDesktopUpdateActionError,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateInstallConfirmationMessage,
} from "../components/desktopUpdate.logic";
import { toastManager } from "../components/ui/toast";
import { stackedThreadToast } from "../components/ui/toastHelpers";
import { m } from "../i18n/messages";
import { ensureLocalApi } from "../localApi";

type UpdateShell = Pick<DesktopBridge, "installUpdate">;

/** Upstream's notice says to restart from the update button; PM3code's restarts from the notice. */
export const PM_UPDATE_READY_NOTICE = true;

const reportInstallError = (description: string) =>
  toastManager.add(
    stackedThreadToast({ type: "error", title: m(msg("Could not install update")), description }),
  );

async function restartToUpdate(bridge: UpdateShell, state: DesktopUpdateState): Promise<void> {
  if (
    !(await ensureLocalApi().dialogs.confirm(getDesktopUpdateInstallConfirmationMessage(state)))
  ) {
    return;
  }
  try {
    const result = await bridge.installUpdate(state.downloadedVersion ?? undefined);
    const error = getDesktopUpdateActionError(result);
    if (error) reportInstallError(error);
  } catch (error) {
    reportInstallError(error instanceof Error ? error.message : m(msg("Install failed.")));
  }
}

export function showPmUpdateReadyToast(
  bridge: UpdateShell,
  state: DesktopUpdateState,
  openReleaseNotes: (() => void) | null,
): void {
  const version = getDesktopUpdateDownloadedVersion(state);
  const toastId = toastManager.add({
    type: "success",
    title: version
      ? m(msg("PM3code {version} is ready", { version }))
      : m(msg("A PM3code update is ready")),
    description: m(msg("Restart to update.")),
    // It waits for the user: Later or the close button dismisses it, the sidebar keeps the update.
    timeout: 0,
    actionProps: {
      children: m(msg("Restart")),
      onClick: () => {
        toastManager.close(toastId);
        void restartToUpdate(bridge, state);
      },
    },
    data: {
      hideCopyButton: true,
      actionLayout: "stacked-end",
      secondaryActionVariant: "ghost",
      ...(openReleaseNotes
        ? {
            additionalActions: [
              {
                id: "whats-new",
                props: { children: m(msg("What's new")), onClick: openReleaseNotes },
              },
            ],
          }
        : {}),
      secondaryActionProps: {
        children: m(msg("Later")),
        onClick: () => toastManager.close(toastId),
      },
    },
  });
}
