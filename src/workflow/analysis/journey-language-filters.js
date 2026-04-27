/**
 * Drop journey/leg copy where the model hedges or invents UI that may not exist.
 * Ground truth is Playwright structural JSON + screenshot as context only.
 */

export function textLooksSpeculativeOrConditional(value) {
  const s = String(value || '');
  if (!s.trim()) return false;
  return (
    /\b(if available|if present|if exists|if any|if applicable|if possible|if needed|if the (page|site|app)|where applicable|when applicable|when possible|when needed)\b/i.test(
      s,
    ) ||
    /(\(e\.g[.\s]|e\.g\.|e\.g\s|eg\.|such as|for example|for instance)\b/i.test(s) ||
    /\b(try to|attempt to|optionally|optional:?|similar to|including but not limited to)\b/i.test(s) ||
    /\b(might want|may want|you can try|feel free to|consider (trying|using)|assume |assuming )\b/i.test(s)
  );
}

export function filterJourneysAgainstSpeculativeLanguage(journeys) {
  if (!Array.isArray(journeys) || journeys.length === 0) return journeys;
  const out = [];
  for (const journey of journeys) {
    if (!journey || typeof journey !== 'object') continue;
    const summaryText = [
      journey.description,
      journey.test_instructions,
      journey.expected_outcome,
      journey.journey_id,
      ...(Array.isArray(journey.actions)
        ? journey.actions.map(
            (a) =>
              `${a?.description || ''} ${a?.test_instructions || ''} ${a?.expected_outcome || ''} ${a?.type || ''}`,
          )
        : []),
    ].join(' ');
    if (textLooksSpeculativeOrConditional(summaryText)) {
      console.warn(
        `⚠️ [JOURNEYS-QUALITY] Dropping speculative/conditional journey "${journey.journey_id || journey.description || 'unknown'}"`,
      );
      continue;
    }
    out.push(journey);
  }
  if (out.length !== journeys.length) {
    console.warn(
      `⚠️ [JOURNEYS-QUALITY] Speculative language filter: ${journeys.length} → ${out.length} journey(s)`,
    );
  }
  return out;
}

export function filterLegsAgainstSpeculativeLanguage(legs) {
  if (!Array.isArray(legs) || legs.length === 0) return legs;
  const out = [];
  for (const leg of legs) {
    if (!leg || typeof leg !== 'object') continue;
    const blob = [
      leg.description,
      leg.test_instructions,
      leg.expected_outcome,
      leg.leg_id,
      leg.type,
    ].join(' ');
    if (textLooksSpeculativeOrConditional(blob)) {
      console.warn(`⚠️ [JOURNEYS-QUALITY] Dropping speculative/conditional leg "${leg.leg_id || leg.description || 'unknown'}"`);
      continue;
    }
    out.push(leg);
  }
  if (out.length !== legs.length) {
    console.warn(`⚠️ [JOURNEYS-QUALITY] Speculative language filter (legs): ${legs.length} → ${out.length} leg(s)`);
  }
  return out;
}
