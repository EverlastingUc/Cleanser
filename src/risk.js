export const CHANGE_RISK = Object.freeze({
  SAFE: "SAFE",
  LOW: "LOW",
  REVIEW: "REVIEW",
});

export const CHANGE_CONFIDENCE = Object.freeze({
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
});

export function classifyChange({
  kind = "format",
  astEquivalent,
  requiresReview = false,
} = {}) {
  if (
    requiresReview ||
    kind === "semantic-refactor" ||
    kind === "destructive" ||
    (kind === "format" && astEquivalent === false)
  ) {
    return CHANGE_RISK.REVIEW;
  }
  if (kind === "format" && astEquivalent === true) {
    return CHANGE_RISK.SAFE;
  }
  return CHANGE_RISK.LOW;
}

export function classifyConfidence({
  astEquivalent,
  parserAvailable = true,
} = {}) {
  if (parserAvailable === false) return CHANGE_CONFIDENCE.LOW;
  if (typeof astEquivalent === "boolean") return CHANGE_CONFIDENCE.HIGH;
  return CHANGE_CONFIDENCE.MEDIUM;
}
