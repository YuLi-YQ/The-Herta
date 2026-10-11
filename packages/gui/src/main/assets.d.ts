/**
 * electron-vite asset imports for the MAIN process: `?asset` copies the
 * file into the build output and resolves the import to its absolute path
 * at runtime (used for the window icon). Type-only — electron-vite owns
 * the actual transform.
 */
declare module "*.png?asset" {
  const path: string;
  export default path;
}
