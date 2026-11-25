// @effect-diagnostics nodeBuiltinImport:off - reads a repo doc synchronously; pipelines: its YAML examples must load.
import { expect, it } from "@effect/vitest";
import { loadPipelineConfig } from "@t3tools/pipelines";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const DOC = NodePath.resolve(__dirname, "../../../../docs/user/pipelines.md");

it("docs/user/pipelines.md examples load cleanly", () => {
  const doc = NodeFS.readFileSync(DOC, "utf8");
  const blocks = [
    ...doc.matchAll(/`(\.pipelines\/[^`]+\.yaml)`[^\n]*\n(?:[^\n]*\n)*?\n```yaml\n([\s\S]*?)```/g),
  ];
  expect(blocks.map((block) => block[1])).toEqual([
    ".pipelines/tiers.yaml",
    ".pipelines/roles/builder.yaml",
    ".pipelines/pipelines/feature.yaml",
  ]);
  const { config, problems } = loadPipelineConfig(
    blocks.map((block) => ({ path: block[1]!.replace(".pipelines/", ""), text: block[2]! })),
  );
  expect(problems).toEqual([]);
  expect(config.tiers.mid[0]?.provider).toBe("claude-work");
  expect(config.roles.get("builder")?.candidates?.[0]?.provider).toBe("codex");
  const gates = config.pipelines.get("feature")?.stages.find((stage) => stage.id === "gates");
  expect(gates?.run).toHaveLength(5);
});
