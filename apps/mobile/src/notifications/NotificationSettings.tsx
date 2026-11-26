import { useEffect, useState } from "react";
import { App as CapApp } from "@capacitor/app";
import { localNotifier } from "./platform";
import { CATEGORY_LABELS, updateSettings, useNotifySettings, type NotifyCategory } from "./settings";
import "./notifications.css";

type Perm = "granted" | "denied" | "prompt";

/** More tab: master switch, one switch per category, and the OS permission state. Everything is stored on the device. */
export function NotificationSettings() {
  const s = useNotifySettings();
  const [perm, setPerm] = useState<Perm | null>(null);

  useEffect(() => {
    const read = () => void localNotifier.permission().then(setPerm);
    read();
    // coming back from the system settings page
    const sub = CapApp.addListener("resume", read);
    return () => void sub.then((h) => h.remove());
  }, []);

  async function setMaster(on: boolean) {
    updateSettings({ master: on });
    if (on) {
      await localNotifier.ensurePermission();
      setPerm(await localNotifier.permission());
      updateSettings({}); // re-plan deadline alarms now that the permission may have changed
    }
  }

  const cats = Object.keys(CATEGORY_LABELS) as NotifyCategory[];
  return (
    <div className="notify-settings" data-testid="notify-settings">
      <ul className="list">
        <li className="notify-row notify-master">
          <div className="notify-text">
            <span className="notify-label" id="notify-master-label">Task notifications</span>
            <span className="muted notify-hint">On this device, when the app syncs</span>
          </div>
          <Switch checked={s.master} labelledBy="notify-master-label" testId="notify-master" onChange={(v) => void setMaster(v)} />
        </li>
        {cats.map((c) => (
          <li key={c} className="notify-row" data-disabled={!s.master || undefined}>
            <div className="notify-text">
              <span className="notify-label" id={`notify-${c}-label`}>{CATEGORY_LABELS[c].label}</span>
              <span className="muted notify-hint">{CATEGORY_LABELS[c].hint}</span>
            </div>
            <Switch checked={s[c]} disabled={!s.master} labelledBy={`notify-${c}-label`} testId={`notify-${c}`} onChange={(v) => updateSettings({ [c]: v })} />
          </li>
        ))}
      </ul>
      {s.master && perm === "denied" && (
        <p className="notify-note" data-testid="notify-denied">
          Notifications are blocked for this app in the system settings, so nothing will be shown until you allow them there.
        </p>
      )}
      {s.master && perm === "prompt" && (
        <p className="notify-note" data-testid="notify-prompt">
          Android will ask for permission the first time there is something to tell you.{" "}
          <button className="notify-link" data-testid="notify-allow" onClick={() => void localNotifier.ensurePermission().then(() => localNotifier.permission().then(setPerm))}>
            Allow now
          </button>
        </p>
      )}
    </div>
  );
}

function Switch({ checked, disabled, onChange, labelledBy, testId }: { checked: boolean; disabled?: boolean; onChange(v: boolean): void; labelledBy: string; testId: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      data-testid={testId}
      className="notify-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="notify-knob" />
    </button>
  );
}
