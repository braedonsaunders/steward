function isMatchingJsonBracket(open: string, close: string): boolean {
  return (open === "{" && close === "}") || (open === "[" && close === "]");
}

export function stripWidgetOutputNoise(value: string): string {
  if (value.trim().length === 0) {
    return "";
  }

  const withoutClixml = value
    .replace(/^\uFEFF/, "")
    .replace(/#<\s*CLIXML[\s\S]*?(?=(?:\r?\n)*(?:\{|\[)|$)/gi, "");

  return withoutClixml
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("[preflight]"))
    .join("\n")
    .trim();
}

export function extractFirstJsonString(value: string): string | null {
  for (let start = 0; start < value.length; start += 1) {
    const first = value[start];
    if (first !== "{" && first !== "[") {
      continue;
    }

    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let cursor = start; cursor < value.length; cursor += 1) {
      const char = value[cursor];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      if (char !== "}" && char !== "]") {
        continue;
      }

      const open = stack.pop();
      if (!open || !isMatchingJsonBracket(open, char)) {
        break;
      }

      if (stack.length > 0) {
        continue;
      }

      const candidate = value.slice(start, cursor + 1).trim();
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        break;
      }
    }
  }

  return null;
}

export function parseWidgetOutputJson(value: string): unknown | null {
  const cleaned = stripWidgetOutputNoise(value);
  if (cleaned.length === 0) {
    return null;
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    const candidate = extractFirstJsonString(cleaned);
    if (!candidate) {
      return null;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}
