import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

/** The Live page open in the floating window, at most one at a time. */
export interface PmOpenPage {
  readonly threadKey: string;
  readonly pageId: string;
}

const openPageAtom = Atom.make<PmOpenPage | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("pm-open-page"),
);

export const openPmPage = (page: PmOpenPage) => appAtomRegistry.set(openPageAtom, page);
export const closePmPage = () => appAtomRegistry.set(openPageAtom, null);
export const useOpenPmPage = (): PmOpenPage | null => {
  const open: unknown = useAtomValue(openPageAtom);
  return open !== null &&
    typeof open === "object" &&
    typeof (open as PmOpenPage).pageId === "string"
    ? (open as PmOpenPage)
    : null;
};

/** Client-only folds: the dock per PM, and which Work items groups are open. */
const foldsAtom = Atom.make<ReadonlyMap<string, boolean>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("pm-folds"),
);

export const setPmFold = (key: string, next: boolean) => {
  const current = appAtomRegistry.get(foldsAtom);
  appAtomRegistry.set(foldsAtom, new Map(current).set(key, next));
};

/** A folded dock remembers the rows it folded over, so any new row opens it again. */
const dockHiddenAtom = Atom.make<ReadonlyMap<string, ReadonlySet<string>>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("pm-dock-hidden"),
);

export const setPmDockHidden = (key: string, rows: ReadonlySet<string> | null) => {
  const next = new Map(appAtomRegistry.get(dockHiddenAtom));
  if (rows === null) next.delete(key);
  else next.set(key, rows);
  appAtomRegistry.set(dockHiddenAtom, next);
};

export const usePmDockHidden = (key: string): ReadonlySet<string> | null => {
  const hidden: unknown = useAtomValue(dockHiddenAtom);
  return hidden instanceof Map
    ? ((hidden.get(key) as ReadonlySet<string> | undefined) ?? null)
    : null;
};

export const usePmFold = (key: string, fallback: boolean) => {
  const folds: unknown = useAtomValue(foldsAtom);
  const value =
    (folds instanceof Map ? (folds.get(key) as boolean | undefined) : undefined) ?? fallback;
  return [value, (next: boolean) => setPmFold(key, next)] as const;
};
