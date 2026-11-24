import { useGT } from "gt-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

/** Ghostex's red "Not moving" chip: still quiet a round after PM3code nudged it, or stopped again after it. */
export function PmNotMovingChip() {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 items-center rounded-full border border-destructive/35 bg-destructive/10 px-1.5 text-2xs text-destructive leading-4" />
        }
      >
        {gt("Not moving")}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {gt("No progress for a while, even after PM3code nudged it")}
      </TooltipPopup>
    </Tooltip>
  );
}
