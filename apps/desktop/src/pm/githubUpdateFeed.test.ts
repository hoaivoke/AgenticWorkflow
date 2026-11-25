// t3code-pm: the stable lookup electron-updater runs against PM3code's own releases.
import * as NodeModule from "node:module";

import { PM_UPDATE_FEED, isPmReleaseTag } from "@t3tools/pm/identity";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import { describe, expect, it } from "vite-plus/test";

type ProviderArgs = ConstructorParameters<typeof GitHubProvider>;

const semver = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("electron-updater"),
)("semver") as { parse: (version: string) => ProviderArgs[1]["currentVersion"] };

const REPO = `/${PM_UPDATE_FEED.owner}/${PM_UPDATE_FEED.repo}`;

const lookup = async (latestTag: string) => {
  const paths: string[] = [];
  const request = async ({ path = "" }: { readonly path?: string | null }) => {
    paths.push(path ?? "");
    if (path === `${REPO}/releases.atom`) {
      return `<feed xmlns="http://www.w3.org/2005/Atom"><entry><link rel="alternate" type="text/html" href="https://github.com${REPO}/releases/tag/${latestTag}"/><title>${latestTag}</title><content type="html">notes</content></entry></feed>`;
    }
    if (path === `${REPO}/releases/latest`) return JSON.stringify({ tag_name: latestTag });
    if (path === `${REPO}/releases/download/${latestTag}/latest-mac.yml`) {
      return "version: 0.2.5\npath: PM3code-0.2.5-arm64.zip\nsha512: abc\n";
    }
    throw new Error(`unexpected request ${path}`);
  };
  const provider = new GitHubProvider(
    PM_UPDATE_FEED,
    {
      allowPrerelease: false,
      channel: "latest",
      currentVersion: semver.parse("0.2.4"),
      fullChangelog: false,
    } as ProviderArgs[1],
    {
      isUseMultipleRangeRequest: false,
      platform: "darwin",
      executor: { request },
    } as ProviderArgs[2],
  );
  const info = await provider.getLatestVersion();
  return { tag: info.tag, version: info.version, paths };
};

describe("PM3code's GitHub update feed", () => {
  it("reads the release marked Latest and its pm-v tag's feed file, only from PM3code's repository", async () => {
    const { tag, version, paths } = await lookup("pm-v0.2.5");
    expect({ tag, version }).toEqual({ tag: "pm-v0.2.5", version: "0.2.5" });
    expect(isPmReleaseTag(tag)).toBe(true);
    expect(paths).toEqual([
      `${REPO}/releases.atom`,
      `${REPO}/releases/latest`,
      `${REPO}/releases/download/pm-v0.2.5/latest-mac.yml`,
    ]);
  });

  it("reports the tag of a release that is not PM3code's, which the updater then ignores", async () => {
    const { tag } = await lookup("v0.2.5");
    expect(isPmReleaseTag(tag)).toBe(false);
  });
});
