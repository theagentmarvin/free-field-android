import type { ReactNode } from "react";

/** Small 24 px line icons for the annotation tools (stroke = currentColor, so they follow the button state). */
const Svg = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IconPen = () => (
  <Svg>
    <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z" />
    <path d="M14 7l3 3" />
  </Svg>
);
export const IconHighlight = () => (
  <Svg>
    <path d="M9 15l-4 4h5l1-1" />
    <path d="M10 14l6.5-6.5 3 3L13 17z" />
    <path d="M5 21h14" opacity="0.45" />
  </Svg>
);
export const IconArrow = () => (
  <Svg>
    <path d="M5 19L19 5" />
    <path d="M9 5h10v10" />
  </Svg>
);
export const IconRect = () => (
  <Svg>
    <rect x="4" y="6" width="16" height="12" rx="1" />
  </Svg>
);
export const IconEllipse = () => (
  <Svg>
    <ellipse cx="12" cy="12" rx="8.5" ry="6" />
  </Svg>
);
export const IconCloud = () => (
  <Svg>
    <path d="M7 17a4 4 0 01-.6-7.9A5 5 0 0116 8a4.5 4.5 0 011 8.9z" />
  </Svg>
);
export const IconText = () => (
  <Svg>
    <path d="M5 7V5h14v2" />
    <path d="M12 5v14" />
    <path d="M9 19h6" />
  </Svg>
);
export const IconUndo = () => (
  <Svg>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10a6 6 0 010 12h-3" />
  </Svg>
);
export const IconRedo = () => (
  <Svg>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H10a6 6 0 000 12h3" />
  </Svg>
);
export const IconTrash = () => (
  <Svg>
    <path d="M5 7h14" />
    <path d="M9 7V4h6v3" />
    <path d="M7 7l1 13h8l1-13" />
  </Svg>
);
