import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pmRelabel, type PmThreadMenuState } from "./threadMenu.logic";

const state: PmThreadMenuState = {
  environmentId: "environment:a" as EnvironmentId,
  threadId: "thread:a" as ThreadId,
  projectId: "project:a" as ProjectId,
  projectLabel: null,
  enabled: true,
  isPm: false,
  isWorker: true,
  runningWorkers: 0,
};
const items = ["pin", "unpin", "snooze", "unsnooze", "rename"].map((id) => ({ id, label: id }));

describe("pmRelabel", () => {
  it("offers a worker no Pin or Snooze, but keeps the ways back out", () => {
    expect(pmRelabel(state, items).map((item) => item.id)).toEqual(["unpin", "unsnooze", "rename"]);
    expect(pmRelabel({ ...state, enabled: false }, items)).toBe(items);
    expect(pmRelabel({ ...state, isWorker: false }, items)).toBe(items);
  });
});
