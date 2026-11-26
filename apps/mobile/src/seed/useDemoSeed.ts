import { useEffect, useState } from "react";
import { seedDemoIfEmpty } from "./demoSeed";

/** Runs the demo seed once; `ready` flips when it settles (success or not). */
export function useDemoSeed(): { ready: boolean; result: string | null } {
  const [state, setState] = useState<{ ready: boolean; result: string | null }>({ ready: false, result: null });
  useEffect(() => {
    let live = true;
    void seedDemoIfEmpty().then((result) => live && setState({ ready: true, result }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}
