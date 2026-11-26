/** Markup colours: the web's `--ff-*` tokens, stored as `#rrggbb` (the doc contract) so every client draws the same ink. */
export interface MarkupColour {
  id: string;
  label: string;
  /** The web token this comes from. */
  token: string;
  hex: string;
}

export const MARKUP_COLOURS: readonly MarkupColour[] = [
  { id: "red", label: "Red", token: "--ff-pdf-icon", hex: "#dc2626" },
  { id: "amber", label: "Amber", token: "--ff-tag-section-text", hex: "#b45309" },
  { id: "green", label: "Green", token: "--ff-folder-green-text", hex: "#166534" },
  { id: "blue", label: "Blue", token: "--ff-blue-active", hex: "#2563eb" },
  { id: "violet", label: "Violet", token: "--ff-folder-violet-text", hex: "#5b21b6" },
  { id: "ink", label: "Dark", token: "--ff-text-primary", hex: "#374151" },
];

export const DEFAULT_COLOUR = MARKUP_COLOURS[0].hex;
