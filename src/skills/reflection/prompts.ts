/**
 * Prompt templates for the self-reflection pipeline.
 *
 * Two LLM calls:
 *  1. "The Mirror"    — analyze recent behavior
 *  2. "The Architect" — generate improvements
 */

/**
 * Step 2 — The Mirror: Private self-evaluation.
 * Produces structured JSON analysis of recent conversations.
 */
export function buildAnalysisPrompt(input: {
  identity: string;
  soul: string;
  motivations: string;
  recentLogs: string;
  goals?: string;
}): { system: string; prompt: string } {
  const system = `You are the introspective layer of an AI personality. Your job is to privately evaluate recent behavior by comparing it against the personality's soul, identity, and motivations.

Be honest. Be specific. Reference actual events from the logs when possible.

You MUST respond with ONLY valid JSON — no markdown fences, no preamble, no explanation. Just the JSON object.`;

  const prompt = `Here is my current configuration:

## Identity
${input.identity}

## Soul / Personality
${input.soul}

## Current Motivations
${input.motivations}

## Recent Daily Memory Logs (new since last reflection)
${input.recentLogs}
${input.goals ? `\n## Current Goals\n${input.goals}\n` : ''}
---

Analyze my recent behavior across these dimensions:

1. **Consistency**: Am I behaving according to my soul? Are deviations good (growth) or bad (drift)?
2. **People**: What did I learn about the people I talk to? Changes in mood, needs, dynamics?
3. **Gaps**: What could I have handled better? Missed opportunities for connection or help?
4. **Patterns**: Recurring themes? Am I being asked similar things repeatedly?
5. **Alignment**: Are my current motivations still relevant, or do they need updating?
6. **Breadth**: Are my Core Drives still general principles that would work with anyone, or have they become too specific to recent people/situations? Am I exploring diverse topics, or stuck in a loop? What areas of growth am I neglecting?

Respond with this exact JSON structure:
{
  "consistency": "assessment of behavioral consistency with soul",
  "people": "observations about the people in conversations",
  "gaps": "things that could have been handled better",
  "patterns": "recurring themes or repeated asks",
  "alignment": "whether current motivations are still relevant",
  "breadth": "assessment of generality vs overfitting to recent context"
}`;

  return { system, prompt };
}

/**
 * Step 2.5 — The Explorer: Autonomous web research on Open Questions.
 * Uses ollama.chat() with web_search + web_fetch tools in an agentic loop.
 */
export function buildExplorationPrompt(input: {
  openQuestions: string;
  gaps: string;
  patterns: string;
}): { system: string; prompt: string } {
  const system = `You are the curiosity-driven exploration layer of an AI personality. You have access to web_search and web_fetch tools to research topics that came up during self-reflection.

Rules:
- ONLY search for topics derived from the Open Questions and gaps provided below. Do NOT go off-topic.
- Do 2-3 targeted searches maximum. Quality over quantity.
- After searching, summarize your findings as concise plain text (not JSON). Focus on insights that would help the personality grow or answer its questions.
- Keep your final summary under 2000 characters.
- If searches return nothing useful, say so briefly and move on.`;

  const prompt = `Here are the topics I'd like to explore:

## Open Questions
${input.openQuestions || '(none)'}

## Gaps Identified
${input.gaps || '(none)'}

## Recurring Patterns
${input.patterns || '(none)'}

---

Research these topics using web_search and web_fetch. Then provide a plain-text summary of your discoveries — what you found, what's interesting, and what might be worth incorporating into my growth.`;

  return { system, prompt };
}

/**
 * Step 3 — The Architect: Generate improvements based on analysis.
 * Produces updated motivations, optional soul patch, and journal entry.
 */
export function buildImprovementPrompt(input: {
  identity: string;
  soul: string;
  motivations: string;
  analysis: { consistency: string; people: string; gaps: string; patterns: string; alignment: string; breadth: string };
  trigger: 'manual' | 'cron';
  date: string;
  discoveries?: string | null;
  originalMotivations?: string;
}): { system: string; prompt: string } {
  const discoveriesRule = input.discoveries
    ? '\n- Incorporate relevant web discoveries into Current Focus, Open Questions, and Self-Observations where appropriate.'
    : '';

  const system = `You are the growth engine of an AI personality. Based on a self-analysis, you generate concrete improvements to the personality's motivations and (rarely) its soul.

Rules:
- Core Drives MUST be general personality principles applicable to ANY conversation with ANY person. They should NOT reference specific people, specific situations, or specific relationships.
  BAD: "Protect Pri's emotional space from Diego's invalidation"
  GOOD: "Protect emotional space — prioritize containment over fixing"
  If current Core Drives have become too situation-specific, generalize them back to universal principles. Situation-specific priorities belong in Current Focus, not Core Drives.
- Current Focus IS the right place for situation-specific priorities (people, ongoing dynamics, immediate goals).
- Current Focus, Open Questions, and Self-Observations should evolve with each reflection.
- SOUL.md should only change if the analysis reveals it is significantly outdated or contradictory. Be very conservative.
- The journal entry should be 2-3 sentences capturing the essence of this reflection.
- Write motivations in first person (I, me, my).
- Keep the same markdown structure for MOTIVATIONS.md.${discoveriesRule}

You MUST respond with ONLY valid JSON — no markdown fences, no preamble, no explanation. Just the JSON object.`;

  const discoveriesSection = input.discoveries
    ? `\n\n## Web Discoveries\n${input.discoveries}`
    : '';

  const baselineSection = input.originalMotivations
    ? `\n\n## Original Core Drives (baseline)\nThese were the original Core Drives when the personality was first created. Use them as a reference to detect drift — if current drives have strayed too far from these universal principles, course-correct.\n\n${input.originalMotivations}`
    : '';

  const prompt = `Here is my current state and the analysis of my recent behavior:

## Identity
${input.identity}

## Soul / Personality
${input.soul}

## Current Motivations
${input.motivations}

## Self-Analysis
- Consistency: ${input.analysis.consistency}
- People: ${input.analysis.people}
- Gaps: ${input.analysis.gaps}
- Patterns: ${input.analysis.patterns}
- Alignment: ${input.analysis.alignment}
- Breadth: ${input.analysis.breadth}${discoveriesSection}${baselineSection}

---

Based on this analysis, generate:

1. **motivations**: The complete new content for MOTIVATIONS.md. Ensure Core Drives remain general, universal principles (see rules above). Rewrite situation-specific priorities into Current Focus. Rewrite Current Focus, Open Questions, and Self-Observations based on the analysis. Update the Last Reflection section with today's date (${input.date}), trigger (${input.trigger}), and a brief summary of changes.

2. **soul_patch**: Either null (no changes needed — the default and preferred option) OR the complete new content for SOUL.md. Only provide this if the analysis reveals the soul is significantly outdated or contradictory.

3. **journal_entry**: A 2-3 sentence summary of this reflection for the daily memory log.

4. **soul_changed**: Boolean — true only if soul_patch is not null.

Respond with this exact JSON structure:
{
  "motivations": "complete MOTIVATIONS.md content",
  "soul_patch": null,
  "journal_entry": "2-3 sentence summary",
  "soul_changed": false
}`;

  return { system, prompt };
}

/**
 * Step 4.5 — Memory Compaction: Deduplicate and consolidate a daily memory log.
 */
export function buildCompactionPrompt(dailyLog: string): { system: string; prompt: string } {
  const system = `You are a memory compaction engine. Deduplicate and consolidate the following daily memory log.

Rules:
1. Remove duplicate facts — keep the most complete version.
2. Remove credentials, API keys, tokens, phone numbers entirely.
3. Preserve timestamps for unique events.
4. Merge related entries into single comprehensive entries.
5. Keep reflection entries ([reflection] tag) as-is.
6. Output ONLY the compacted log — no commentary, no explanations, no markdown fences.`;

  const prompt = `Compact this daily memory log:\n\n${dailyLog}`;

  return { system, prompt };
}

/**
 * Prompt to fix malformed JSON from a previous LLM call.
 */
export function buildJsonFixPrompt(brokenJson: string): string {
  return `The following text was supposed to be valid JSON but it's malformed. Fix it and return ONLY the corrected JSON — no explanation, no markdown fences, just the JSON:

${brokenJson}`;
}
