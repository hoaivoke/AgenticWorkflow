import { useGT } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";

/** Ghostex's red "Not moving" chip: still quiet a full round after T3 Code nudged it. */
export function PmNotMovingChip() {
  const gt = useGT();
  return (
    <View
      accessibilityHint={gt("No progress for a while, even after T3 Code nudged it")}
      className="rounded-full border border-danger-border bg-danger px-1.5"
    >
      <Text className="text-xs text-danger-foreground">{gt("Not moving")}</Text>
    </View>
  );
}
