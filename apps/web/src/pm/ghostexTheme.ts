// t3code-pm: Ghostex is PM3code's built-in default theme. Its custom CSS and colors both come from
// the one theme file users used to paste, so docs/pm/theme/pm3code-ghostex.css stays the source.
import {
  T3_CODE_DARK_THEME_COLORS,
  THEME_COLOR_ROLES,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
} from "@t3tools/shared/themePalettes";

import ghostexCss from "../../../../docs/pm/theme/pm3code-ghostex.css?raw";

// Mirrors APP_THEME_VARIABLES in themePalette.ts; ghostexTheme.test.ts keeps the two in step.
export function ghostexThemeVariable(role: ThemeColorRole): string {
  const name = role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return `--app-theme-${name}${role === "terminalSelection" ? "-background" : ""}`;
}

function rootVariables(css: string): ReadonlyMap<string, string> {
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const variables = new Map<string, string>();
  for (const [, name, value] of root.matchAll(/(--[\w-]+)\s*:\s*([^;]+?)\s*(?:!important)?\s*;/g)) {
    if (name !== undefined && value !== undefined) variables.set(name, value);
  }
  return variables;
}

export function ghostexColors(css: string): ThemeColors {
  const variables = rootVariables(css);
  return Object.fromEntries(
    THEME_COLOR_ROLES.map((role) => [
      role,
      variables.get(ghostexThemeVariable(role)) ?? T3_CODE_DARK_THEME_COLORS[role],
    ]),
  ) as ThemeColors;
}

export const PM_GHOSTEX_THEME: ThemeDefinition = {
  id: "pm-ghostex",
  // oxlint-disable-next-line t3code/no-untranslated-copy -- theme name, like T3's built-in theme labels
  label: "Ghostex",
  appearance: "dark",
  colors: ghostexColors(ghostexCss),
  css: ghostexCss,
};

/** The theme a client starts with before anyone picks one. */
export const PM_DEFAULT_THEME = PM_GHOSTEX_THEME.id;
