/** Vite asset imports used by the website sources. */
declare module "*.opus" {
  const url: string;
  export default url;
}

/** Build stamp injected by vite.config `define` — cache-busts the demo
 *  iframe URL per deploy (GitHub Pages caches HTML ~10 min; a stale
 *  demo.html referenced disk-cached old chunks and showed the previous
 *  demo next to a fresh landing page, seen live 2026-07-12). */
declare const __BUILD_ID__: string;
