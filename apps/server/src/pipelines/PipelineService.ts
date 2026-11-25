// pipelines: role-based model routing for PM workers. See docs/user/pipelines.md.
import { isProviderAvailable, type ProjectId, type ServerProvider } from "@t3tools/contracts";
import {
  CONFIG_DIR,
  loadPipelineConfig,
  type ConfigFile,
  type LoadResult,
  type ProviderSnapshot,
} from "@t3tools/pipelines";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

/** Effort controls go by different ids per provider. */
const REASONING_IDS = new Set(["effort", "reasoningEffort", "thinkingLevel", "thought_level"]);

/** A provider the router may send work to: on, installed, healthy and signed in. */
const isUsableProvider = (provider: ServerProvider) =>
  provider.enabled &&
  provider.installed &&
  isProviderAvailable(provider) &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status !== "unauthenticated";

const toSnapshot = (provider: ServerProvider): ProviderSnapshot => ({
  instanceId: provider.instanceId,
  driver: provider.driver,
  enabled: isUsableProvider(provider),
  displayName: provider.displayName ?? null,
  models: provider.models
    .filter((model) => model.isLegacy !== true)
    .map((model) => {
      const descriptor = model.capabilities?.optionDescriptors?.find(
        (option) =>
          option.type === "select" && (option.role === "reasoning" || REASONING_IDS.has(option.id)),
      );
      return {
        slug: model.slug,
        name: model.name,
        reasoning:
          descriptor?.type === "select"
            ? { id: descriptor.id, choices: descriptor.options.map((choice) => choice.id) }
            : undefined,
      };
    }),
});

export interface PipelineServiceShape {
  /** Built-ins merged with the project's `.pipelines/` files. Never fails: problems are listed. */
  readonly configFor: (
    projectId: string,
  ) => Effect.Effect<LoadResult & { readonly root: string | null }>;
  /** Every provider account the server knows, as the router sees it. */
  readonly providers: Effect.Effect<ReadonlyArray<ProviderSnapshot>>;
}

export class PipelineService extends Context.Service<PipelineService, PipelineServiceShape>()(
  "t3/pipelines/PipelineService",
) {}

const MAX_FILES = 200;
const MAX_BYTES = 256 * 1024;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const registry = yield* ProviderRegistry.ProviderRegistry;

  const readFile = Effect.fn("PipelineService.readFile")(function* (
    base: string,
    relative: string,
    files: Array<ConfigFile>,
  ) {
    const absolute = path.join(base, relative);
    const info = yield* fs.stat(absolute);
    if (info.type !== "File" || Number(info.size) > MAX_BYTES) return;
    files.push({ path: relative, text: yield* fs.readFileString(absolute) });
  });

  const readYamlFiles = Effect.fn("PipelineService.readYamlFiles")(function* (root: string) {
    const base = path.join(root, CONFIG_DIR);
    const files: Array<ConfigFile> = [];
    const read = (relative: string) => readFile(base, relative, files).pipe(Effect.ignore);
    for (const name of ["tiers.yaml", "tiers.yml"]) yield* read(name);
    for (const folder of ["roles", "pipelines"]) {
      const names = yield* fs
        .readDirectory(path.join(base, folder))
        .pipe(Effect.orElseSucceed(() => [] as Array<string>));
      for (const name of names.filter((entry) => /\.ya?ml$/i.test(entry)).sort()) {
        if (files.length >= MAX_FILES) break;
        yield* read(`${folder}/${name}`);
      }
    }
    return files;
  });

  const configFor: PipelineServiceShape["configFor"] = Effect.fn("PipelineService.configFor")(
    function* (projectId: string) {
      const project = yield* projects
        .getById(projectId as ProjectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const root = Option.match(project, {
        onNone: () => null,
        onSome: (value) => value.workspaceRoot,
      });
      const files = root === null ? [] : yield* readYamlFiles(root);
      return { ...loadPipelineConfig(files), root };
    },
  );

  const providers = registry.getProviders.pipe(Effect.map((list) => list.map(toSnapshot)));

  return { configFor, providers } satisfies PipelineServiceShape;
});

export const layer = Layer.effect(PipelineService, make);

export type TestFiles = ReadonlyArray<ConfigFile>;

/** For tests: fixed providers and project files, no disk or registry. */
export const layerTest = (input: {
  readonly providers?: ReadonlyArray<ProviderSnapshot>;
  readonly files?: TestFiles;
}) =>
  Layer.succeed(PipelineService, {
    configFor: Effect.fn("PipelineService.test.configFor")(() =>
      Effect.sync(() => ({ ...loadPipelineConfig(input.files ?? []), root: null })),
    ),
    providers: Effect.succeed(input.providers ?? []),
  });
