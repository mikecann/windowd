import { readFileSync } from 'node:fs';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-2.5-flash';

export interface VisionResult {
  pass: boolean;
  reason: string;
  skipped?: boolean;
}

export async function assertVisualMatch(
  screenshotPath: string,
  description: string,
): Promise<VisionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { pass: true, reason: 'OPENROUTER_API_KEY not set, skipped', skipped: true };
  }

  const base64 = readFileSync(screenshotPath).toString('base64');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/mikecann/windowd',
      'X-Title': 'windowd/e2e-tests',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
          {
            type: 'text',
            text: `You are a visual QA tester for a desktop app framework called windowd.
Look at this screenshot of an NW.js application window and determine if it
matches this description:

"${description}"

Use a tolerant judgement:
- PASS if the screenshot materially matches the described screen
- IGNORE small visual differences like font rendering, minor spacing, theme shade differences, or slight copy variance
- FAIL only if key described elements are missing or clearly incorrect

Respond with ONLY a JSON object, no markdown fences:
{"pass": true, "reason": "brief explanation"}
or
{"pass": false, "reason": "what's wrong"}`,
          },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { pass: false, reason: `OpenRouter API error ${res.status}: ${text}` };
  }

  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const content = data.choices[0]?.message?.content?.trim();
  if (!content) {
    return { pass: false, reason: 'Empty response from vision model' };
  }

  try {
    const cleaned = content.replace(/^```json?\s*|```\s*$/g, '').trim();
    return JSON.parse(cleaned) as VisionResult;
  } catch {
    return { pass: false, reason: `Could not parse vision response: ${content}` };
  }
}
