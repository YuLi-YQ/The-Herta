/**
 * pdfjs-dist ships types for `legacy/build/pdf.mjs` (a re-export of the main
 * entry) but none for the worker module. We import the worker's handler
 * statically so rollup bundles it and pdfjs's Node "fake worker" finds it on
 * `globalThis.pdfjsWorker` instead of trying a dynamic import of a variable
 * path (ADR 0038 §3). The handler is opaque to us; only its identity matters.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
