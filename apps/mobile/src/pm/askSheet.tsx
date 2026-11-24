import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { pmAskTag, pmInboxAge } from "@t3tools/pm/client";
import IconStarFilled from "@tabler/icons-react-native/IconStarFilled";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../components/ui/AppText";
import { SheetHeader } from "../components/ui/SheetHeader";
import { useNowMinuteMs } from "../lib/clock";
import { answerAsk, mentionInComposer, replyToPage } from "./inboxActions";
import { usePmThreadDetail } from "./state";

type Target = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The ask, or a page by its id for a page's Reply. */
  readonly askNo?: number;
  readonly pageId?: string;
  readonly draftKey: string | null;
};

// t3code-pm: an Inbox ask whole, with its answers and a Reply box: Ghostex's phone DockRow sheet.
export function PmAskSheet({ route }: StaticScreenProps<Target>) {
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const now = useNowMinuteMs();
  const target = { environmentId: route.params.environmentId, threadId: route.params.threadId };
  const detail = usePmThreadDetail(target.environmentId, target.threadId);
  const [text, setText] = useState("");
  const ask = detail?.asks.find((entry) => entry.askNo === route.params.askNo) ?? null;
  const page = detail?.pages.find((entry) => entry.pageId === route.params.pageId) ?? null;
  const title = ask?.title ?? page?.title ?? "";
  const words = text.trim();
  const close = () => navigation.goBack();

  const send = async (reply: string) => {
    const sent =
      ask !== null
        ? await answerAsk(target, ask.askNo, reply)
        : page !== null
          ? await replyToPage(target, page.pageId, reply)
          : null;
    if (sent !== null) close();
  };
  const toChatBox = () => {
    const tag = ask !== null ? `${pmAskTag(ask)}:` : page !== null ? `"${page.title}":` : "";
    mentionInComposer(route.params.draftKey, [tag, words].join(" ").trim());
    close();
  };
  const answers =
    ask === null
      ? []
      : ask.answers.length > 0
        ? ask.answers
        : [gt("Done", { $context: "answer to a to-do" })];
  const age = ask ? pmInboxAge(ask.createdAt, now) : null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title={title} onClose={close} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-2"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        keyboardShouldPersistTaps="handled"
      >
        {age ? (
          <Text className="text-xs text-foreground-muted">
            {age.unit === "now"
              ? gt("now", { $context: "Inbox row age" })
              : age.unit === "yesterday"
                ? gt("yesterday", { $context: "Inbox row age" })
                : `${age.value}${age.unit}`}
          </Text>
        ) : null}
        {ask?.detail.trim() ? (
          <Text selectable className="text-[15px] leading-6 text-foreground">
            {ask.detail.trim()}
          </Text>
        ) : null}
        {answers.length > 0 ? (
          <View className="flex-row flex-wrap gap-2">
            {answers.map((answer) => (
              <Pressable
                key={answer}
                accessibilityRole="button"
                className="flex-row items-center gap-1.5 rounded-lg bg-subtle px-3 py-2"
                onPress={() => void send(answer)}
              >
                {answer === ask?.recommended ? <IconStarFilled size={12} color="#f5b301" /> : null}
                <Text className="text-sm font-t3-medium text-foreground">{answer}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <TextInput
          accessibilityLabel={gt("Reply")}
          multiline
          value={text}
          onChangeText={setText}
          placeholder={title ? gt("Reply about {title}…", { title }) : gt("Your answer…")}
          className="min-h-20 rounded-lg border border-border bg-card px-3 py-2 text-foreground"
        />
        <View className="flex-row justify-end gap-2">
          <Pressable
            accessibilityRole="button"
            className="rounded-lg bg-subtle px-3 py-2"
            onPress={toChatBox}
          >
            <Text className="text-sm font-t3-medium text-foreground">
              {gt("Reply in chat box")}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={words === ""}
            className="rounded-lg bg-subtle px-3 py-2 disabled:opacity-50"
            onPress={() => void send(words)}
          >
            <Text className="text-sm font-t3-medium text-foreground">
              {ask !== null ? gt("Send answer") : gt("Send reply")}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
