import { isPublicFaviconHost } from "./hostClassification.ts";

function faviconUrlForPage(rawUrl: string | null | undefined, _size = 32): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const pageUrl = new URL(rawUrl);
    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") return null;
    return new URL("/favicon.ico", pageUrl.origin).href;
  } catch {
    return null;
  }
}

const THEMED_FAVICON_BY_HOSTNAME: Readonly<
  Record<string, Readonly<{ light: string; dark: string }>>
> = {
  "github.com": {
    light: "https://github.githubassets.com/favicons/favicon.svg",
    dark: "https://github.githubassets.com/favicons/favicon-dark.svg",
  },
};

function themedFaviconUrlForPage(
  rawUrl: string | null | undefined,
  appearance: "light" | "dark",
): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const pageUrl = new URL(rawUrl);
    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") return null;
    return THEMED_FAVICON_BY_HOSTNAME[pageUrl.hostname.toLowerCase()]?.[appearance] ?? null;
  } catch {
    return null;
  }
}

/** Accepts image URLs supplied by a trusted provider event. */
function explicitFaviconUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function toolActivityFaviconUrl(
  icon: {
    readonly pageUrl: string;
    readonly faviconUrl?: string | undefined;
    readonly faviconUrlDark?: string | undefined;
  },
  appearance: "light" | "dark",
  size = 32,
): string | null {
  if (appearance === "dark") {
    return (
      explicitFaviconUrl(icon.faviconUrlDark) ??
      themedFaviconUrlForPage(icon.pageUrl, "dark") ??
      explicitFaviconUrl(icon.faviconUrl) ??
      faviconUrlForPage(icon.pageUrl, size)
    );
  }
  return (
    explicitFaviconUrl(icon.faviconUrl) ??
    themedFaviconUrlForPage(icon.pageUrl, "light") ??
    faviconUrlForPage(icon.pageUrl, size)
  );
}

/**
 * t3code-pm: PM3code never asks Google for a link's icon, so no third party sees the hostnames in
 * a chat; callers show their generic link icon. Only upstream's tests pass `pmBuild = false`.
 */
export function faviconUrlForOrigin(
  rawUrl: string | null | undefined,
  size = 32,
  pmBuild = true,
): string | null {
  if (pmBuild) return null; // t3code-pm:
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.hostname) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isPublicFaviconHost(url.hostname)) return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=${size}`;
  } catch {
    return null;
  }
}

/**
 * t3code-pm: Google's favicon service, which a provider can name as a tool's icon. PM3code drops
 * these so no third party learns which sites an agent used.
 */
export function isFaviconServiceUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    ((host === "www.google.com" || host === "google.com") &&
      url.pathname.startsWith("/s2/favicons")) ||
    (host.endsWith(".gstatic.com") && url.pathname.startsWith("/faviconV2"))
  );
}
