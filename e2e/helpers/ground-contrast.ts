import type { Page } from '@playwright/test';

export interface GroundContrastRow {
  node: string;
  text: string;
  min: number;
  /** Against the nearest opaque background: own and ancestor fills over the body's background-color. */
  overNearestOpaque: number;
  /** Against the lightest colour the body's background-image can put behind it. */
  overLightestGround: number;
}

export interface GroundContrast {
  bodyColour: number[];
  lightestGround: number[];
  stopsRead: string[];
  measured: number;
  rows: GroundContrastRow[];
  failures: string[];
}

/**
 * Text contrast against a page ground painted as a body `background-image`,
 * computed by hand because axe will not compute contrast over a background
 * image: it files that text under `incomplete`, and nothing fails on that
 * bucket (the My Bookings blind spot, then the dark Admin ground).
 *
 * For every element matched by `selectors`, and every descendant carrying its
 * own text, the text colour and each fill between it and the body (with any
 * opacity) are composited over
 *   - the body's background-color: the nearest opaque background when no
 *     ancestor is opaque, and
 *   - the LIGHTEST colour the body's background-image can reach: for each
 *     image layer, bottom first, the gradient stop that most lightens what is
 *     under it, read from the computed style - so brightening a stop moves
 *     this bound with it.
 * Text is judged at 4.5:1, or 3:1 when WCAG-large (>= 24px, or >= 18.66px at
 * weight 700+). `failures` lists every node under its minimum on either.
 */
export const measureGroundContrast = (page: Page, selectors: string[]): Promise<GroundContrast> =>
  page.evaluate((targets) => {
    const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const rgba = (css: string): number[] => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = '#000';
      canvas.fillStyle = css;
      canvas.fillRect(0, 0, 1, 1);
      const d = canvas.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[3] * top[i] + (1 - top[3]) * under[i]);
    const mix = (o: number, a: number[], b: number[]) => [0, 1, 2].map((i) => o * a[i] + (1 - o) * b[i]);
    const lum = ([r, g, b]: number[]) => {
      const ch = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const splitTop = (s: string) => {
      const out: string[] = [];
      let depth = 0;
      let cur = '';
      for (const ch of s) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) {
          out.push(cur.trim());
          cur = '';
        } else cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    };
    const bodyStyle = getComputedStyle(document.body);
    const bodyColour = over(rgba(bodyStyle.backgroundColor), [255, 255, 255]);
    const layers = bodyStyle.backgroundImage === 'none' ? [] : splitTop(bodyStyle.backgroundImage);
    const stopRe = /(?:rgba?|color|hsla?|oklch|oklab|lab|lch)\([^()]*\)/g;
    let lightest = bodyColour;
    const stopsRead: string[] = [];
    for (const layer of [...layers].reverse()) {
      let best = lightest;
      for (const stop of layer.match(stopRe) ?? []) {
        stopsRead.push(stop);
        const c = over(rgba(stop), lightest);
        if (lum(c) > lum(best)) best = c;
      }
      lightest = best;
    }
    const judge = (el: Element, ground: number[]) => {
      const chain: Element[] = [];
      for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) chain.unshift(e);
      let bg = ground;
      const groups: Array<{ o: number; under: number[] }> = [];
      for (const e of chain) {
        const cs = getComputedStyle(e);
        const o = parseFloat(cs.opacity);
        if (o < 1) groups.push({ o, under: bg });
        bg = over(rgba(cs.backgroundColor), bg);
      }
      let text = over(rgba(getComputedStyle(el).color), bg);
      for (const g of groups.reverse()) {
        text = mix(g.o, text, g.under);
        bg = mix(g.o, bg, g.under);
      }
      return ratio(text, bg);
    };
    // Each target plus its descendants that carry their own text: axe names the
    // element whose text it could not judge, and a named container stands for
    // the text inside it.
    const seen = new Set<Element>();
    for (const t of targets) {
      for (const root of document.querySelectorAll(t)) {
        for (const el of [root, ...root.querySelectorAll('*')]) seen.add(el);
      }
    }
    const nodes = [...seen].filter((el) => {
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
      const r = el.getBoundingClientRect();
      const screenReaderOnly = getComputedStyle(el).clip !== 'auto';
      return own && !screenReaderOnly && r.width > 1 && r.height > 1 && el.checkVisibility({ visibilityProperty: true });
    });
    const rows = nodes.map((el) => {
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
      return {
        node: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`,
        text: (el.textContent ?? '').trim().slice(0, 40),
        min: large ? 3 : 4.5,
        overNearestOpaque: +judge(el, bodyColour).toFixed(2),
        overLightestGround: +judge(el, lightest).toFixed(2),
      };
    });
    return {
      bodyColour: bodyColour.map(Math.round),
      lightestGround: lightest.map(Math.round),
      stopsRead,
      measured: rows.length,
      rows,
      failures: rows
        .filter((r) => r.overNearestOpaque < r.min || r.overLightestGround < r.min)
        .map((r) => `${r.node} "${r.text}": ${r.overNearestOpaque} / ${r.overLightestGround} under ${r.min}`),
    };
  }, selectors);
