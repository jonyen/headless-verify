export function extractAnswer(text) {
  // Find all { positions, process from last to first
  const bracePositions = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      bracePositions.push(i);
    }
  }

  // Try each { from last to first
  for (let pos = bracePositions.length - 1; pos >= 0; pos--) {
    const startIdx = bracePositions[pos];

    // Scan forward from startIdx with fresh state to find matching }
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIdx; i < text.length; i++) {
      const char = text[i];

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
          depth++;
        } else if (char === '}') {
          depth--;
          if (depth === 0) {
            // Found matching }, try to parse
            const candidate = text.substring(startIdx, i + 1);
            try {
              const obj = JSON.parse(candidate);
              if (typeof obj.works === 'boolean') {
                return { works: obj.works, cause: String(obj.cause ?? '') };
              }
            } catch {
              // not valid JSON, continue to next position
            }
            break;
          }
        }
      }
    }
  }
  return null;
}

export function grade(answer, variant) {
  return answer !== null && answer.works === (variant === 'ok');
}
