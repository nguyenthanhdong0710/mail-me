# Contract: Analyst (Summarizer & Translator)

## Input
`{ subject: string, from: {...}, text: string, truncated: boolean, attachments: string[], target_language: string }`

## Prompt structure
- **System** (`src/agents/prompts/analyst.v1.md`). Base prompt, from the original architecture blueprint:
  ```text
  You are a highly efficient executive assistant. Your task is to process an important email.
  1. Extract the main points, deadlines, and required actions from the email.
  2. Translate the summary and actions into the target language: {Target_Language}.
  3. Keep the tone professional but concise. Do not hallucinate information not present in the email.

  Return ONLY a JSON object with this structure:
  { "original_language": "Detected language", "summary": "Concise summary in {Target_Language}",
    "key_points": ["Point 1", "Point 2"], "action_items": ["Action 1 (Deadline)", "Action 2"],
    "requires_immediate_attention": boolean }
  ```
  (The output shape is superseded by the zod schema below: `action_items` are `{action, deadline}` objects.) Additions:
  - Untrusted-content rule (same as Gatekeeper).
  - "Write summary, key_points and action_items in {target_language}. If the email is already in {target_language}, do not translate, only summarize."
  - "Only state facts present in the email. If there is no deadline, set deadline to null."
  - "If the body is empty, summarize from the subject and attachment names."
- **User**: `<email>` block (same format), plus `<truncated>true|false</truncated>`.

## Output (zod)
```ts
z.object({
  original_language: z.string().min(1),
  summary: z.string().min(1).max(1000),
  key_points: z.array(z.string()).max(10),
  action_items: z.array(z.object({ action: z.string(), deadline: z.string().nullable() })).max(10),
  requires_immediate_attention: z.boolean(),
})
```

## Failure
Validation or provider error after retries → the Courier renders the **fallback** template (original excerpt plus the "⚠ AI summary unavailable" banner), and the outcome is `FALLBACK_FORWARDED`.

## Rendering
The result is wrapped in a channel-neutral `Report` and rendered separately for each channel (email, Telegram). See `contracts/delivery.contract.md`.
