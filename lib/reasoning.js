function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function applyReasoningSummary(body, enabled) {
  if (!enabled) return body;
  if (!Object.hasOwn(body, 'input') || !isPlainObject(body.reasoning)) return body;
  if (
    Object.hasOwn(body.reasoning, 'summary') ||
    Object.hasOwn(body.reasoning, 'generate_summary')
  ) {
    return body;
  }

  return {
    ...body,
    reasoning: {
      ...body.reasoning,
      summary: 'auto',
    },
  };
}
