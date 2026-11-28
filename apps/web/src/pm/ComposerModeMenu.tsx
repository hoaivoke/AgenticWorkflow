import { T, useGT, Var } from "gt-react";
import {
  BookOpenIcon,
  BrainIcon,
  CheckIcon,
  CompassIcon,
  FlameIcon,
  HelpCircleIcon,
  ListChecksIcon,
  PlusIcon,
  TargetIcon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

interface ModeOption {
  readonly command: string;
  readonly label: string;
  readonly description: string;
  readonly group: "modes" | "commands";
  readonly icon: typeof UsersIcon;
}

const LEADING_MODE_RE =
  /^\s*\/(swarm|scorched-earth|plan|goal|boost|grill-me|teamwork|learn|smart)(?:\s+([\s\S]*))?$/iu;

function detectActiveComposerMode(prompt: string): string | null {
  const match = LEADING_MODE_RE.exec(prompt);
  return match?.[1]?.toLowerCase() ?? null;
}

function toggleComposerModePrefix(prompt: string, command: string): string {
  const match = LEADING_MODE_RE.exec(prompt);
  if (match) {
    const active = match[1]?.toLowerCase() ?? "";
    const rest = (match[2] ?? "").trimStart();
    if (active === command.toLowerCase()) {
      return rest;
    }
    return `/${command} ${rest}`;
  }
  const trimmedStart = prompt.trimStart();
  return `/${command} ${trimmedStart}`;
}

/**
 * `+` mode picker next to the paperclip attach icon. Surfaces Swarm Mode, Scorched Earth,
 * and all Agent Space workflow `/` commands in one click.
 */
export function ComposerModeMenu(props: {
  readonly prompt: string;
  readonly disabled?: boolean;
  readonly onPromptEdit: (edit: (prompt: string) => string) => void;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const activeMode = detectActiveComposerMode(props.prompt);

  const options: ReadonlyArray<ModeOption> = [
    {
      command: "swarm",
      label: gt("Swarm Mode"),
      description: gt("Coordinate parallel worker agents on a shared board"),
      group: "modes",
      icon: UsersIcon,
    },
    {
      command: "scorched-earth",
      label: gt("Scorched Earth"),
      description: gt("Exhaustive playtesting, surface inventory, and auto-fix loop"),
      group: "modes",
      icon: FlameIcon,
    },
    {
      command: "plan",
      label: gt("Plan Mode"),
      description: gt("Research first and draft a step-by-step plan before editing"),
      group: "modes",
      icon: ListChecksIcon,
    },
    {
      command: "goal",
      label: gt("Goal Mode"),
      description: gt("Keep verifying and fixing until the goal is achieved"),
      group: "modes",
      icon: TargetIcon,
    },
    {
      command: "boost",
      label: gt("Boost Mode"),
      description: gt("Deep reasoning, multi-perspective review, and strict checks"),
      group: "commands",
      icon: ZapIcon,
    },
    {
      command: "grill-me",
      label: gt("Grill Me"),
      description: gt("Interview me to resolve requirements and design choices"),
      group: "commands",
      icon: HelpCircleIcon,
    },
    {
      command: "teamwork",
      label: gt("Teamwork"),
      description: gt("Split a large project across a team of parallel agents"),
      group: "commands",
      icon: CompassIcon,
    },
    {
      command: "learn",
      label: gt("Learn"),
      description: gt("Save a correction or workflow as a persistent skill"),
      group: "commands",
      icon: BookOpenIcon,
    },
    {
      command: "smart",
      label: gt("Smart Route"),
      description: gt("Attach matching skills and confirm extra tokens if high-stakes"),
      group: "commands",
      icon: BrainIcon,
    },
  ];

  const modeItems = options.filter((o) => o.group === "modes");
  const commandItems = options.filter((o) => o.group === "commands");

  const handleSelect = (command: string) => {
    props.onPromptEdit((current) => toggleComposerModePrefix(current, command));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant={activeMode ? "secondary" : "ghost"}
                  size="icon-sm"
                  disabled={props.disabled}
                  onPointerDown={(event) => event.preventDefault()}
                  aria-label={
                    activeMode
                      ? gt("Active mode: /{mode}", { mode: activeMode })
                      : gt("Modes and slash commands")
                  }
                >
                  <PlusIcon className="size-4" aria-hidden />
                </Button>
              }
            />
          }
        />
        <TooltipPopup>
          {activeMode ? (
            <T>
              Active mode: /<Var>{activeMode}</Var> (click to switch or clear)
            </T>
          ) : (
            <T>Modes & slash commands (Swarm, Scorched Earth, Plan, Goal...)</T>
          )}
        </TooltipPopup>
      </Tooltip>

      <PopoverPopup side="top" align="start" width="md" padding="compact">
        <div className="space-y-2">
          <div>
            <p className="px-2 pb-1 text-3xs font-semibold tracking-wider text-muted-foreground uppercase">
              <T>Modes</T>
            </p>
            <div className="space-y-0.5">
              {modeItems.map((item) => {
                const Icon = item.icon;
                const selected = activeMode === item.command;
                return (
                  <button
                    key={item.command}
                    type="button"
                    onClick={() => handleSelect(item.command)}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-foreground">{item.label}</span>
                        <span className="font-mono text-3xs text-muted-foreground">
                          /{item.command}
                        </span>
                      </div>
                      <p className="text-2xs text-muted-foreground">{item.description}</p>
                    </div>
                    {selected ? (
                      <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-border pt-2">
            <p className="px-2 pb-1 text-3xs font-semibold tracking-wider text-muted-foreground uppercase">
              <T>Workflow Commands</T>
            </p>
            <div className="space-y-0.5">
              {commandItems.map((item) => {
                const Icon = item.icon;
                const selected = activeMode === item.command;
                return (
                  <button
                    key={item.command}
                    type="button"
                    onClick={() => handleSelect(item.command)}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-foreground">{item.label}</span>
                        <span className="font-mono text-3xs text-muted-foreground">
                          /{item.command}
                        </span>
                      </div>
                      <p className="text-2xs text-muted-foreground">{item.description}</p>
                    </div>
                    {selected ? (
                      <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
