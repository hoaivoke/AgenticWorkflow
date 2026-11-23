// t3code-pm: Ghostex's Live page on an Art theme (visual_page_modal/glass.rs): the window's art,
// blurred a further 30 points of the screen, under one tint. The art and tint come from the
// theme's custom CSS (`--pm-page-art`, `--pm-page-tint`), as docs/pm/theme/pm3code-ghostex.css sets.
import type { PmPageGlass } from "@t3tools/pm";

const PICTURE_BLUR_POINTS = 30;
const PICTURE_WIDTH = 960;
const DEFAULT_TINT = "rgba(8, 9, 11, 0.6)";
const ART_URL = /^url\(\s*["']?(data:image\/[^"')]+)["']?\s*\)$/;

const softened = new Map<string, Promise<string | null>>();

const soften = (src: string) =>
  new Promise<string | null>((resolve) => {
    const image = new Image();
    image.addEventListener("error", () => resolve(null));
    image.addEventListener("load", () => {
      const width = PICTURE_WIDTH;
      const height = Math.round((image.naturalHeight / image.naturalWidth) * width);
      const blur = (PICTURE_BLUR_POINTS * width) / Math.max(window.screen.width, 1);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) return resolve(null);
      // Drawn past the edges so the blur never pulls the dark fill in at the border.
      const bleed = blur * 3;
      context.fillStyle = "#0a0b0e";
      context.fillRect(0, 0, width, height);
      context.filter = `blur(${blur}px)`;
      context.drawImage(image, -bleed, -bleed, width + bleed * 2, height + bleed * 2);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    });
    image.src = src;
  });

/** The glass a Live page gets while the theme's CSS names an art picture, else null (dusk and dawn). */
export function pmPageGlass(): Promise<PmPageGlass | null> {
  const style = getComputedStyle(document.documentElement);
  const art = ART_URL.exec(style.getPropertyValue("--pm-page-art").trim())?.[1];
  if (art === undefined) return Promise.resolve(null);
  const tint = style.getPropertyValue("--pm-page-tint").trim() || DEFAULT_TINT;
  let picture = softened.get(art);
  if (picture === undefined) {
    picture = soften(art);
    softened.set(art, picture);
  }
  return picture.then((softenedArt) =>
    softenedArt === null ? null : { picture: softenedArt, tint },
  );
}
