import type { ComponentProps } from "react";

// Ghostex's Inbox glyphs: Tabler Icons (MIT), the set Ghostex draws them from
// (apps/desktop/assets/titlebar in Ghostex), so the Inbox reads the same in both apps.
const GLYPHS = {
  inbox: [
    "M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12",
    "M4 13h3l3 3h4l3 -3h3",
  ],
  circleDot: [
    "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
    "!M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0",
  ],
  circleHalf: ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "!M12 6a6 6 0 0 1 0 12z"],
  circleCheck: ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M9 12l2 2l4 -4"],
  checkbox: ["M9 11l3 3l8 -8", "M20 12v6a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h9"],
  helpCircle: [
    "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0",
    "M12 16v.01",
    "M12 13a2 2 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483",
  ],
  file: [
    "M14 3v4a1 1 0 0 0 1 1h4",
    "M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2",
  ],
  stack: ["M12 6l-8 4l8 4l8 -4l-8 -4", "M4 14l8 4l8 -4"],
  check: ["m5 12 4 4L19 6"],
  x: ["M18 6l-12 12", "M6 6l12 12"],
  dots: [
    "M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  ],
  reply: ["M9 14l-4 -4l4 -4", "M5 10h11a4 4 0 1 1 0 8h-1"],
  details: [
    "M8 9h8",
    "M8 13h6",
    "M14 18h-1l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v4.5",
    "M19 22v.01",
    "M19 19a2.003 2.003 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483",
  ],
  externalLink: [
    "M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6",
    "M11 13l9 -9",
    "M15 4h5v5",
  ],
  messageShare: [
    "M8 9h8",
    "M8 13h6",
    "M13 18l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6",
    "M16 22l5 -5",
    "M21 21.5v-4.5h-4.5",
  ],
  messageCheck: [
    "M11.042 19.933a9.798 9.798 0 0 1 -3.342 -.933l-4.7 1l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c2.127 1.814 3.052 4.36 2.694 6.808",
    "M15 19l2 2l4 -4",
  ],
  alarmOff: [
    "M7.587 7.566a7 7 0 1 0 9.833 9.864m1.35 -2.645a7 7 0 0 0 -8.536 -8.56",
    "M12 12v1h1",
    "M5.261 5.265l-1.011 .735",
    "M17 4l2.75 2",
    "M3 3l18 18",
  ],
  moon: ["M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454l0 .008"],
  quote: [
    "M10 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5",
    "M19 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5",
  ],
  markdown: [
    "M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10",
    "M7 15v-6l2 2l2 -2v6",
    "M14 13l2 2l2 -2m-2 2v-6",
  ],
  chevronDown: ["M6 9l6 6l6-6"],
  archive: [
    "M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2",
    "M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-10",
    "M10 12l4 0",
  ],
  star: [
    "M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z",
  ],
} as const;

export type InboxGlyph = keyof typeof GLYPHS | "circleMinusFilled";

/** One glyph; a path starting with "!" is filled, as Tabler draws a dot inside a ring. */
export function InboxIcon({
  name,
  filled = false,
  ...props
}: { readonly name: InboxGlyph; readonly filled?: boolean } & ComponentProps<"svg">) {
  if (name === "circleMinusFilled")
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
        <path
          fillRule="evenodd"
          d="M12 2a10 10 0 1 1 0 20a10 10 0 0 1 0 -20zm4 9h-8a1 1 0 0 0 0 2h8a1 1 0 0 0 0 -2z"
        />
      </svg>
    );
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {GLYPHS[name].map((d) =>
        d.startsWith("!") ? (
          <path key={d} d={d.slice(1)} fill="currentColor" stroke="none" />
        ) : (
          <path key={d} d={d} />
        ),
      )}
    </svg>
  );
}
