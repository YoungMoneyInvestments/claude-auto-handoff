import type { SessionMessage } from 'claude-code'
import { renderTemplate, sectionHeadings } from './templates.ts'

// Brief building.
// Files, commits, issues and the last real request come from the transcript in code;
// Haiku only writes the judgment sections. Its reply is checked, and the facts alone
// stand in when it fails.

const MAX_MESSAGES = 120
const MAX_MSG_CHARS = 2_000
const MAX_TRANSCRIPT_CHARS = 150_000

// Harness signals that arrive as user messages but are never the user's words.
const META_PREFIXES = ['Stop hook feedback', '[Automatic handoff]', '[auto-handoff]', '[Image', '<system-reminder>', '<command-name>', '<local-command']

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const GIT_COMMIT_OUTPUT = /^\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]{7,})\] (.+)$/m

export type Facts = {
  filesModified: string[]
  commits: string[]
  issues: string[]
  lastUserMessage?: string
  handoffTokens?: number
  threshold?: number
  /** Where the base threshold came from: the env override or the /config setting. */
  thresholdSource?: string
  seededSessionStartSize?: number
  /** Handoffs since the user last typed, this one included. */
  unattendedCount?: number
  /** Which handoff this is in its chain (1 for the first, 2 for the second, etc.). */
  depth?: number
  /** Deterministic excerpts of the most recent failed tool calls, including their error text. */
  recentErrors?: string[]
  /** The model that wrote the judgment sections: `haiku`, or the session's own model past the chain depth. */
  briefAuthor?: string
}

/** The user's own words, or undefined for a harness signal or a tool-result-only message. */
export function userText(m: SessionMessage): string | undefined {
  if (m.role !== 'user') return undefined
  const raw = m.text.trim()
  if (!raw) return undefined
  return isMeta(raw) ? undefined : raw
}

function isMeta(text: string): boolean {
  return META_PREFIXES.some(p => text.startsWith(p))
}

function commitSubject(command: string): string | undefined {
  if (!/\bgit\b[^\n|;&]*\bcommit\b/.test(command)) return undefined
  const heredoc = command.match(/<<\s*'?(\w+)'?\n([\s\S]*?)\n\1/)
  if (heredoc) return heredoc[2]?.trim().split('\n')[0]
  return command.match(/-m\s+(["'])(.+?)\1/)?.[2]
}

/** ignoreFiles: paths that never count as edits (auto-synced state, caches); the ignoreFiles setting. */
export function extractFacts(messages: readonly SessionMessage[], ignoreFiles?: RegExp): Facts {
  const files = new Set<string>()
  const commits: string[] = []
  const issues = new Set<string>()
  let lastUserMessage: string | undefined
  for (const m of messages) {
    const said = userText(m)
    if (said) lastUserMessage = said
    for (const n of `${said ?? (m.role === 'assistant' ? m.text : '')}`.matchAll(/(?<![\w&/])#(\d{2,5})\b/g)) issues.add(`#${n[1]}`)
    for (const t of m.toolUses) {
      const path = t.input.file_path ?? t.input.notebook_path
      if (EDIT_TOOLS.has(t.tool) && typeof path === 'string' && !t.isError && !ignoreFiles?.test(path)) files.add(path)
      if (t.tool !== 'Bash' || typeof t.input.command !== 'string' || t.isError) continue
      // git's own "[main abc1234] subject" line is the proof a commit landed; the command is the fallback
      const out = t.text?.match(GIT_COMMIT_OUTPUT)
      const subject = out ? `${out[2]} (${out[1]})` : t.text === undefined ? commitSubject(t.input.command) : undefined
      if (subject && !commits.includes(subject)) commits.push(subject)
    }
  }
  return { filesModified: [...files].slice(-20), commits: commits.slice(-10), issues: [...issues].slice(-15), lastUserMessage, recentErrors: extractErrors(messages) }
}

// The last failed tool calls, with the error text abbreviated. The summarizer never sees tool
// results (renderTranscript prints the input plus an ERROR flag), so the one thing a coding
// session learned — why the command failed — used to be lost entirely. These are deterministic
// and land in the brief even when the summary step fails.
const MAX_ERRORS = 3
const MAX_ERROR_CHARS = 220
export function extractErrors(messages: readonly SessionMessage[], limit = MAX_ERRORS): string[] {
  const out: string[] = []
  for (const m of messages) {
    for (const t of m.toolUses) {
      if (!t.isError) continue
      const input = t.tool === 'Bash'
        ? String(t.input.command ?? '')
        : String(t.input.file_path ?? t.input.notebook_path ?? JSON.stringify(t.input))
      const text = String(t.text ?? '').replace(/\r/g, '').trim()
      // Prefer the lines that name the failure; fall back to the head of the output.
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
      const failure = lines.find(l => /error|fail|cannot|could not|undefined|not found|exit code|traceback/i.test(l))
      const excerpt = (failure ?? lines[0] ?? '(no output captured)').slice(0, MAX_ERROR_CHARS)
      out.push(`[${t.tool}] ${input.replace(/\s+/g, ' ').trim().slice(0, 160)} → ${excerpt}`)
    }
  }
  return out.slice(-limit)
}

/** The transcript as Haiku reads it. Harness signals are labelled so they are not taken for the user. */
export function renderTranscript(messages: readonly SessionMessage[]): string {
  const lines = messages.slice(-MAX_MESSAGES).map(m => {
    const role = m.role === 'user' && m.text.trim() && !userText(m) ? 'system signal (not the user)' : m.role
    const text = m.text.length > MAX_MSG_CHARS ? m.text.slice(0, MAX_MSG_CHARS) + ' [truncated]' : m.text
    const tools = m.toolUses.map(t => {
      const head = `  [tool ${t.tool}${t.isError ? ' ERROR' : ''}] ${JSON.stringify(t.input).slice(0, 300)}`
      // A failed call's output is the most valuable 600 characters in the session; show it.
      if (!t.isError || typeof t.text !== 'string' || !t.text.trim()) return head
      return `${head}\n  [result] ${t.text.replace(/\s+/g, ' ').trim().slice(0, 600)}`
    })
    return [`### ${role}`, text, ...tools].filter(Boolean).join('\n')
  })
  const joined = lines.join('\n\n')
  return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(-MAX_TRANSCRIPT_CHARS) : joined
}

function list(items: string[], empty: string): string {
  return items.length ? items.map(i => `- ${i}`).join('\n') : empty
}

// The only token figures the brief may use. Haiku once wrote "burned its 200k budget" for a
// session at 93k because the prompt held no numbers at all.
function handoffNumbersBlock(f: Facts): string {
  const lines = []
  if (f.depth !== undefined) lines.push(`- **Handoff depth:** ${f.depth}`)
  if (f.handoffTokens !== undefined) lines.push(`- **Tokens at handoff:** ${f.handoffTokens} (${k(f.handoffTokens)})`)
  if (f.threshold !== undefined) lines.push(`- **Threshold:** ${f.threshold} (${k(f.threshold)})${f.thresholdSource ? `, from ${f.thresholdSource}` : ''}`)
  if (f.seededSessionStartSize !== undefined) lines.push(`- **This session's starting size (seeded from a handoff):** ${f.seededSessionStartSize} (${k(f.seededSessionStartSize)})`)
  if (f.unattendedCount !== undefined) lines.push(`- **Handoffs in a row with no user message:** ${f.unattendedCount}`)
  if (f.briefAuthor) lines.push(`- **Brief written by:** ${f.briefAuthor}`)
  return lines.length ? `## Handoff Numbers\n${lines.join('\n')}\n` : ''
}

const k = (n: number) => `${Math.round(n / 1000)}k`

export function factsBlock(f: Facts, withLastMessage = true): string {
  const numbers = handoffNumbersBlock(f)
  const files = `## Files Modified (from Edit/Write calls)
${list(f.filesModified, 'None.')}

## Commits This Session
${list(f.commits, 'None.')}

## GitHub Issues Mentioned
${f.issues.length ? f.issues.join(', ') : 'None.'}`
  const errors = f.recentErrors?.length ? `## Recent Tool Errors (verbatim excerpt)
${list(f.recentErrors, 'None.')}` : ''
  const all = [numbers, files, errors].filter(Boolean).join('\n')
  return withLastMessage ? `${all}\n\n## Last Real User Message (verbatim)\n${f.lastUserMessage ?? 'None found.'}` : all
}

export function briefPrompt(messages: readonly SessionMessage[], facts: Facts, template: string, priorBrief?: string): string {
  // Data first, instructions last. A chained handoff gets the previous brief too: without it the
  // next summary re-derives the chain's state from prose alone (the seed tells the session not to
  // restate the brief, and the brief arrives as a tool result the summarizer cannot see).
  const prior = priorBrief?.trim()
    ? `## Prior Brief (from the session this one continues)\n${priorBrief.trim()}\n\nCarry its Decisions Made, Dead Ends, Open Questions and Next Step forward. Correct anything the new session proved wrong rather than repeating it verbatim. Do not copy it wholesale.\n\n`
    : ''
  return `## Extracted Facts\n${factsBlock(facts)}\n\n${prior}## Conversation\n${renderTranscript(messages)}\n\n---\n\n${template.trim()}`
}

/** A reply that holds none of the template's sections is a dialogue fragment, not a brief. */
export function isValidBrief(text: string, template: string): boolean {
  return sectionHeadings(template).some(h => text.includes(h))
}

// Whether the brief's last-request section
// says the request is not (fully) answered. A chain with no user message is not a real request.
export function hasUnansweredLastRequest(text: string): boolean {
  const heading = /##\s*Last Request from the User/i.exec(text)
  if (!heading) return false
  const rest = text.slice(heading.index + heading[0].length)
  const next = /^#{1,6}\s/m.exec(rest)
  const section = next ? rest.slice(0, next.index) : rest
  if (/No user message found|^\s*\[auto-handoff\]/i.test(section)) return false
  return /\bStatus[\s*_`]*:[\s*_`"]*(Not (?:yet |fully )?answered|Partially answered|Unanswered)/i.test(section)
}

export type BriefContext = {
  sessionId: string
  /** The session's transcript file. */
  transcript: string
  /** The instructions template, rendered at the top of the brief. */
  instructions: string
}

export function assembleBrief(ctx: BriefContext, facts: Facts, haiku: string | undefined): string {
  const header = `${renderTemplate(ctx.instructions, { priority: haiku ? hasUnansweredLastRequest(haiku) : false })}

## Session Handoff Brief

- **Previous Session:** ${ctx.sessionId}
- **Transcript:** \`${ctx.transcript}\`

## How to Use This Brief
${haiku ? `${facts.briefAuthor && facts.briefAuthor !== 'haiku' ? `The session's own model (${facts.briefAuthor})` : 'Haiku'} wrote the judgment sections from conversation text with tool output abbreviated. The facts sections came from tool calls in code.` : 'The summary step did not return a usable brief, so this holds only facts extracted in code. Read the transcript for the rest.'} Treat every line as a starting point, not a fact. Before acting on anything here, spawn a subagent to verify: run git status, gh pr view, or Read the file directly. If a fact is missing, grep the transcript before asking the user.`
  // A valid Haiku brief already quotes the last request in its own section.
  return [header, haiku?.trim(), factsBlock(facts, !haiku)].filter(Boolean).join('\n\n')
}

// A token figure: "93k", "93.1k", "93,105 tokens", "93105 tokens".
const TOKEN_FIGURE = /\b(\d{1,4}(?:\.\d+)?)k\b|\b(\d{1,3}(?:,\d{3})+|\d{4,7})(?= tokens\b)/gi

const figureValue = (k?: string, whole?: string) => k !== undefined ? Number(k) * 1000 : Number(whole!.replace(/,/g, ''))

/**
 * Marks every token figure in Haiku's text that the Handoff Numbers block does not hold, within
 * rounding to the nearest thousand. The template asks Haiku to copy those numbers; this makes it a
 * rule. Figures are marked, not removed, so the next session sees what was claimed and that it is
 * unchecked. Only the first occurrence of each distinct figure is marked. With no numbers block, every figure is marked.
 */
export function markUnverifiedFigures(text: string, f: Facts): { text: string; flagged: string[] } {
  const block = handoffNumbersBlock(f)
  const allowed = [
    ...[...block.matchAll(/\b(\d{1,4}(?:\.\d+)?)k\b/g)].map(m => figureValue(m[1])),
    ...[...block.matchAll(/\b\d{4,7}\b/g)].map(m => Number(m[0])),
  ]
  const flagged: string[] = []
  // One mark per distinct figure: a brief that repeats "200k" ten times says it is unchecked once.
  const seen = new Set<number>()
  const marked = text.replace(TOKEN_FIGURE, (match: string, k?: string, whole?: string) => {
    const value = figureValue(k, whole)
    if (allowed.some(a => Math.abs(a - value) < 1000)) return match
    if (seen.has(value)) return match
    seen.add(value)
    flagged.push(match)
    return `${match} [unverified: not in Handoff Numbers]`
  })
  return { text: marked, flagged }
}
