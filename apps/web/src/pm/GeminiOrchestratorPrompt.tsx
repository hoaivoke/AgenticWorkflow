import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BotIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { useEnvironmentProviders } from "../state/environments";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

type ThreadRef = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

const dismissedUpgrades = new Set<string>();

const GEMINI_ORCHESTRATOR_CANDIDATES: ReadonlyArray<{
  readonly match: string;
  readonly slugs: ReadonlyArray<string>;
}> = [
  { match: "neon", slugs: ["gemini-pro-orchestrator-neon"] },
  { match: "carbon", slugs: ["gemini-pro-orchestrator"] },
  { match: "argon", slugs: ["gemini-pro-orchestrator-argon", "gemini-pro-orchestrator-g1-pro"] },
  { match: "hydrogen", slugs: ["gemini-4-hydrogen-orchestrator"] },
];

function findGeminiOrchestratorUpgrade(
  currentModel: string | null | undefined,
  availableModels: ReadonlyArray<{ readonly slug: string; readonly name: string }>,
): { readonly slug: string; readonly name: string } | null {
  const normalized = (currentModel ?? "").trim().toLowerCase();
  if (!normalized || normalized.includes("orchestrator") || !normalized.includes("gemini")) {
    return null;
  }
  const entry = GEMINI_ORCHESTRATOR_CANDIDATES.find((candidate) =>
    normalized.includes(candidate.match),
  );
  if (entry === undefined) return null;
  for (const targetSlug of entry.slugs) {
    const found = availableModels.find((model) => model.slug.toLowerCase() === targetSlug);
    if (found !== undefined) {
      return { slug: found.slug, name: found.name };
    }
  }
  return null;
}

/**
 * Prompts once when a PM or Swarm coordinator thread is running on a standard Gemini model
 * (`gemini-4-neon`, `gemini-4-carbon`, etc.) and an Orchestrator variant of that model is installed.
 */
export function GeminiOrchestratorPrompt(props: { readonly threadRef: ThreadRef }) {
  const gt = useGT();
  const shell = useAtomValue(environmentThreadShells.threadShellAtom(props.threadRef));
  const providersByEnv = useEnvironmentProviders();
  const [switching, setSwitching] = useState(false);
  const [, setDismissedTick] = useState(0);

  const setModelSelection = useOrchestrationCommand(threadEnvironment.setModelSelection, {
    label: "switch to orchestrator model",
  });

  if (!shell) return null;
  const currentSelection = shell.modelSelection;
  const providers = providersByEnv.get(props.threadRef.environmentId) ?? [];
  const provider = providers.find((entry) => entry.instanceId === currentSelection.instanceId);
  if (!provider) return null;

  const upgrade = findGeminiOrchestratorUpgrade(currentSelection.model, provider.models);
  if (upgrade === null) return null;

  const dismissKey = `${props.threadRef.environmentId}:${props.threadRef.threadId}:${currentSelection.model}`;
  if (dismissedUpgrades.has(dismissKey)) return null;

  const currentModelName =
    provider.models.find((model) => model.slug === currentSelection.model)?.name ??
    currentSelection.model;

  const handleSwitch = async () => {
    if (switching) return;
    setSwitching(true);
    const result = await setModelSelection({
      environmentId: props.threadRef.environmentId,
      input: {
        threadId: props.threadRef.threadId,
        modelSelection: {
          instanceId: currentSelection.instanceId,
          model: upgrade.slug,
        },
      },
    });
    setSwitching(false);
    if (result._tag === "Success") {
      dismissedUpgrades.add(dismissKey);
      setDismissedTick((n) => n + 1);
    }
  };

  const handleDismiss = () => {
    dismissedUpgrades.add(dismissKey);
    setDismissedTick((n) => n + 1);
  };

  return (
    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-1.5 text-foreground/90">
        <BotIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
        <span className="truncate">
          {gt("Use {orchestrator} instead of {current} for this orchestrator?", {
            orchestrator: upgrade.name,
            current: currentModelName,
          })}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="secondary"
          disabled={switching}
          onClick={() => void handleSwitch()}
        >
          {gt("Switch to {orchestrator}", { orchestrator: upgrade.name })}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={handleDismiss}>
          {gt("Keep")}
        </Button>
      </div>
    </div>
  );
}
