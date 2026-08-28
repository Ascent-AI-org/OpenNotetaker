# Notes email composer

**Status:** approved design, not yet implemented
**Date:** 2026-08-27

## Why

Sending a meeting's notes is currently one button with fixed content: summary,
decisions, open questions, risks, the full role-corrected transcript, and the raw
Hinglish evidence, delivered to whatever addresses the owner configured.

That is right for the owner's own inbox and wrong for anyone else. On 2026-08-27 the
Ishaan/Athul meeting had to be sent to the other party in the deal, and the only
available email contained an LLM-written RISKS section calling the prospect's leads
"tire kickers" and a verbatim passage describing the sales tactic of anchoring value
before revealing price. The workaround was a hand-written one-off script, which sent
something the operator had not intended and left no record in the app of what any
recipient received.

The composer replaces the single button with a choice of what to send, the ability to
edit it, and a record of what went out.

## Decisions taken

1. **Edits are per-send only.** The composer is a scratchpad. `artifacts.notes` and the
   stored transcript are never modified by sending. The same typo must be corrected on
   each send; in exchange the captured record stays exactly what the pipeline produced,
   and one recipient's framing can differ from another's.
2. **The client sends a selection, the server renders the email.** The request body
   describes *what to include*, never the finished message.
3. **Transcript editing is per-turn**: a checkbox and an inline text override per turn,
   plus bulk select-all/none and drop-before/drop-after for trimming.
4. **Recipients are free-form**, with calendar attendees offered as suggestions and
   external addresses flagged — extending the stance already stated in
   `src/domain/note-delivery.js`, which deliberately never adds attendees automatically.
5. **Raw Hinglish evidence is available as a section but off in every preset.** It is the
   least polished artifact and is almost never appropriate outside the owner's inbox.
   (Assumption, not an explicit instruction — flip it if wrong.)

## Why the server renders

The rejected alternative was to let the browser build the final text and HTML and have
the server pass it to Gmail. That is an open mail relay: arbitrary body to an arbitrary
recipient, authenticated as the owner's Google account and sent from their domain. A
stolen session, or any XSS foothold, becomes the ability to send anything as the user.

Rendering server-side from the stored meeting means the message's shape is always the
app's own template. The only attacker-controlled text is the explicitly edited fields,
which are length-capped and HTML-escaped. A compromised session can still send this
meeting's content to the wrong address — bounded, rate-limited, and logged — but cannot
send arbitrary prose as the user.

## API

### `POST /api/meetings/:id/notes-email`

Session-authenticated, owner-scoped (404 for both "missing" and "not yours", matching
every other meeting route). Requires `meeting.status === "completed"`. Rate-limited per
account, mirroring `exportLimiter`.

`?preview=1` renders and returns `{ subject, text, html }` **without sending**. The
preview and the delivery run through the same renderer, so what is previewed is what is
sent. A composer whose preview can drift from its delivery is worse than no preview:
the drift is invisible until a recipient has the wrong thing.

Request body:

```js
{
  recipients: ["ishaan.dinesh@atulyadav.com"],   // <= MAX_RECIPIENTS (25)
  confirmExternal: true,                          // required if any recipient is external
  subject: "Notes from our call",                 // <= 200 chars, default derived
  intro: "Hi Ishaan, thanks for the time today.", // <= 2000 chars
  signoff: "Best,\nDhruv",                        // <= 2000 chars
  sections: {
    summary: true, decisions: true, actionItems: true,
    openQuestions: false, risks: false,
    transcript: true, rawEvidence: false
  },
  summaryOverride: "...",                         // <= 8000 chars, optional
  decisions: ["..."],                             // edited copies, optional
  actionItems: [{ task, owner, due }],            // reuses parseActionItems
  transcript: {
    includeIds: ["<segment id>", ...],
    edits: { "<segment id>": "corrected text" }   // <= 2000 chars each
  }
}
```

Responses: `200 { subject, text, html }` for preview; `200 { meeting, delivery }` on
send; `400 validation_error`; `409 meeting_not_completed`; `409 external_not_confirmed`;
`429 rate_limited`; `404` for a meeting that is not the caller's.

## Modules

| Module | Responsibility |
|---|---|
| `src/domain/notes-email-selection.js` | Pure. `parseNotesEmailSelection(body, meeting)` → `{ ok, value, error }`. Validation, clamping, ownership of ids. |
| `src/domain/notes-email-render.js` | Pure. `renderNotesEmail({ meeting, selection })` → `{ subject, text, html }`. |
| `src/domain/transcript-email.js` | Refactored: per-section formatters extracted and exported so the existing auto-email and the composer share one definition of how a section looks. |
| `src/server.js` | Route dispatch, auth, rate limit, audit, Gmail send. No rendering logic. |
| `public/app.js` | The composer dialog. |

Extracting the section formatters is not optional tidiness. Without it, "how a decisions
list is formatted" exists in two places and they drift; the composer would then be
previewing something the auto-email does not produce.

## Validation rules

**Every transcript edit key and every `includeIds` entry must name a segment that
belongs to this meeting.** This is the primary injection path: without the check, a
caller can POST arbitrary prose under an invented id and have the server render and send
it under the app's own template. Unknown id is a `400`, never a silent render.

`confirmExternal` is enforced **server-side**. A stale browser tab, or a scripted call
that never saw the warning, must not be able to skip it. An address is external when it
is outside every domain the owner has a connected Google account for — the same
definition `attendeeSuggestions` already uses.

Caps: subject 200, intro 2000, signoff 2000, per-turn edit 2000, summary override 8000,
recipients 25, and a total rendered-body ceiling. Every interpolated field is
HTML-escaped on the way into the HTML part.

## Audit

Sending records `meeting.delivery.notesEmail`:

```js
{ sentAt, recipients, subject, sections, turnsSent, turnsEdited, providerMessageIds }
```

and appends a `notes.email_sent` run-log event naming the recipients and sections.

The body itself is deliberately not stored — edits are per-send by decision (1), and
keeping every variant would grow a store that is already rewritten in full on every
write. What is kept is enough to answer "what did this person receive?", which is
exactly the question that could not be answered on 2026-08-27.

## UI

The existing manual send button becomes **Compose & send**. Automatic transcript email
and the action-items mail are unchanged; this is additive.

```
Recipients  [ishaan.dinesh@atulyadav.com x] [+ Ishaan (attendee)]   ! external
Preset      ( ) Full record    (o) Client-safe
Sections    [x] Summary [x] Decisions [x] Actions [ ] Risks [ ] Questions [x] Transcript
Subject     [ Notes from our call - Ostrya x Athul                  ]
Intro       [ Hi Ishaan, thanks for the time today.                 ]

TRANSCRIPT  685 turns - 612 selected     [all] [none] [drop before] [drop after]
 [x] 00:14  Dhruv     Let's start with the funnel...              (edit)
 [ ] 00:22  Speaker3  (internal aside)                            (edit)
 [x] 00:31  Ishaan    Our webinar converts at...                  (edit)
                                              [ Preview ]   [ Send ]
```

Presets are starting points, not modes: choosing one sets the section checkboxes and
then the operator edits freely.

- **Full record** — every section including raw evidence. What the owner gets today.
- **Client-safe** — summary, decisions, action items. No risks, no open questions, no
  transcript, no raw evidence.

685 turns is roughly 3,000 DOM nodes, which vanilla DOM handles without virtualization.
The list must not re-render on every keystroke. Optimize further only if measurement
says so.

## Testing

- **Selection parsing**: unknown segment id rejected; every cap enforced at its boundary;
  recipient sanitising and the 25 limit; `confirmExternal` required when any address is
  external and not required when none is.
- **Renderer**: each section present only when selected; edits applied; excluded turns
  genuinely absent from both text and HTML parts; HTML escaping of every edited field.
- **Integration**: compose → preview → send against a temp store, asserting the previewed
  body is byte-identical to the sent body, and that the audit record and run-log event
  are written.
- **Refactor safety**: the existing transcript-email tests must pass unchanged after the
  section formatters are extracted.

## Build order

1. Extract shared section formatters from `transcript-email.js` — no behaviour change
2. `notes-email-selection.js` + `notes-email-render.js`, pure and tested
3. The endpoint: preview, send, audit, caps, rate limit
4. The composer UI
5. Docs and a QA checklist entry

## Out of scope

- Saved or named drafts. Decision (1) makes the composer per-send; drafts were considered
  and rejected as weight on a store that is rewritten in full on every write.
- Writing composer edits back into `artifacts.notes`.
- Scheduling a send for later.
- Attachments, including the recording or a clip.
