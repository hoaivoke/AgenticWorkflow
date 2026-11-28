export type SmartRecommendedMode = "scorched-earth" | "swarm" | "standard";

export interface SmartModeAnalysis {
  readonly shouldIntercept: boolean;
  readonly needsExtraTokensPrompt: boolean;
  readonly recommendedMode: SmartRecommendedMode;
  readonly reason: string;
  readonly matchedSkills: ReadonlyArray<string>;
}

const EXPLICIT_MODE_PREFIX =
  /^\s*\/(swarm|scorched-earth|plan|goal|boost|grill-me|teamwork|learn|smart|model|clear|side|btw)(?:\s|$)/iu;

const HIGH_STAKES_PATTERNS: ReadonlyArray<RegExp> = [
  /\bmake\s+no\s+mistake(s)?\b/iu,
  /\bno\s+mistake(s)?\b/iu,
  /\bzero\s+bug(s)?\b/iu,
  /\bdo\s+not\s+(mess|screw|goof)\s+up\b/iu,
  /\bdon'?t\s+(mess|screw|goof)\s+up\b/iu,
  /\bverify\s+everything\b/iu,
  /\bcheck\s+every(thing|\s+single)\b/iu,
  /\bmake\s+sure\s+nothing\s+goes\s+wrong\b/iu,
  /\b100%\s*(sure|certain|verified)\b/iu,
  /\b(production|mission)[- ]critical\b/iu,
  /\bcannot\s+fail\b/iu,
  /\bflawless\b/iu,
  /\bscorch(ed)?\s+earth\b/iu,
];

const MULTI_AGENT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bin\s+parallel\b/iu,
  /\bmultiple\s+(agents|workers|services|surfaces)\b/iu,
  /\bend[- ]to[- ]end\s+(refactor|overhaul|rewrite|migration)\b/iu,
  /\bfull[- ]stack\s+(app|feature|rewrite|overhaul)\b/iu,
  /\bweb,\s*desktop,?\s*and\s*mobile\b/iu,
];

const DOMAIN_SKILL_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly candidates: ReadonlyArray<string>;
}> = [
  {
    pattern:
      /\b(smiles|rdkit|molecule|compound|drug|ic50|chembl|pubchem|ligand|docking|synthesis|retrosynthesis|chemistry|pharmacophore|qsar|admet)\b/iu,
    candidates: [
      "cheminformatics-core",
      "pubchem-database",
      "chembl-database",
      "rdkit-general",
      "cheminformatics-reactions",
      "cheminformatics-physics",
    ],
  },
  {
    pattern:
      /\b(alphagenome|variant|rs\d+|vcf|gencode|clinvar|gnomad|ensembl|eqtl|gtex|chromatin|promoter|enhancer|splicing|genomic|dna|rna|tfbs|jaspar)\b/iu,
    candidates: [
      "alphagenome-single-variant-analysis",
      "clinvar-database",
      "ensembl-database",
      "gnomad-database",
      "dbsnp-database",
    ],
  },
  {
    pattern:
      /\b(protein|pdb|mmcif|alphafold|uniprot|pymol|foldseek|msa|clustal|interpro|reactome|pathway|binding\s+site|structural\s+biology)\b/iu,
    candidates: [
      "pdb-database",
      "uniprot-database",
      "alphafold-database-fetch-and-analyze",
      "biomolecular-structure-viewer",
      "pymol",
    ],
  },
  {
    pattern:
      /\b(arxiv|pubmed|biorxiv|medrxiv|clinical\s+trial|nct\d+|fda|literature\s+search|papers?)\b/iu,
    candidates: [
      "pubmed-database",
      "literature-search-arxiv",
      "literature-search-europepmc",
      "clinical-trials-database",
      "openfda-database",
    ],
  },
  {
    pattern: /\b(firebase|firestore|crashlytics|app\s+hosting|remote\s+config)\b/iu,
    candidates: ["firebase-firestore", "firebase-auth-basics", "firebase-hosting-basics"],
  },
  {
    pattern:
      /\b(accessibility|a11y|aria|lcp|core\s+web\s+vitals|memory\s+leak|heap\s+snapshot|chrome\s+devtools|cookie\s+debug)\b/iu,
    candidates: [
      "chrome-devtools",
      "a11y-debugging",
      "debug-optimize-lcp",
      "memory-leak-debugging",
    ],
  },
  {
    pattern:
      /\b(css|html|modal|dialog|popover|dark\s+mode|tailwind|responsive|ui|frontend|react|animation|layout)\b/iu,
    candidates: ["modern-web-guidance", "ui-ux-polish"],
  },
  {
    pattern: /\b(mlflow|trace|tracing|eval|evaluation|benchmark)\b/iu,
    candidates: ["instrumenting-with-mlflow-tracing", "agent-evaluation"],
  },
  {
    pattern: /\b(gemini\s+api|live\s+api|genie\s+4|omni\s+flash|google-genai)\b/iu,
    candidates: ["gemini-api-dev", "gemini-live-api-dev"],
  },
  {
    pattern: /\b(android|avd|adb|jetpack\s+compose|kotlin)\b/iu,
    candidates: ["android-cli", "compose-preview"],
  },
];

export function analyzePromptForSmartMode(
  prompt: string,
  availableSkillNames: ReadonlyArray<string>,
): SmartModeAnalysis {
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || EXPLICIT_MODE_PREFIX.test(trimmed)) {
    return {
      shouldIntercept: false,
      needsExtraTokensPrompt: false,
      recommendedMode: "standard",
      reason: "",
      matchedSkills: [],
    };
  }

  const availableSet = new Set(availableSkillNames.map((name) => name.toLowerCase()));
  const matched: Array<string> = [];
  const addSkill = (name: string) => {
    const key = name.toLowerCase();
    if (matched.includes(name)) return;
    if (availableSet.size === 0 || availableSet.has(key)) {
      matched.push(name);
    }
  };

  for (const rule of DOMAIN_SKILL_RULES) {
    if (rule.pattern.test(trimmed)) {
      for (const candidate of rule.candidates) {
        addSkill(candidate);
        if (matched.length >= 4) break;
      }
    }
    if (matched.length >= 4) break;
  }

  const isHighStakes = HIGH_STAKES_PATTERNS.some((pattern) => pattern.test(trimmed));
  if (isHighStakes) {
    return {
      shouldIntercept: true,
      needsExtraTokensPrompt: true,
      recommendedMode: "scorched-earth",
      reason:
        "This request asks for zero mistakes or exhaustive verification. Scorched Earth uses extra tokens to run an independent playtester and troubleshooter loop.",
      matchedSkills: matched,
    };
  }

  const isMultiAgent = MULTI_AGENT_PATTERNS.some((pattern) => pattern.test(trimmed));
  if (isMultiAgent) {
    return {
      shouldIntercept: true,
      needsExtraTokensPrompt: true,
      recommendedMode: "swarm",
      reason:
        "This looks like a multi-part task. Swarm Mode uses extra tokens to coordinate parallel worker agents in isolated worktrees.",
      matchedSkills: matched,
    };
  }

  return {
    shouldIntercept: true,
    needsExtraTokensPrompt: false,
    recommendedMode: "standard",
    reason: "",
    matchedSkills: matched,
  };
}

export function buildSmartRoutedPrompt(
  prompt: string,
  mode: SmartRecommendedMode,
  matchedSkills: ReadonlyArray<string>,
): string {
  const trimmed = prompt.trim();
  const skillsSuffix =
    matchedSkills.length > 0 ? `\n\n[Smart Mode attached skills: ${matchedSkills.join(", ")}]` : "";
  if (mode === "scorched-earth") {
    return `/scorched-earth ${trimmed}${skillsSuffix}`;
  }
  if (mode === "swarm") {
    return `/swarm ${trimmed}${skillsSuffix}`;
  }
  const flag = matchedSkills.length > 0 ? ` --skills=${matchedSkills.join(",")}` : "";
  return `/smart${flag} ${trimmed}`;
}
