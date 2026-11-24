// t3code-pm: upstream files import gt-react through this module (vite.config.ts redirects them),
// so every string they show says PM3code where upstream's says T3 Code. PM files import the real one.
import { pmAppName } from "@t3tools/pm/identity";
import {
  createRenderPipeline,
  Currency,
  DateTime,
  GtInternalVar,
  gtFallback as realGtFallback,
  Num,
  RelativeTime,
  T as RealT,
  useGT as useUpstreamGT,
  useMessages as useUpstreamMessages,
  Var,
  type RenderPreparedT,
} from "gt-react";
import { cloneElement, isValidElement, type ComponentProps, type ReactNode } from "react";

export * from "gt-react";

// Copy about the official T3 Code phone app (the store QR, T3 Connect's phone page) keeps its name.
const OFFICIAL_SOURCES: ReadonlySet<string> = new Set(["T3 Code app for iPhone and Android"]);
const OFFICIAL_T_HASHES: ReadonlySet<string> = new Set(["0070a15f6b693068", "3260726e13a6882b"]);

const VARIABLES: ReadonlySet<unknown> = new Set([
  Var,
  GtInternalVar,
  Num,
  Currency,
  DateTime,
  RelativeTime,
]);

/** Rendered text with the name rewritten; variables hold the caller's values and stay. */
export function pmAppNameChildren(node: ReactNode): ReactNode {
  if (typeof node === "string") return pmAppName(node);
  if (Array.isArray(node)) {
    const mapped = node.map(pmAppNameChildren);
    return mapped.every((entry, index) => entry === node[index]) ? node : mapped;
  }
  if (!isValidElement<{ children?: ReactNode }>(node) || VARIABLES.has(node.type)) return node;
  const { children } = node.props;
  if (children === undefined || children === null) return node;
  const rewritten = pmAppNameChildren(children);
  if (rewritten === children) return node;
  return Array.isArray(rewritten)
    ? cloneElement(node, undefined, ...rewritten)
    : cloneElement(node, undefined, rewritten);
}

// GT's own pipeline, with the public variable components standing in for its internal twins.
const { renderPreparedT } = createRenderPipeline({
  Currency,
  GtInternalCurrency: Currency,
  DateTime,
  GtInternalDateTime: DateTime,
  Num,
  GtInternalNum: Num,
  RelativeTime,
  GtInternalRelativeTime: RelativeTime,
  Var,
  GtInternalVar,
});
// Rewrites what T renders, so the source keeps its translation key in every language.
const renderPmPreparedT: RenderPreparedT = (params) =>
  params.hash !== undefined && OFFICIAL_T_HASHES.has(params.hash)
    ? renderPreparedT(params)
    : pmAppNameChildren(renderPreparedT(params));

export function T(props: ComponentProps<typeof RealT>) {
  return <RealT {...props} _renderPreparedT={renderPmPreparedT} />;
}
T._gtt = RealT._gtt;

// Hooks the React Compiler memoizes, so callers keep a stable function as upstream's do.
export function useGT(
  messages?: Parameters<typeof useUpstreamGT>[0],
): ReturnType<typeof useUpstreamGT> {
  const gt = useUpstreamGT(messages);
  return (message, options) =>
    OFFICIAL_SOURCES.has(message) ? gt(message, options) : pmAppName(gt(message, options));
}

export function useMessages(
  messages?: Parameters<typeof useUpstreamMessages>[0],
): ReturnType<typeof useUpstreamMessages> {
  const resolve = useUpstreamMessages(messages);
  const pmResolve = (
    message: Parameters<typeof resolve>[0],
    options?: Parameters<typeof resolve>[1],
  ) => {
    const resolved = resolve(message, options);
    return typeof resolved === "string" ? pmAppName(resolved) : resolved;
  };
  return pmResolve as typeof resolve;
}

export const gtFallback: typeof realGtFallback = (message, options) =>
  pmAppName(realGtFallback(message, options));
