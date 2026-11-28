import { describe, expect, it } from "vite-plus/test";

import { analyzePromptForSmartMode, buildSmartRoutedPrompt } from "./smartMode";

describe("smartMode", () => {
  it("asks before spending extra tokens on high-stakes prompts and matches chemistry skills", () => {
    const analysis = analyzePromptForSmartMode(
      "Analyze this SMILES compound with RDKit and PubChem, make no mistake",
      ["cheminformatics-core", "pubchem-database", "rdkit-general"],
    );
    expect(analysis.shouldIntercept).toBe(true);
    expect(analysis.needsExtraTokensPrompt).toBe(true);
    expect(analysis.recommendedMode).toBe("scorched-earth");
    expect(analysis.matchedSkills).toContain("cheminformatics-core");
    expect(analysis.matchedSkills).toContain("pubchem-database");
  });

  it("recommends Swarm Mode for parallel multi-surface requests", () => {
    const analysis = analyzePromptForSmartMode(
      "Implement this across web, desktop, and mobile in parallel",
      [],
    );
    expect(analysis.needsExtraTokensPrompt).toBe(true);
    expect(analysis.recommendedMode).toBe("swarm");
  });

  it("skips interception when the user already specified a slash command", () => {
    const analysis = analyzePromptForSmartMode("/plan Refactor the router", []);
    expect(analysis.shouldIntercept).toBe(false);
    expect(analysis.needsExtraTokensPrompt).toBe(false);
  });

  it("formats routed prompts cleanly for each mode", () => {
    expect(buildSmartRoutedPrompt("Check pKa", "standard", ["cheminformatics-core"])).toBe(
      "/smart --skills=cheminformatics-core Check pKa",
    );
    expect(buildSmartRoutedPrompt("Verify billing", "scorched-earth", [])).toBe(
      "/scorched-earth Verify billing",
    );
    expect(buildSmartRoutedPrompt("Build feature", "swarm", ["ui-ux-polish"])).toContain(
      "/swarm Build feature",
    );
  });
});
