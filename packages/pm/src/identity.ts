// t3code-pm: the fork desktop app's identity, so it installs and runs beside official T3 Code.
export const PM_DESKTOP_IDENTITY = {
  appId: "com.t3codepm.desktop",
  baseName: "PM3code",
  productName: "PM3code",
  scheme: "t3code-pm",
  devScheme: "t3code-pm-dev",
  /** Electron profile folders, with no legacy folder to migrate from. Separate folders also
   * separate the single-instance lock. */
  userDataNames: {
    development: { current: "t3code-pm-dev", legacy: "t3code-pm-dev" },
    production: { current: "t3code-pm", legacy: "t3code-pm" },
  },
  /** The shell command, so it never takes over the official app's `t3`. */
  cliName: "t3-pm",
  linuxExecutableName: "t3code-pm",
  linuxWindowClass: "com.t3codepm.T3CodePM",
  /** The data home variable. `T3CODE_HOME` is official T3 Code's and may name someone's real data. */
  homeEnv: "T3CODE_PM_HOME",
  /** `t3-pm service install` names, so it never replaces or removes the official `t3` service. */
  service: {
    /** The systemd unit, the Task Scheduler task prefix, its XML copy and its folder. */
    name: "t3code-pm",
    launchdLabel: "com.t3codepm.service",
    protectDropIn: "90-t3code-pm-protect.conf",
  },
} as const;

declare const __T3CODE_PM_DESKTOP_IDENTITY__: boolean | undefined;

/**
 * The desktop and server bundles define this (apps/{desktop,server}/vite.config.ts); Vitest runs without the bundler,
 * so upstream's tests keep pinning upstream's identity while every fork build uses ours.
 */
const identityOn =
  typeof __T3CODE_PM_DESKTOP_IDENTITY__ !== "undefined" && __T3CODE_PM_DESKTOP_IDENTITY__ === true;

/** The fork's value in a fork desktop bundle, upstream's otherwise. */
export const pmDesktop = <T>(fork: T, upstream: T): T => (identityOn ? fork : upstream);

/** Desktop window origins the server trusts: the official app's, so it can still connect, and ours. */
export const PM_TRUSTED_DESKTOP_ORIGINS = [
  "t3code://app",
  "t3code-dev://app",
  `${PM_DESKTOP_IDENTITY.scheme}://app`,
  `${PM_DESKTOP_IDENTITY.devScheme}://app`,
] as const;

const UPSTREAM_APP_NAME = /\bT3 (Code|server|desktop|home)/g;
/** `t3 …` in code spans, so `t3 connect link` is caught where the bare form below skips it. */
const UPSTREAM_COMMAND_CODE = /`t3(?=[ `])/g;
/**
 * The bare word: not `t3@1.2`, `t3code`, `t3/branch`, `mcp__t3__`, an MCP server named in
 * `--transport http t3 {url}`, or the "t3 connect" and "t3 chat" search terms for T3's services.
 */
const UPSTREAM_COMMAND = /(?<![\w./@`-])(?<!http )t3(?![\w/@-]|\.\w| connect\b| chat\b)/g;
const UPSTREAM_HOME_ENV = /\bT3CODE_HOME\b/g;

const pmCommandName = (text: string): string => {
  if (!text.includes("t3")) return text;
  const coded = text.replace(UPSTREAM_COMMAND_CODE, `\`${PM_DESKTOP_IDENTITY.cliName}`);
  // "t3 or t3/ produces t3/add-search" is a branch prefix example, not the command.
  return text.includes("t3/")
    ? coded
    : coded.replace(UPSTREAM_COMMAND, PM_DESKTOP_IDENTITY.cliName);
};

/**
 * Upstream copy calls this app "T3 Code" (and its "T3 server"), its command `t3` and its home
 * variable T3CODE_HOME; every PM3code surface shows its own instead. Applied where text is
 * resolved for display, so upstream's strings and translation keys stay untouched. "T3 Connect"
 * and "T3 Chat" are T3's services and stay.
 */
export const pmAppName = (text: string): string => {
  const named = text.includes("T3 ")
    ? text.replace(UPSTREAM_APP_NAME, (_match, word: string) =>
        word === "Code"
          ? PM_DESKTOP_IDENTITY.productName
          : `${PM_DESKTOP_IDENTITY.productName} ${word}`,
      )
    : text;
  return pmCommandName(named).replace(UPSTREAM_HOME_ENV, PM_DESKTOP_IDENTITY.homeEnv);
};

/**
 * `pmAppName` in a fork desktop or server bundle, the text unchanged under Vitest, so upstream's
 * tests keep pinning upstream's copy. Wrap the literal and leave it as upstream wrote it.
 */
export const pmBundleAppName = (text: string): string => pmDesktop(pmAppName(text), text);

/** `pmAppName` over a translation catalog: strings, and the strings inside JSX entries. */
export const pmAppNameCatalog = <T>(value: T): T => {
  if (typeof value === "string") return pmAppName(value) as T;
  if (Array.isArray(value)) return value.map(pmAppNameCatalog) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, pmAppNameCatalog(entry)]),
  ) as T;
};
