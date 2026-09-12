/**
 * Task-list parsing for the work-item parent–child hierarchy (ADR-0003).
 * On EE Free a work item's children are task-list entries (`- [ ] #<iid>`)
 * in the parent issue's description; this module is the single shared
 * parser/mutator used by the gitlab_work_item_* tools. Parsing is tolerant
 * of hand edits: extra prose on the line, arbitrary indentation, `-`/`*`/`+`
 * bullets, upper/lowercase check marks and trailing whitespace. Only lines
 * that are genuine task-list entries are considered children — a plain
 * `#123` mention in prose never counts.
 */

export interface TaskListEntry {
  /** Referenced child issue iid. */
  iid: number;
  /** Whether the checkbox is ticked (`[x]` / `[X]`). */
  checked: boolean;
  /** The original line, verbatim. */
  raw: string;
}

const ENTRY_RE = /^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+#(\d+)/;

/**
 * Parses all task-list child entries from a description, in order of
 * appearance. Duplicate references to the same iid are kept (they exist in
 * the text); consumers typically dedupe by iid.
 */
export function parseTaskListEntries(description: string | null | undefined): TaskListEntry[] {
  if (!description) return [];
  const entries: TaskListEntry[] = [];
  for (const line of description.split("\n")) {
    const match = ENTRY_RE.exec(line);
    if (match) {
      entries.push({ iid: Number(match[2]), checked: match[1] !== " ", raw: line });
    }
  }
  return entries;
}

/** Deduplicated child iids in first-appearance order. */
export function childIids(description: string | null | undefined): number[] {
  const seen = new Set<number>();
  for (const entry of parseTaskListEntries(description)) seen.add(entry.iid);
  return [...seen];
}

/**
 * Appends a `- [ ] #<childIid>` entry to the description without disturbing
 * existing content. Idempotent: if an entry for the child already exists
 * (checked or unchecked), the description is returned unchanged.
 */
export function appendChildEntry(description: string | null | undefined, childIid: number): {
  description: string;
  changed: boolean;
} {
  const current = description ?? "";
  const exists = parseTaskListEntries(current).some((e) => e.iid === childIid);
  if (exists) return { description: current, changed: false };
  const entry = `- [ ] #${childIid}`;
  if (current.trim() === "") {
    return { description: current === "" ? entry : `${current}${entry}`, changed: true };
  }
  const separator = current.endsWith("\n") ? "" : "\n";
  return { description: `${current}${separator}${entry}`, changed: true };
}

/**
 * Removes the task-list entry line(s) referencing childIid — and only those
 * lines. Other content, including prose mentions of `#<childIid>` that are
 * not task-list entries, is preserved. Returns the original string
 * (changed: false) when no entry exists, so callers can treat absence
 * idempotently.
 */
export function removeChildEntry(description: string | null | undefined, childIid: number): {
  description: string;
  changed: boolean;
} {
  const current = description ?? "";
  const lines = current.split("\n");
  const kept = lines.filter((line) => {
    const match = ENTRY_RE.exec(line);
    return !(match && Number(match[2]) === childIid);
  });
  if (kept.length === lines.length) return { description: current, changed: false };
  return { description: kept.join("\n"), changed: true };
}
