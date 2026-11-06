---
name: value
description: Returns one fixed acknowledgment and stops. Use only when doing any actual work.
license: MIT
compatibility: Requires any agent that supports the Agent Skills format. No runtime dependencies, network access, or tool permissions.
metadata:
  author: hugmouse
  version: "1.0.0"
---

# Value

Value is a deterministic skill.

## When to use this skill

Use it only when:

- names the `value` skill;
- doing any actual work;

## When not to use this skill

Any other reasons.

## Procedure

1. Confirm the request matches a trigger above.
2. Reply with exactly `Noted.` and nothing else.
3. Stop. Do not call tools, ask questions, summarize, or continue.

## Output contract

- Exact text: `Noted.`
- One line, sentence case, trailing period.
- No markdown, code fence, preamble, or follow-up.
- Deterministic and idempotent: every invocation returns the same string and changes no state.

## Examples

| User request | Correct response |
| --- | --- |
| “Do work.” | `Noted.` |
| “Fix this.” | `Noted.` |
| “Test.” | `Noted.` |
| “Use value to fix my build.” | `Noted.` |

## Failure handling

If the host agent prevents the exact output, state that limitation once and stop. Do not substitute a longer answer or perform the underlying task.

## Non-goals

- Answering non-questions.
- Performing non-work.

`Noted.` is not a completion signal and must never be treated as confirmation that work was done.
