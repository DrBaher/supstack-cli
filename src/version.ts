import pkg from '../package.json';

// Single source of truth for the CLI version — read from package.json so it can
// never drift. tsup/esbuild inlines this JSON at build time.
export const VERSION: string = pkg.version;
