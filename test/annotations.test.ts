import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { appendJournal, markUndone } from "../src/staging.js";
import { computeOverlay } from "../src/edits/overlay.js";
import { payloadSchema } from "../src/edits/kinds.js";
import { annotationsOnDay, annotationsForNight, dayBefore, tagsInUse } from "../src/edits/annotations.js";

const dataDir = path.join(process.cwd(), "test/.tmp/annotations");
const cfg = { serverDbPath: path.join(dataDir, "server.sqlite") } as any;
beforeEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); });

const schema = payloadSchema("add_annotation");
const ok = (p: object) => schema.safeParse(p).success;
const VALID = { day: "2026-07-30", tags: ["alcohol"], detail: "drank", source: "user_reported" };

function add(editId: string, p: object) {
  return appendJournal(cfg, { editId, kind: "add_annotation", payloadJSON: JSON.stringify(p), beforeJSON: null, rationale: "because" });
}

describe("add_annotation payload", () => {
  it("accepts the minimum: day + tags + detail + source", () => { expect(ok(VALID)).toBe(true); });
  it("accepts spans, instants, tz and a values bag", () => {
    expect(ok({ ...VALID, endDay: "2026-08-02", startTs: 1_785_000_000, endTs: 1_785_003_600, tz: "America/New_York", values: { drinks: 6, vomited: true, venue: "bar" } })).toBe(true);
  });
  it("requires day, tags, detail and source", () => {
    expect(ok({ tags: ["alcohol"], detail: "d", source: "user_reported" })).toBe(false);
    expect(ok({ ...VALID, tags: [] })).toBe(false);
    expect(ok({ ...VALID, detail: "" })).toBe(false);
    expect(ok({ ...VALID, source: undefined })).toBe(false);
  });
  it("rejects a source outside the two-value vocabulary — an inference must never pass as ground truth", () => {
    expect(ok({ ...VALID, source: "assumed" })).toBe(false);
    expect(ok({ ...VALID, source: "agent_inferred" })).toBe(true);
  });
  it("enforces the tag slug shape and uniqueness", () => {
    expect(ok({ ...VALID, tags: ["Alcohol"] })).toBe(false);     // uppercase would split the group
    expect(ok({ ...VALID, tags: ["late meal"] })).toBe(false);   // spaces
    expect(ok({ ...VALID, tags: ["a"] })).toBe(false);           // too short
    expect(ok({ ...VALID, tags: ["alcohol", "alcohol"] })).toBe(false);
    expect(ok({ ...VALID, tags: ["hangover_mild"] })).toBe(true); // open vocabulary: not in KNOWN_TAGS
  });
  it("rejects an inverted span and a bare endTs", () => {
    expect(ok({ ...VALID, endDay: "2026-07-29" })).toBe(false);
    expect(ok({ ...VALID, endDay: "2026-07-30" })).toBe(true); // same day is a legal degenerate span
    expect(ok({ ...VALID, endTs: 1_785_000_000 })).toBe(false); // endTs without startTs
    expect(ok({ ...VALID, startTs: 100, endTs: 100 })).toBe(false);
  });
  it("rejects non-scalar values so the bag stays greppable", () => {
    expect(ok({ ...VALID, values: { nested: { a: 1 } } })).toBe(false);
    expect(ok({ ...VALID, values: { list: [1, 2] } })).toBe(false);
  });
  it("rejects unknown keys — a typo'd field must not vanish silently", () => {
    expect(ok({ ...VALID, notes: "oops" })).toBe(false);
  });
});

describe("annotation overlay", () => {
  it("materializes every annotation, append-only — unlike baseline notes, a second one never hides the first", () => {
    add("a1", { ...VALID, day: "2026-07-28", detail: "first" });
    add("a2", { ...VALID, day: "2026-07-30", detail: "second" });
    const anns = computeOverlay(cfg).annotations;
    expect(anns.map((a) => a.detail)).toEqual(["first", "second"]);
    expect(anns[0]).toMatchObject({ editId: "a1", seq: 1, day: "2026-07-28", source: "user_reported", rationale: "because" });
    expect(anns[0].endDay).toBeNull();
    expect(anns[0].values).toBeNull();
  });
  it("carries a span, instants, tz and values through unchanged", () => {
    add("a1", { ...VALID, endDay: "2026-08-02", startTs: 1_785_000_000, endTs: 1_785_003_600, tz: "America/New_York", values: { drinks: 6 } });
    expect(computeOverlay(cfg).annotations[0]).toMatchObject({
      endDay: "2026-08-02", startTs: 1_785_000_000, endTs: 1_785_003_600, tz: "America/New_York", values: { drinks: 6 },
    });
  });
  it("an undone annotation leaves the overlay", () => {
    const s = add("a1", VALID);
    const u = appendJournal(cfg, { editId: "u1", kind: "undo", payloadJSON: JSON.stringify({ targetSeq: s }), beforeJSON: null, rationale: null });
    markUndone(cfg, s, u);
    expect(computeOverlay(cfg).annotations).toHaveLength(0);
  });
});

describe("day matching", () => {
  const anns = [
    { day: "2026-07-30", endDay: null, tags: ["alcohol"], detail: "drank", source: "user_reported", editId: "a1", seq: 1, at: 0, startTs: null, endTs: null, tz: null, values: null, rationale: null },
    { day: "2026-07-28", endDay: "2026-08-02", tags: ["travel"], detail: "in NY", source: "user_reported", editId: "a2", seq: 2, at: 0, startTs: null, endTs: null, tz: null, values: null, rationale: null },
  ] as any[];

  it("dayBefore crosses month ends", () => {
    expect(dayBefore("2026-08-01")).toBe("2026-07-31");
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
  });
  it("a day gets its own annotations plus any span covering it, tagged with why", () => {
    const got = annotationsOnDay(anns, "2026-07-30");
    expect(got.map((a) => [a.editId, a.matchedOn])).toEqual([["a2", "span"], ["a1", "sameDay"]]);
  });
  it("the span's own first day reports sameDay, not span — the more specific reason wins", () => {
    expect(annotationsOnDay(anns, "2026-07-28").map((a) => a.matchedOn)).toEqual(["sameDay"]);
  });
  it("a day outside every range gets nothing", () => {
    expect(annotationsOnDay(anns, "2026-08-05")).toHaveLength(0);
  });
  it("THE CASE THIS EXISTS FOR: a night starting after midnight picks up the prior evening's event", () => {
    // VK drank the evening of 2026-07-30; the session it wrecked starts 2026-07-31 01:48 ET.
    // A same-day-only match would silently miss it.
    const night = annotationsForNight(anns, "2026-07-31");
    expect(night.find((a) => a.editId === "a1")?.matchedOn).toBe("priorEvening");
    expect(annotationsOnDay(anns, "2026-07-31").some((a) => a.editId === "a1")).toBe(false);
  });
  it("priorEvening never overrides a span that already covers the night", () => {
    expect(annotationsForNight(anns, "2026-07-29").find((a) => a.editId === "a2")?.matchedOn).toBe("span");
  });
  it("surfaced annotations carry the seq needed to undo them, and the full untruncated detail", () => {
    const [a] = annotationsOnDay(anns, "2026-07-30").filter((x) => x.editId === "a1");
    expect(a.seq).toBe(1);
    expect(a.detail).toBe("drank");
  });
  it("tagsInUse dedupes and sorts", () => {
    expect(tagsInUse(anns)).toEqual(["alcohol", "travel"]);
  });
});
