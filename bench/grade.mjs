export function extractAnswer(text) {
  const candidates = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Handle string escape sequences
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        if (depth === 0) {
          start = i;
        }
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          candidates.push(text.substring(start, i + 1));
          start = -1;
        }
      }
    }
  }

  // Try candidates from last to first
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
