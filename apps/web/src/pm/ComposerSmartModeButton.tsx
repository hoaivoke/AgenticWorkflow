import { T, useGT } from "gt-react";
import { BrainIcon, FlameIcon, UsersIcon, XIcon } from "lucide-react";

import { ComposerControl } from "../components/chat/ComposerControl";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import type { SmartModeAnalysis, SmartRecommendedMode } from "./smartMode";

/**
 * Toggle pill placed right next to the Harness button in the composer controls bar.
 * When active, prompts are routed through Smart Mode: matching skills and the full
 * Capabilities Manifest (.md) are attached, and high-stakes requests ask before spending
 * extra tokens on Scorched Earth or Swarm Mode.
 */
export function ComposerSmartModeButton(props: {
  readonly enabled: boolean;
  readonly onToggle: () => void;
  readonly size?: "xs" | "sm";
  readonly disabled?: boolean;
}) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            type="button"
            size={props.size ?? "sm"}
            disabled={props.disabled}
            aria-pressed={props.enabled}
            aria-label={props.enabled ? gt("Smart Mode is on") : gt("Turn on Smart Mode")}
            onClick={props.onToggle}
            className={cn(
              "shrink-0 gap-1",
              props.enabled && "bg-primary/12 text-foreground ring-1 ring-primary/30",
            )}
          >
            <BrainIcon className="size-3.5 shrink-0" aria-hidden />
            <span data-composer-control-label>
              <T>Smart</T>
            </span>
          </ComposerControl>
        }
      />
      <TooltipPopup>
        {props.enabled ? (
          <T>
            Smart Mode ON: attaches matching skills + capabilities manifest and asks before
            high-stakes Swarm or Scorched Earth runs
          </T>
        ) : (
          <T>
            Turn on Smart Mode to auto-attach skills and confirm extra tokens on high-stakes
            requests
          </T>
        )}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Inline confirmation card shown above the composer when Smart Mode detects a high-stakes
 * or multi-agent prompt and asks the user before spending extra tokens.
 */
export function SmartModeConfirmBanner(props: {
  readonly analysis: SmartModeAnalysis;
  readonly onChoose: (mode: SmartRecommendedMode) => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  return (
    <div className="mx-3 mb-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <BrainIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 space-y-1">
            <p className="font-medium text-foreground">
              <T>Use extra tokens to make sure nothing goes wrong?</T>
            </p>
            <p className="text-2xs text-muted-foreground">{props.analysis.reason}</p>
            {props.analysis.matchedSkills.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1 pt-0.5">
                <span className="text-3xs text-muted-foreground">
                  <T>Matched skills:</T>
                </span>
                {props.analysis.matchedSkills.map((skill) => (
                  <Badge key={skill} variant="secondary" size="sm">
                    {skill}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={props.onCancel}
          aria-label={gt("Cancel Smart Mode confirmation")}
        >
          <XIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-6">
        <Button
          type="button"
          size="xs"
          variant={props.analysis.recommendedMode === "scorched-earth" ? "default" : "outline"}
          onClick={() => props.onChoose("scorched-earth")}
        >
          <FlameIcon className="size-3.5" aria-hidden />
          <T>Scorched Earth (extra tokens)</T>
        </Button>
        <Button
          type="button"
          size="xs"
          variant={props.analysis.recommendedMode === "swarm" ? "default" : "outline"}
          onClick={() => props.onChoose("swarm")}
        >
          <UsersIcon className="size-3.5" aria-hidden />
          <T>Swarm Mode</T>
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => props.onChoose("standard")}>
          <T>Run normally + skills</T>
        </Button>
      </div>
    </div>
  );
}
