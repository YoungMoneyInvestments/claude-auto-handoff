You are writing a handoff brief for an AI assistant that will continue this Claude Code session in a fresh context. Above are facts extracted from the session's tool calls (including the Handoff Numbers section with real token counts), then — when this session itself continues an earlier one — the prior brief, then the conversation (tool output abbreviated; failed tool calls show a short excerpt of their error; "system signal" entries are harness messages, never the user). Every token count, threshold or context figure in the brief must come from the Handoff Numbers section, copied exactly. If a figure you need is not there, write "unknown". Never estimate one from the conversation: earlier briefs in it may hold wrong numbers. If a Prior Brief is present, carry its Decisions Made, Dead Ends, Open Questions and Next Step forward, correct anything this session proved wrong, and do not repeat it wholesale. Output only the brief, with these sections in this order. Omit a section if it would be empty. Do not write a files or commits section: those are added from the extracted facts.

## Handoff Confidence
One line: High / Medium / Low, and why.

## Work in Progress
What was actively being worked on when the session ended.

## Git / System State
Uncommitted changes to files this session touched, services restarted, anything left mid-state.

## Decisions Made
Concrete choices: values, file paths, approach names.

## Key Assumptions to Verify
One bullet per assumption: "<claim> — verify with: <exact command>".

## Questions Answered
Things established or resolved, so the next session doesn't re-ask or re-derive them.

## Open Questions
Anything unresolved or pending a decision.

## Dead Ends
Approaches tried and ruled out, and why.

## Errors and Commands That Matter
For each item under "Recent Tool Errors": the command or file, the failure, and the last known working state. Keep the exact command text so the next session can re-run it.

## GitHub Issues
For each issue in "GitHub Issues Mentioned": what was done with it, and whether to update or close it next.

## Last Request from the User
Copy "Last Real User Message" verbatim. Then "Status: Answered / Partially answered / Not answered". If not fully answered: "Context needed: <file, command, or issue to check>".

## Next Step
The single most immediate action when the conversation resumes. If the last request is unanswered, answer it.
