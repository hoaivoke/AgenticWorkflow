// t3code-pm: the fork app's identity, so its APK installs beside the official T3 Code.
export const PM_APP_IDENTITY = {
  appName: "Agent Space",
  scheme: "t3code-pm",
  iosBundleIdentifier: "com.t3codepm.app",
  androidPackage: "com.t3codepm.app",
  /** Raise for every APK release; Android refuses to update over an equal or higher one. */
  androidVersionCode: 6,
} as const;
