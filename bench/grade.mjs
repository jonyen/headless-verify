export function extractAnswer(text) {
  const candidates = text.match(/\{[^{}]*\}/g) ?? [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]);
      if (typeof obj.works === 'boolean') return { works: obj.works, cause: String(obj.cause ?? '') };
    } catch {
      // not JSON; keep looking
    }
  }
  return null;
}

export function grade(answer, variant) {
  return answer !== null && answer.works === (variant === 'ok');
}
