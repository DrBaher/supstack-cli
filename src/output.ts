// Minimal ANSI helpers. Honour NO_COLOR and non-TTY output (pipes, CI).
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const ESC = '';
const wrap =
  (open: number, close: number) =>
  (s: string): string =>
    useColor ? `${ESC}[${open}m${s}${ESC}[${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const cyan = wrap(36, 39);
export const red = wrap(31, 39);
export const yellow = wrap(33, 39);
