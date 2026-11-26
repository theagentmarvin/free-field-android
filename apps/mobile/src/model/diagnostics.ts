export interface GlInfo {
  webgl2: boolean;
  renderer: string | null;
  vendor: string | null;
  maxTextureSize: number | null;
}

export function webgl2Info(): GlInfo {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    if (!gl) return { webgl2: false, renderer: null, vendor: null, maxTextureSize: null };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const info: GlInfo = {
      webgl2: true,
      renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
      vendor: ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR)),
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return info;
  } catch {
    return { webgl2: false, renderer: null, vendor: null, maxTextureSize: null };
  }
}

/** Chromium-only; undefined elsewhere. */
export function jsHeapMb(): number | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? Math.round((m.usedJSHeapSize / 1048576) * 10) / 10 : null;
}
