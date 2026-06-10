export function calculateOverallScore(property) {
  const scores = [
    property.score_location || 0,
    property.score_quality || 0,
    property.score_commute || 0,
    property.score_value || 0,
    property.score_future_fit || 0,
  ];

  const average =
    scores.reduce((total, score) => total + score, 0) /
    scores.length;

  return Math.round(average * 10);
}