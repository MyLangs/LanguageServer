"use strict";

/** Levenshtein distance, early-exits above `max`. */
function distance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
      if (prev[j] < rowMin) rowMin = prev[j];
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

/** Best "did you mean" candidate or null. */
function closest(name, candidates) {
  const lower = name.toLowerCase();
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const cl = c.toLowerCase();
    const d = cl === lower ? 0 : distance(lower, cl, 2);
    if (d <= 2 && d < bestScore && d < Math.max(2, Math.ceil(name.length / 2))) {
      best = c;
      bestScore = d;
    }
  }
  return best;
}

/** "name(a, b?, ...rest)" */
function formatParams(params) {
  if (!params) return "...";
  return params.map((p) => (p.rest ? "..." : "") + p.name + (p.optional ? "?" : "")).join(", ");
}

module.exports = { distance, closest, formatParams };
