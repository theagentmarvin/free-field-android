/**
 * True only in e2e builds (VITE_FFM_TEST_HOOKS=true); never shipped to users. Written as the
 * literal `import.meta.env.X` so Vite replaces it at build time and the bundler drops every
 * guarded branch (and the lazily imported hook modules) from release builds.
 */
export const testHooksEnabled = (): boolean => import.meta.env.VITE_FFM_TEST_HOOKS === "true";
