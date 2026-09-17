const sorted = (xs) => [...xs].sort((a, b) => a - b);

function quantile(xs, q) {
  const s = sorted(xs);
  if (s.length === 0) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (xs) => quantile(xs, 0.5);
export const iqr = (xs) => [quantile(xs, 0.25), quantile(xs, 0.75)];
export const savedPct = (browser, headless) =>
  Number.isFinite(browser) && browser !== 0 && Number.isFinite(headless) ? ((browser - headless) / browser) * 100 : null;
