import { useEffect, useState } from "react";
import { markLayoutSwitch } from "../tasks/layoutSwitch";

/** Tablet split-view breakpoint in dp (CSS px in the WebView). */
export const TABLET_MIN_DP = 840;

export function isTabletWidth(width: number): boolean {
  return width >= TABLET_MIN_DP;
}

export function useIsTablet(): boolean {
  const [tablet, setTablet] = useState(() => isTabletWidth(window.innerWidth));
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${TABLET_MIN_DP}px)`);
    // screens below remount when the layout flips: tell open forms to carry their draft over (see tasks/layoutSwitch.ts)
    const on = () => setTablet((prev) => {
      if (prev !== mq.matches) markLayoutSwitch();
      return mq.matches;
    });
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return tablet;
}
