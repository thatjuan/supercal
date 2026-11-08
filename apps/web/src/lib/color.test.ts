import { describe, expect, test } from 'vitest';
import { AA, contrast, eventColors, type Theme } from './color.ts';

/** Typical calendar colours, including the hard middle tones (yellow, cyan, grey) and both extremes. */
const SAMPLES = ['#4285f4', '#0b8043', '#f4511e', '#8e24aa', '#d50000', '#039be5', '#f6bf26', '#33b679', '#e67c73', '#616161', '#ffffff', '#000000'];

describe('eventColors', () => {
  for (const theme of ['light', 'dark'] satisfies Theme[]) {
    test.each(SAMPLES)(`%s keeps AA text on its ${theme} block`, (color) => {
      const { background, text } = eventColors(color, theme);
      expect(contrast(text, background)).toBeGreaterThanOrEqual(AA);
    });
  }

  test('text keeps the calendar hue rather than going straight to black or white', () => {
    expect(eventColors('#4285f4', 'light').text).not.toBe('#000000');
    expect(eventColors('#4285f4', 'dark').text).not.toBe('#ffffff');
  });

  test('an unparseable colour falls back to a neutral block', () => {
    expect(eventColors('not-a-colour', 'light')).toEqual(eventColors('#6b7280', 'light'));
  });
});
