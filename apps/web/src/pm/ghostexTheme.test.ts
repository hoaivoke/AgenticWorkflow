// @effect-diagnostics nodeBuiltinImport:off - reads the theme file the app bundles.
import * as NodeFS from "node:fs";

import { THEME_COLOR_ROLES } from "@t3tools/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

import { getThemeColorVariable, getThemeDefinition, isReservedThemeId } from "../themePalette";
import {
  ghostexColors,
  ghostexThemeVariable,
  PM_DEFAULT_THEME,
  PM_GHOSTEX_THEME,
} from "./ghostexTheme";

// Unit tests stub CSS imports, ?raw included.
const themeCss = NodeFS.readFileSync(
  new URL("../../../../docs/pm/theme/pm3code-ghostex.css", import.meta.url),
  "utf8",
);

describe("PM_GHOSTEX_THEME", () => {
  it("names each color role by the variable the app paints", () => {
    for (const role of THEME_COLOR_ROLES) {
      expect(ghostexThemeVariable(role)).toBe(getThemeColorVariable(role));
    }
  });

  it("reads its colors from the theme file's root variables", () => {
    const colors = ghostexColors(themeCss);
    expect(colors.accent).toBe("#5581a9");
    expect(colors.accentForeground).toBe("#06101a");
    expect(colors.messageActionHover).toBe("#6794bd");
    expect(colors.canvas).toBe("#0a0b0e");
    expect(colors.terminalSelection).toBe("rgb(85 129 169 / 0.3)");
    expect(PM_GHOSTEX_THEME.appearance).toBe("dark");
  });

  it("is the default, a built-in theme that saved themes cannot shadow", () => {
    expect(PM_DEFAULT_THEME).toBe(PM_GHOSTEX_THEME.id);
    expect(getThemeDefinition(PM_DEFAULT_THEME)).toBe(PM_GHOSTEX_THEME);
    expect(isReservedThemeId(PM_DEFAULT_THEME)).toBe(true);
  });
});
