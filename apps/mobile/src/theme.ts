/** Resolve a CSS custom property (the web `--ff-*` tokens, see styles.css) for canvas drawing. */
const cache = new Map<string, string>();

export function cssVar(name: string, fallback: string): string {
  const hit = cache.get(name);
  if (hit) return hit;
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!v) return fallback;
  cache.set(name, v);
  return v;
}
