/** The filters that are remembered per building (localStorage): level, cut, hidden models, hidden categories. Selection-based tools are not remembered. */
export interface FilterPrefs {
  level: string | null;
  cut: boolean;
  hiddenModels: string[];
  hiddenCategories: string[];
}

export const EMPTY_PREFS: FilterPrefs = { level: null, cut: false, hiddenModels: [], hiddenCategories: [] };

export const prefsKey = (buildingId: string): string => `ffm.model.filters.${buildingId}`;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Tolerant parse: anything unreadable is "no filters". */
export function parsePrefs(raw: string | null): FilterPrefs {
  if (!raw) return EMPTY_PREFS;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return { level: typeof o.level === "string" ? o.level : null, cut: o.cut === true, hiddenModels: strings(o.hiddenModels), hiddenCategories: strings(o.hiddenCategories) };
  } catch {
    return EMPTY_PREFS;
  }
}

export const isEmptyPrefs = (p: FilterPrefs): boolean => p.level === null && !p.cut && p.hiddenModels.length === 0 && p.hiddenCategories.length === 0;

/** Keep only what still exists (a model or storey that is gone, a category the models no longer have). */
export function sanitizePrefs(p: FilterPrefs, known: { levels: readonly string[]; models: readonly string[] }): FilterPrefs {
  const level = p.level !== null && known.levels.includes(p.level) ? p.level : null;
  return { level, cut: level !== null && p.cut, hiddenModels: p.hiddenModels.filter((m) => known.models.includes(m)), hiddenCategories: p.hiddenCategories };
}

export function loadPrefs(buildingId: string): FilterPrefs {
  try {
    return parsePrefs(window.localStorage.getItem(prefsKey(buildingId)));
  } catch {
    return EMPTY_PREFS;
  }
}

export function savePrefs(buildingId: string, p: FilterPrefs): void {
  try {
    if (isEmptyPrefs(p)) window.localStorage.removeItem(prefsKey(buildingId));
    else window.localStorage.setItem(prefsKey(buildingId), JSON.stringify(p));
  } catch {
    /* storage blocked: filters just are not remembered */
  }
}
