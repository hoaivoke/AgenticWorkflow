// t3code-pm: main.ts imports this first, before any module reads the environment.
import { PM_DESKTOP_IDENTITY as PM, pmDesktop } from "@t3tools/pm/identity";

/**
 * `T3CODE_HOME` is official T3 Code's and may name someone's real data, so a fork build takes its
 * home from `T3CODE_PM_HOME` only. The app, its backend and every child then see one value.
 */
export function adoptPmHomeEnvironment(env: NodeJS.ProcessEnv): void {
  const home = env[PM.homeEnv]?.trim();
  if (home) env.T3CODE_HOME = home;
  else delete env.T3CODE_HOME;
}

if (pmDesktop(true, false)) adoptPmHomeEnvironment(process.env);
