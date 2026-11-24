// t3code-pm: PM3code ships on its own GitHub releases, and its server version is T3 Code's base
// version, so "Check for updates" opens those releases instead of comparing against T3's.
import { tryOpenExternalUrl } from "../lib/openExternalUrl";

export const PM_RELEASES_URL = "https://github.com/maddada/pm3code/releases";

/** Always handles the check, so callers stop before looking up T3's releases. */
export const openPmReleases = (): true => {
  void tryOpenExternalUrl(PM_RELEASES_URL);
  return true;
};
