// t3code-pm: the fork app's identity, so its APK installs beside the official T3 Code.
export const PM_APP_IDENTITY = {
  appName: "T3 Code PM",
  scheme: "t3code-pm",
  iosBundleIdentifier: "com.t3codepm.app",
  androidPackage: "com.t3codepm.app",
  /** Raise for every APK release; Android refuses to update over an equal or higher one. */
  androidVersionCode: 2,
} as const;
