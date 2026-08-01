# Day annotations — a dated life-event store

## The gap

VK routinely supplies ground truth in conversation that is the difference between a correct
and an incorrect reading of his biometrics:

> "Thursday 2026-07-30 I drank and threw up and was dehydrated; most other nights I'm sober."

Without that sentence, 2026-07-30's numbers (RHR 54 vs a sober 14-day mean of 44.3, recovery
32.6 vs 82.1, HRV 93.1 vs 106.9) read as illness. With it they read as a deliberate,
explainable perturbation — and the night becomes a labelled validation case instead of noise.

Today that sentence has nowhere to live. The only mechanism is `set_baseline_note`, and it is
structurally the wrong shape:

| Property | `set_baseline_note` | What a dated event needs |
| --- | --- | --- |
| Time | none — `{ note, deviceId? }` (`src/edits/kinds.ts`) | a day, or a span, or an instant |
| Cardinality | one **visible** note per `deviceId` — `latestBaselineNotes` in `src/tools/core.ts` collapses to the latest per key and reports a `supersededCount` | many per day, many days |
| Queryability | prose only | filterable by day, tag, source |
| Length | 500 chars | enough for a real account |
| Reach | server-only; the phone ignores it (`src/edits/compensation.ts:27`) | same (server-only is fine) |

The cardinality row is the fatal one. The journal is append-only, but every reader sees one
note per device — so a second dated event silently *hides* the first. That near-miss is what
prompted this work: the 2026-07-30 alcohol context had to be parked in the `null`-`deviceId`
slot specifically to avoid hiding the load-bearing supplement-protocol note.

`set_baseline_note` is not being replaced. It is correct for **standing** context — facts true
across a whole era, where "latest wins" is the right semantics. Both live notes are correct
uses of it and are left untouched:

- `oura-api` — cross-device RHR calibration is impossible; the Oura era ends 2026-06-13 and
  the WHOOP era starts 2026-06-26, so no overlap nights exist.
- `my-whoop-noop` — the performance-supplement protocol, which explains sustained elevated
  temp/RHR and lowered HRV/Charge across the entire WHOOP era and **must not** be read as
  illness.

## What gets built

A dated annotation store: one row per life event, anchored in time, tagged, attributed to a
source, and — the part that makes it worth building — **surfaced automatically by the tools
that already answer biometric questions**, so a future session analysing 2026-07-30 sees the
alcohol label without anyone having to remember to mention it.

### Storage: the edit journal, not a new table

Annotations are user-attributed facts, so they follow the same discipline as every other
correction: `propose_edit` → human `confirm_edit` → append-only `editJournal` →
`computeOverlay` materialises them for readers. No new table.

This is a deliberate re-use rather than a shortcut:

- The journal **is** the audit log the brief asks for, including `rationale` and `appliedAt`.
- `undo_edit` works for free — removing a wrong annotation is an existing, tested code path
  that never deletes history.
- The read-write credential already gates confirmation, so nothing can write a fact in VK's
  name without a human.
- `compensationFor` correctly returns `null` for it (server-only, phone ignores it), matching
  `set_baseline_note`.

The cost is that `computeOverlay` JSON-parses every active edit on every read. At VK's cadence
— roughly one annotation a day, journal currently at seq 46 — that is a few hundred rows a
year and stays far below the point where it matters. If the habit tracker later pushes this to
tens of thousands of rows, the overlay grows a cached/indexed materialisation; the payload
shape below does not have to change for that.

### The payload

New edit kind `add_annotation`:

```jsonc
{
  "day":    "2026-07-30",        // required. The local calendar day the event happened on.
  "endDay": "2026-08-02",        // optional. Inclusive last day of a multi-day span.
  "startTs": 1785...,            // optional. Epoch seconds, when the event has a real instant.
  "endTs":   1785...,            // optional.
  "tags":   ["alcohol"],         // 1..8. Open vocabulary, `^[a-z][a-z0-9_]{1,31}$`.
  "detail": "…",                 // 1..2000 chars of free text.
  "source": "user_reported",     // or "agent_inferred". Required — never guess this.
  "tz":     "America/New_York",  // optional IANA zone that `day` is a calendar day in.
  "values": { "drinks": 6 }      // optional flat bag of string|number|boolean.
}
```

Three decisions worth defending:

**`day` is required, instants are optional.** Most of what VK reports is day-grained ("Thursday
I drank"). Forcing an instant would mean inventing precision. But some events genuinely have
one (a 23:08 HR surge, a medication dose), and some span days (travel, a supplement block), so
`startTs`/`endTs` and `endDay` are there when they are real. `day` stays required so every
annotation has one unambiguous anchor to join on.

**`source` is required and has exactly two values.** `user_reported` is ground truth VK stated.
`agent_inferred` is a conclusion drawn from the data (e.g. "this temperature rise is a charging
artifact"). Collapsing them would let an inference harden into a fact across sessions — the
exact failure mode that produces retracted claims. Anything an agent concludes rather than
hears is `agent_inferred`, without exception.

**`values` is a flat, uninterpreted bag.** No tool reads it today. It exists so that when the
habit tracker arrives, "6 drinks" can be recorded as `6` rather than buried in prose — which is
precisely the mistake `set_baseline_note` forces. Flat and scalar-only so it stays greppable.

### Tag vocabulary: suggested, not enforced

A closed enum would need a schema change and a redeploy the first time VK reports something
unanticipated, and the annotation would not get written that day — which defeats the point.
So the vocabulary is open, with a documented suggested set that tools advertise:

`alcohol`, `illness`, `travel`, `supplement_on`, `supplement_off`, `late_meal`, `hard_workout`,
`medication`, `injury`, `stress`, `caffeine`, `poor_sleep`, `fasting`, `validation_night`,
`measurement_artifact`.

The `annotations` tool returns both `known` (that list) and `inUse` (every tag actually present
in the store). Drift is therefore visible rather than silent: if VK keeps writing `hangover`,
it shows up in `inUse` and the suggested list can absorb it later. This is the seam the habit
tracker grows from — a tag that starts as free text and later earns structure in `values`.

### Anchoring: why a night needs two days

The load-bearing subtlety. VK drank on the evening of **2026-07-30**; the sleep session it
wrecked *starts* at **2026-07-31** 01:48 ET. An annotation keyed on the day the event happened
will never match a night keyed on the day the session started, and the feature would silently
do nothing in the exact case that motivated it.

So the rule is: **an annotation is anchored to the day the event happened, and readers of a
sleep session look at both the session's start day and the day before it.** Each surfaced
annotation carries `matchedOn`, so the reader can see why it matched:

- `sameDay` — the annotation's day equals the day being reported on.
- `priorEvening` — the annotation is on the day *before* a sleep session's start day (an evening
  event bearing on that night).
- `span` — the day falls inside a multi-day `day`..`endDay` range.

Day-grained readers (`health_snapshot`, `compare_sources`) match `sameDay` and `span` only;
`priorEvening` is meaningful for sleep sessions, where the calendar boundary actually cuts
through the event.

## MCP surface

### Write

`propose_edit` gains the `add_annotation` kind. Nothing else changes about the write path —
same proposal id, same rendered diff, same human confirmation with the read-write credential,
same audit journal. Removing an annotation is `undo_edit` on its journal seq.

The rendered diff is one line, so `list_pending` shows a human enough to confirm against:

```
ANNOTATE 2026-07-30 [alcohol, dehydration] (user_reported): VK drank alcohol and vomited…
```

### Read

**`annotations`** — first-class query. `{ from?, to?, tags?, source?, limit? }`, all optional;
no range means everything. Returns each annotation with its `editId` and journal `seq` (so it
can be undone), plus the tag vocabulary in use.

**Embedded in the biometric tools** — this is the half that matters, because it is what removes
the requirement that anyone remember the store exists:

| Tool | What it gains |
| --- | --- |
| `sleep_summary` | per-session `annotations`, matching start day + prior evening + spans |
| `health_snapshot` | per-day `annotations` (`sameDay` + `span`) |
| `compare_sources` | per-day `annotations` (`sameDay` + `span`) |
| `data_freshness` | an `annotationSummary` — count, day range, tags in use — beside `baselineNotes`, so the "call this first" tool advertises that the store exists and is worth querying |

Empty arrays are omitted, not emitted, so nothing changes in the output of a day with no
annotations.

Registration scope matches the existing precedent rather than inventing a new one: annotations
are readable on every scope including the no-auth URL-secret route. `data_freshness` — which
already carries `baselineNotes`, including the supplement-protocol note — is registered there
today, and the embedded surfacing means `sleep_summary` and `health_snapshot` would carry
annotations on that route regardless. Splitting the two would be incoherent. The URL is the
credential; that trade-off was made when the route was built.

## Fixing the shadowing near-miss

Nothing currently warns that writing a `set_baseline_note` for a `deviceId` that already has
one hides the previous note from every reader. `captureBefore` returns `null` for the kind, so
the diff a human confirms against cannot mention it.

`captureBefore` now reads the current overlay for `set_baseline_note` and returns the note it
would supersede, and `renderDiff` renders the warning inline — so it appears in `propose_edit`'s
response *and* in `list_pending`, which is where the confirmation decision is actually made:

```
NOTE [my-whoop-noop]: <new text>
  ⚠ REPLACES the current note for my-whoop-noop (2026-07-13): "Performance-supplement protocol…"
    Only the latest note per device is surfaced. For a DATED event use add_annotation instead.
```

This required widening `captureBefore`'s config type from `Pick<Config, "mirrorPath">` to also
include `serverDbPath`; every caller already passes the full `Config`.

## Migration

The two standing notes are correct uses of `set_baseline_note` and are left exactly as they
are. No data migration is needed for them.

Proposal `edit_c28a7808b1` — the 2026-07-30 alcohol context parked in the `null`-`deviceId`
slot as a stopgap — was still **pending** when this was built, so there is nothing to migrate
out of the journal. Its content is instead re-proposed as two proper annotations once this
ships, and the stopgap should be rejected rather than confirmed:

1. `2026-07-30`, `[alcohol, dehydration, validation_night]`, `user_reported` — the drinking,
   vomiting and dehydration, with the deviation figures.
2. `2026-07-30`, `[measurement_artifact]`, `agent_inferred` — that the day's `skinTempDevC`
   +0.9 °C is a charging artifact (`BATTERY_PACK_CONNECTED` 00:42, `REMOVED` 04:57, SoC
   9.4→100 %), not physiology.

Splitting them is the point of having a `source` field: the first is what VK said, the second
is what an agent worked out, and a later session must be able to tell which is which.

## Testing

- `test/annotations.test.ts` — payload validation (day format, tag pattern, span ordering,
  `values` scalars), overlay materialisation, undo removal, `matchedOn` resolution across the
  day boundary.
- `test/tools-annotations.test.ts` — the `annotations` tool's filters, and that a night gets
  its prior evening's annotation attached through `sleep_summary` while `health_snapshot` and
  `compare_sources` get the same-day one.
- `test/edits-baseline-shadow.test.ts` — a second note for a device that already has one
  renders the supersede warning; the first note for a device does not.
