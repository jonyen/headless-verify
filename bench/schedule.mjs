function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

function shuffle(xs, random) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function schedule({ tasks, runs, seed }) {
  const random = rng(seed);
  const out = [];
  // Alternate which variant gets the extra run (odd `runs`) by task position,
  // so across tasks the ok/bug split is as close to half as possible.
  for (const [t, task] of shuffle(tasks, random).entries()) {
    const first = t % 2 === 0 ? 'ok' : 'bug';
    const second = first === 'ok' ? 'bug' : 'ok';
    const variants = shuffle(
      Array.from({ length: runs }, (_, i) => (i % 2 === 0 ? first : second)),
      random,
    );
    for (let run = 0; run < runs; run++) {
      const order = run % 2 === 0 ? ['browser', 'headless'] : ['headless', 'browser'];
      for (const arm of order) out.push({ task, arm, variant: variants[run], run });
    }
  }
  return out;
}
