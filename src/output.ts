// Minimal ANSI helpers. Colour is resolved lazily (per call) so the CLI can flip
// it from a `--color`/`--no-color` flag at startup. Precedence: explicit override
// (the flags) → NO_COLOR (off) → FORCE_COLOR (on) → stdout is a TTY.
let override: boolean | undefined;

/** Force colour on/off, overriding env + TTY detection. `undefined` clears it. */
export function setColorOverride(value: boolean | undefined): void {
  override = value;
}

function useColor(): boolean {
  if (override !== undefined) return override;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

const ESC = '\x1b';
const wrap =
  (open: number, close: number) =>
  (s: string): string =>
    useColor() ? `${ESC}[${open}m${s}${ESC}[${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const cyan = wrap(36, 39);
export const green = wrap(32, 39);
export const red = wrap(31, 39);
export const yellow = wrap(33, 39);
