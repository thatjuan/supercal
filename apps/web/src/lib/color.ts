/**
 * Legible colours for user-chosen calendar colours. Event blocks are a tint of the calendar colour
 * on the theme's surface, with text that is the same hue pushed toward black (light) or white
 * (dark) until it meets WCAG AA (4.5:1) against that tint.
 */
export type Theme = 'light' | 'dark';
type Rgb = readonly [number, number, number];

/** WCAG AA for normal-size text. */
export const AA = 4.5;

/** Surfaces that event blocks sit on; keep in step with `--surface` in `styles/tokens.css`. */
const SURFACE: Record<Theme, Rgb> = { light: [255, 255, 255], dark: [23, 25, 28] };
const TEXT_TARGET: Record<Theme, Rgb> = { light: [0, 0, 0], dark: [255, 255, 255] };
/** How much of the calendar colour goes into a block's background. */
const TINT: Record<Theme, number> = { light: 0.16, dark: 0.34 };
const FALLBACK: Rgb = [107, 114, 128];

const rgb = (channel: (index: 0 | 1 | 2) => number): Rgb => [channel(0), channel(1), channel(2)];

/** `#rgb` or `#rrggbb` as RGB, or null for anything else. */
export function parseHex(color: string): Rgb | null {
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
  return rgb((i) => Number.parseInt(full.slice(i * 2, i * 2 + 2), 16));
}

const toHex = (color: Rgb) => `#${color.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

/** `amount` of `a` mixed into `b`. */
const mix = (a: Rgb, b: Rgb, amount: number) => rgb((i) => a[i] * amount + b[i] * (1 - amount));

const linear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** The WCAG contrast ratio between two `#rrggbb` colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(parseHex(a) ?? FALLBACK), luminance(parseHex(b) ?? FALLBACK)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Background, text and accent (the calendar colour itself, for the edge stripe) of an event block. */
export function eventColors(color: string, theme: Theme) {
  const base = parseHex(color) ?? FALLBACK;
  const background = toHex(mix(base, SURFACE[theme], TINT[theme]));
  let text = toHex(TEXT_TARGET[theme]);
  for (let push = 0.45; push < 1; push += 0.05) {
    const candidate = toHex(mix(TEXT_TARGET[theme], base, push));
    if (contrast(candidate, background) >= AA) {
      text = candidate;
      break;
    }
  }
  return { background, text, accent: toHex(base) };
}
