/**
 * Unit tests for the shared task-list parser (ADR-0003 work-item hierarchy):
 * tolerance of hand-edited descriptions (indentation, extra prose, bullet
 * variants, check states) and non-destructive append/remove semantics.
 */
import { describe, it, expect } from "vitest";
import {
  parseTaskListEntries,
  childIids,
  appendChildEntry,
  removeChildEntry,
} from "../src/gitlab/tasklist.js";

describe("parseTaskListEntries", () => {
  it("returns empty for null/undefined/empty descriptions", () => {
    expect(parseTaskListEntries(null)).toEqual([]);
    expect(parseTaskListEntries(undefined)).toEqual([]);
    expect(parseTaskListEntries("")).toEqual([]);
  });

  it("parses plain unchecked and checked entries", () => {
    const entries = parseTaskListEntries("- [ ] #12\n- [x] #13\n- [X] #14");
    expect(entries.map((e) => ({ iid: e.iid, checked: e.checked }))).toEqual([
      { iid: 12, checked: false },
      { iid: 13, checked: true },
      { iid: 14, checked: true },
    ]);
  });

  it("tolerates indentation, bullet variants and trailing prose", () => {
    const description = [
      "  - [ ] #1",
      "\t* [x] #2 some prose here",
      "  + [X] #3 (follow-up)",
      "- [ ] #4\t",
    ].join("\n");
    expect(childIids(description)).toEqual([1, 2, 3, 4]);
  });

  it("ignores prose mentions and non-task-list bullets", () => {
    const description = [
      "Refs #10 and #11 but not task entries.",
      "- plain bullet without checkbox #12",
      "- [ ] not an issue ref",
      "- [x] #13 real child",
    ].join("\n");
    expect(childIids(description)).toEqual([13]);
  });

  it("keeps malformed checkbox lines out of the child set", () => {
    const description = "-[ ] #20\n- [] #21\n- [  ] #22\n-[x]#23\n- [x] #24";
    expect(childIids(description)).toEqual([24]);
  });

  it("keeps raw lines verbatim for remove/replace round-trips", () => {
    const line = "   * [X] #7 keep my indentation";
    expect(parseTaskListEntries(line)[0]?.raw).toBe(line);
  });
});

describe("appendChildEntry", () => {
  it("appends to a non-empty description with a separating newline", () => {
    const { description, changed } = appendChildEntry("Intro paragraph.\n\n- note", 33);
    expect(changed).toBe(true);
    expect(description).toBe("Intro paragraph.\n\n- note\n- [ ] #33");
  });

  it("appends to an empty description without a leading newline", () => {
    const { description } = appendChildEntry("", 5);
    expect(description).toBe("- [ ] #5");
  });

  it("is idempotent when the child is already listed (checked or unchecked)", () => {
    const existing = "- [ ] #9\n- [x] #10";
    expect(appendChildEntry(existing, 9)).toEqual({ description: existing, changed: false });
    expect(appendChildEntry(existing, 10)).toEqual({ description: existing, changed: false });
  });
});

describe("removeChildEntry", () => {
  it("removes only the matching entry line", () => {
    const description = "Header\n- [ ] #1\nmiddle prose #1 mention\n- [x] #2";
    const { description: next, changed } = removeChildEntry(description, 1);
    expect(changed).toBe(true);
    expect(next).toBe("Header\nmiddle prose #1 mention\n- [x] #2");
  });

  it("preserves other entries and indentation of survivors", () => {
    const description = "  - [x] #1\n  - [ ] #2";
    expect(removeChildEntry(description, 1).description).toBe("  - [ ] #2");
  });

  it("is idempotent when the entry is absent", () => {
    const description = "- [ ] #1\nkeep this";
    expect(removeChildEntry(description, 99)).toEqual({ description, changed: false });
  });

  it("handles null/empty descriptions", () => {
    expect(removeChildEntry(null, 1)).toEqual({ description: "", changed: false });
    expect(removeChildEntry("", 1)).toEqual({ description: "", changed: false });
  });
});
