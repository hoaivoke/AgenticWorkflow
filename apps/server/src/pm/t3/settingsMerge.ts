import * as NodeUtil from "node:util";

type Json = unknown;
type JsonObject = { [key: string]: Json };

/** The T3 Code value last copied for each setting, keyed by its JSON path. */
export type SettingsBaseline = Record<string, Json>;

const isObject = (value: Json): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pathKey = (path: ReadonlyArray<string>) => JSON.stringify(path);

/** Leaves of plain objects; arrays and scalars are single values. `skip` drops a whole subtree. */
function leaves(
  value: Json,
  skip: (value: Json) => boolean,
  path: Array<string> = [],
  out = new Map<string, ReadonlyArray<string>>(),
) {
  if (skip(value)) return out;
  if (isObject(value) && (path.length === 0 || Object.keys(value).length > 0)) {
    for (const [key, child] of Object.entries(value)) leaves(child, skip, [...path, key], out);
  } else if (path.length > 0) {
    out.set(pathKey(path), path);
  }
  return out;
}

function get(value: Json, path: ReadonlyArray<string>): Json {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function set(target: JsonObject, path: ReadonlyArray<string>, value: Json) {
  let current = target;
  for (const key of path.slice(0, -1)) {
    if (!isObject(current[key])) current[key] = {};
    current = current[key] as JsonObject;
  }
  const last = path.at(-1)!;
  if (value === undefined) delete current[last];
  else current[last] = value;
}

/**
 * Three-way merge of one settings document. A setting follows T3 Code while PM3code still holds
 * the value last copied from T3 Code (or the default, before any copy); one changed in PM3code
 * keeps PM3code's value. Values equal to the default count as unset on both sides.
 */
export function mergeFollowedSettings(input: {
  readonly pm: Json;
  readonly t3: Json;
  readonly defaults: Json;
  readonly baseline: SettingsBaseline;
  /** Subtrees never copied, such as secret references that only resolve in T3 Code. */
  readonly skip?: (value: Json) => boolean;
}): { readonly next: JsonObject; readonly baseline: SettingsBaseline; readonly changed: number } {
  const skip = input.skip ?? (() => false);
  const next = structuredClone(isObject(input.pm) ? input.pm : {});
  const normalized = (value: Json, path: ReadonlyArray<string>) =>
    value === undefined || NodeUtil.isDeepStrictEqual(value, get(input.defaults, path))
      ? undefined
      : value;
  const paths = new Map([...leaves(input.pm, skip), ...leaves(input.t3, skip)]);
  for (const key of Object.keys(input.baseline)) {
    if (!paths.has(key)) paths.set(key, JSON.parse(key) as ReadonlyArray<string>);
  }
  const baseline: SettingsBaseline = {};
  let changed = 0;
  for (const [key, path] of paths) {
    const t3Value = normalized(get(input.t3, path), path);
    const pmValue = normalized(get(input.pm, path), path);
    if (skip(get(input.t3, path))) continue;
    if (t3Value !== undefined) baseline[key] = t3Value;
    const follows = NodeUtil.isDeepStrictEqual(pmValue, input.baseline[key]);
    if (follows && !NodeUtil.isDeepStrictEqual(pmValue, t3Value)) {
      set(next, path, t3Value);
      changed += 1;
    }
  }
  return { next, baseline, changed };
}
