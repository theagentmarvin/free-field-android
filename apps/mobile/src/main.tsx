import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { AuthProvider } from "@ff/auth";
import { App } from "./App";
import { startNetworkMonitor } from "./platform/network";
import { testHooksEnabled } from "./dev/flag";
import { appLog, installConsoleCapture } from "./diagnostics/logger";
import { bootRecovery } from "./recovery/recovery";
import { requestPersistence } from "./diagnostics/persist";
// Web design tokens, read-only from the vendored settings app (single source of truth).
import "../../../vendor/free-field/apps/settings/src/styles/tokens.css";
import "./styles.css";

installConsoleCapture(appLog, console, window);
startNetworkMonitor();
if (testHooksEnabled()) void import("./plans/debug").then((m) => m.installPlanDebugHook());
void requestPersistence().then((r) => appLog.info("storage persistence:", r));

// After a renderer death the native layer recreated the activity: restore the last route (and queue the notice) first.
void bootRecovery().finally(() =>
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <HashRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </HashRouter>
    </React.StrictMode>,
  ),
);
