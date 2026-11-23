// t3code-pm: Ghostex's Live page on an Art theme (visual_page_modal/glass.rs): the window's art,
// blurred a further 30 points of the screen, under one tint that folds the art's 45% dimming into
// the work area's 67% tint (both from ghostexTheme.css).
import type { PmPageGlass } from "@t3tools/pm";

import polarNight from "./assets/ghostex-polar-night.webp";

const PICTURE_BLUR_POINTS = 30;
const PICTURE_WIDTH = 960;
const TINT = "rgba(8, 9, 11, 0.82)";

let softened: Promise<string | null> | null = null;

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

/** The glass a Live page gets while the Ghostex theme paints its art, else null (dusk and dawn). */
export function pmPageGlass(): Promise<PmPageGlass | null> {
  if (document.documentElement.dataset.themeId !== "ghostex") return Promise.resolve(null);
  softened ??= soften(polarNight);
  return softened.then((picture) => (picture === null ? null : { picture, tint: TINT }));
}
