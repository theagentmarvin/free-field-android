import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { App as CapApp } from "@capacitor/app";
import { decideBack } from "./backNav";
import { runBackGuard } from "./backGuard";

/** Owns the hardware Back button for the signed-in app (see `backNav.ts`). */
export function BackButtonController() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const path = useRef(pathname);
  path.current = pathname;

  useEffect(() => {
    const sub = CapApp.addListener("backButton", () => {
      if (runBackGuard()) return;
      const idx = (window.history.state as { idx?: unknown } | null)?.idx;
      const action = decideBack(path.current, typeof idx === "number" ? idx : null);
      if (action.type === "history") navigate(-1);
      else if (action.type === "navigate") navigate(action.to);
      else void CapApp.exitApp();
    });
    return () => void sub.then((h) => h.remove());
  }, [navigate]);
  return null;
}
