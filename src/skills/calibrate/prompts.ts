import type { CalibrateScope } from './types';

/**
 * Prompt for extracting claims from soul files.
 * Returns JSON with { batches: [{ title, sourceFile, claims[] }] }.
 */
export function buildExtractionPrompt(input: {
  scope: CalibrateScope;
  files: { filename: string; content: string }[];
  maxBatches: number;
}): { system: string; prompt: string } {
  const system = `You are a claim extractor for an AI personality system. Your job is to read the personality files and extract every concrete claim, belief, preference, fact, or behavioral rule into reviewable batches.

Rules:
- Group related claims into batches of 3-5 items.
- Each batch needs a short descriptive title and the source file it came from.
- Each claim should be a single, self-contained statement that can be independently verified.
- Extract ALL claims, not just the important ones. Include facts about people, preferences, behavioral rules, self-observations, etc.
- Maximum ${input.maxBatches} batches total. Prioritize the most reviewable claims if you need to cut.
- You MUST respond with ONLY valid JSON — no markdown fences, no preamble, no explanation.`;

  const filesBlock = input.files
    .map((f) => `### ${f.filename}\n${f.content}`)
    .join('\n\n');

  const scopeNote = input.scope === 'all'
    ? 'Extract claims from ALL files.'
    : `Focus on claims from ${input.scope}-related content, but include cross-references from other files if relevant.`;

  const prompt = `Here are the personality files to analyze:

${filesBlock}

---

${scopeNote}

Extract claims and return this exact JSON structure:
{
  "batches": [
    {
      "title": "Short batch title",
      "sourceFile": "FILENAME.md",
      "claims": [
        "Claim 1 as a self-contained statement",
        "Claim 2 as a self-contained statement"
      ]
    }
  ]
}`;

  return { system, prompt };
}

/**
 * Prompt for rewriting soul files based on user corrections.
 * Returns JSON with { files: [{ filename, content }] }.
 */
export function buildRewritePrompt(input: {
  files: { filename: string; content: string }[];
  corrections: { claim: string; action: 'edit' | 'remove'; correction?: string; sourceFile: string }[];
}): { system: string; prompt: string } {
  const system = `You are a careful editor for an AI personality system. The user has reviewed claims extracted from personality files and marked some for editing or removal. Your job is to rewrite ONLY the affected files, applying the corrections while preserving the overall structure, voice, and formatting.

Rules:
- ONLY output files that need changes. If a file has no corrections, do NOT include it.
- Preserve markdown structure (headings, bullet points, formatting).
- Preserve the voice and style of the original text.
- For "edit" corrections: replace the original claim with the user's corrected version, integrating it naturally.
- For "remove" corrections: delete the claim entirely. Clean up any resulting awkward formatting.
- Do NOT add new content. Only modify or remove what the user specified.
- You MUST respond with ONLY valid JSON — no markdown fences, no preamble, no explanation.`;

  const filesBlock = input.files
    .map((f) => `### ${f.filename}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  const correctionsBlock = input.corrections
    .map((c, i) => {
      if (c.action === 'remove') {
        return `${i + 1}. [REMOVE from ${c.sourceFile}] "${c.claim}"`;
      }
      return `${i + 1}. [EDIT in ${c.sourceFile}] "${c.claim}" → "${c.correction}"`;
    })
    .join('\n');

  const prompt = `Here are the current personality files:

${filesBlock}

---

Apply these corrections:

${correctionsBlock}

---

Return this exact JSON structure (only include files that changed):
{
  "files": [
    {
      "filename": "FILENAME.md",
      "content": "Complete new file content with corrections applied"
    }
  ]
}`;

  return { system, prompt };
}

/**
 * Prompt to fix malformed JSON from a previous LLM call.
 */
export function buildJsonFixPrompt(brokenJson: string): string {
  return `The following text was supposed to be valid JSON but it's malformed. Fix it and return ONLY the corrected JSON — no explanation, no markdown fences, just the JSON:

${brokenJson}`;
}
