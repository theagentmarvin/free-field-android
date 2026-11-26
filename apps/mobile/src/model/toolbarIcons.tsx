import type { ReactNode } from "react";
import type { ToolbarItem } from "./toolbarLayout";

const svg = (children: ReactNode) => (
  <svg className="tb-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

/** Inline icons (no icon font, no network). */
export const TB_ICONS: Record<ToolbarItem | "list", ReactNode> = {
  fit: svg(
    <>
      <path d="M4 9V5h4M16 5h4v4M20 15v4h-4M8 19H4v-4" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </>,
  ),
  reset: svg(
    <>
      <path d="M4 12a8 8 0 1 0 2.6-5.9" />
      <path d="M4 4v4.5h4.5" />
    </>,
  ),
  walk: svg(
    <>
      <circle cx="13" cy="4.5" r="1.8" />
      <path d="M12 8.5l-2.5 4 3 2.5-1 5M12 8.5l3 3.5 3 .5M9.5 12.5l-2.5 1" />
    </>,
  ),
  measure: svg(
    <>
      <path d="M3.5 16.5l13-13 4 4-13 13z" />
      <path d="M7 13l2 2M10 10l1.5 1.5M13 7l2 2" />
    </>,
  ),
  tools: svg(
    <>
      <path d="M14.5 6.2a4 4 0 0 0 4.9 4.9L14 16.5 7.5 10l4.9-5.4z" />
      <path d="M7.5 10L3.5 14l2.5 2.5 4-4" />
      <path d="M12 17l5 4" />
    </>,
  ),
  list: svg(
    <>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="18" r="1" />
    </>,
  ),
};

