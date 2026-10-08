/** Asset imports in the Electron shell (tray icon). Bundled by esbuild; this is type-level only. */
declare module '*.png' {
  const url: string;
  export default url;
}
