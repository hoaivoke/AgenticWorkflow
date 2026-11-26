// t3code-pm: PM3code's phone app is an Android APK on its GitHub releases page; there is no iOS build
// yet, so the store buttons become one Android download.
import { msg } from "gt-react";

import { MOBILE_APP_URL } from "../branding";

interface PhoneStore {
  readonly label: string;
  readonly store: string;
  readonly url: string;
}

export const pmPhoneStores = <S extends PhoneStore>(upstream: ReadonlyArray<S>): ReadonlyArray<S> =>
  upstream
    .filter((store) => store.store === "Google Play")
    .map((store) => ({
      ...store,
      label: msg("Android APK"),
      store: "GitHub Releases",
      url: MOBILE_APP_URL,
    }));

/** Upstream copy PM3code replaces outright, keyed by its English source. */
export const PM_COPY_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ["T3 Code app for iPhone and Android", msg("Agent Space Android app (APK) on GitHub Releases")],
]);
