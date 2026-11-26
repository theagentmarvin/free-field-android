import { useEffect } from "react";
import { App as CapApp } from "@capacitor/app";
import { useLinkCompletion } from "./useLinkCompletion";

/**
 * Completes email-link sign-in when Android hands the app a link: while it
 * runs (`appUrlOpen`) or when it was cold-started by one (`getLaunchUrl`).
 * Renders nothing. Only mounted for cloud (non-demo) auth.
 */
export function AuthLinkHandler() {
  const complete = useLinkCompletion();
  useEffect(() => {
    void CapApp.getLaunchUrl()
      .then((l) => (l?.url ? complete(l.url) : undefined))
      .catch(() => undefined);
    const sub = CapApp.addListener("appUrlOpen", (e) => void complete(e.url));
    return () => {
      void sub.then((h) => h.remove());
    };
  }, [complete]);
  return null;
}
