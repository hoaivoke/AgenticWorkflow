// @effect-diagnostics-next-line nodeBuiltinImport:off -- Vite config runs before any Effect runtime.
import * as NodePath from "node:path";

import type { Plugin } from "vite-plus";

const SRC = NodePath.resolve(import.meta.dirname, "../src");
const PM_DIR = `${NodePath.join(SRC, "pm")}${NodePath.sep}`;
const SHIM = NodePath.join(SRC, "pm/i18n/gtReact.tsx");

/**
 * t3code-pm: sends upstream's `gt-react` imports through the PM shim, which says PM3code where
 * upstream's copy says T3 Code. PM files and Vitest keep the real module, so upstream's tests
 * still pin upstream's copy and PM strings that mean official T3 Code keep saying so.
 */
export function pmAppNamePlugin(): Plugin {
  return {
    name: "t3code-pm:app-name",
    enforce: "pre",
    resolveId(source, importer, options) {
      if (source !== "gt-react" || !importer || process.env.VITEST) return null;
      if (NodePath.resolve(importer.split("?")[0] ?? importer).startsWith(PM_DIR)) return null;
      return this.resolve(SHIM, importer, { ...options, skipSelf: true });
    },
  };
}
