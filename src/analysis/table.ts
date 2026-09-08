import {
  type AnalysisLimits,
  type ColumnKind,
  type DataAtom,
  hasAnyPlaceholder,
  markUntrusted,
  toDataAtom,
} from '@/contracts/index.ts';

/**
 * Reading a table off the REDACTED document.
 *
 * WHAT THIS FILE SEES. It is handed the `Document` that `redact()` already
 * rewrote, retained by `DomPipeline` between `redact` and `sanitize`. Every PII
 * value in it has already been replaced in place - a `<td>` that held
 * `yash@example.com` reads `[[PII:EMAIL:3:9f2a...]]` by the time this runs. So
 * this file never sees a raw personal value, and could not forward one if it
 * tried.
 *
 * WHAT IT REFUSES TO PRODUCE. Cell values leave here as `number[]` and nothing
 * else. There is no path by which a string from a body cell becomes part of the
 * output: `readColumn` returns numbers and counts, and the only string that
 * survives is the HEADER, which goes through `toDataAtom` like every other piece
 * of network-bound page text.
 *
 * THE PLACEHOLDER TRAP, which is the reason this file exists at all rather than
 * a three-line `parseFloat` map. `Number.parseFloat('[[PII:EMAIL:3:9f2a]]')` is
 * `NaN`. Filter the NaNs out and a mean over a column whose values were 90%
 * redacted is reported as if it covered the column - a confidently wrong number
 * computed from a tenth of the data, with nothing on screen saying so. Redacted
 * cells are counted separately and reported as `nRedacted`, and
 * `isColumnComplete` is what the panel uses to decide whether a statistic may
 * be presented without a caveat.
 */

/** One column's extracted values, plus what had to be left out. */
export interface RawColumn {
  readonly index: number;
  readonly label: DataAtom | null;
  readonly kind: ColumnKind;
  /** Parsed numbers, in row order. Empty for non-numeric kinds. */
  readonly values: readonly number[];
  /** The table row each value came from. Positions, never content. */
  readonly rowIndexes: readonly number[];
  readonly nMissing: number;
  readonly nRedacted: number;
  /**
   * Cells that held something, were not redacted, and were not a number.
   *
   * Counted because it was previously counted NOWHERE. A 1,000-row column
   * where 200 cells read "N/A" reported `n=800, nMissing=0, nRedacted=0` -
   * which states that the column had 800 rows and every one of them parsed.
   * The mean was over 80% of the data and presented as covering all of it,
   * which is the same confidently-partial answer the placeholder guard above
   * exists to prevent, arriving by a different route.
   */
  readonly nUnparsed: number;
  /** Distinct non-empty strings, for a categorical column. A COUNT only. */
  readonly distinct: number | null;
}

export interface ReadTableResult {
  readonly columns: readonly RawColumn[];
  readonly rows: number;
  readonly cells: number;
  readonly truncated: boolean;
}

/**
 * Numbers a data table actually contains.
 *
 * Handles the separators a real page uses - thousands commas, currency symbols,
 * a trailing percent, a leading minus or parenthesised negative - because a
 * telemetry or sales table that reads `$1,234.50` is the ordinary case, and a
 * parser that returns `NaN` for it would classify the column as unknown and
 * silently analyse nothing.
 *
 * Deliberately NOT a general number parser: no exponents-with-units, no dates,
 * no fractions. Anything ambiguous returns null and is counted as missing,
 * which is visible, rather than being guessed at, which is not.
 */
/**
 * A leading currency mark, by code point.
 *
 * Written as escapes rather than as literal glyphs so the file stays ASCII and
 * a re-encoding cannot silently change which symbols are recognised. Dollar,
 * pound, euro, yen, rupee.
 */
const CURRENCY_PREFIX = /^[+$\u00A3\u20AC\u00A5\u20B9]\s*/;

export function parseNumber(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;

  // Parenthesised negative: accounting tables write (1,234) for -1234.
  const negParen = /^\((.*)\)$/.exec(t);
  const body = negParen === null ? t : (negParen[1] ?? '');
  const sign = negParen === null ? 1 : -1;

  // Currency and a trailing percent come off first; separators do NOT, because
  // which character is the separator is the whole question below.
  const stripped = body
    .replace(CURRENCY_PREFIX, '')
    .replace(/\s*%$/, '')
    .trim();

  /*
   * AMBIGUOUS SEPARATORS ARE REFUSED, NOT GUESSED.
   *
   * This used to delete every comma and space and parse whatever was left. On
   * an en-GB or en-IN page that is right. On a de-DE or fr-FR page it is wrong
   * by three orders of magnitude, silently:
   *
   *     "1.234,56"  ->  "1.23456"  ->  1.23456   (the value is 1234.56)
   *     "1 234,56"  ->  "1234,56"  ->  123456    (the value is 1234.56)
   *
   * Nothing in the string distinguishes 1.234 meaning one-thousand-two-hundred
   * from 1.234 meaning one-point-two-three-four, and a wrong number here reaches
   * the user as a fact. So only the two UNAMBIGUOUS shapes parse: comma-grouped
   * thousands with a dot decimal, or a plain number. Everything else returns
   * null and is COUNTED as unparsed - visible on the receipt and in the prompt,
   * rather than folded silently into a smaller n.
   */
  const GROUPED = /^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
  const PLAIN = /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/;
  if (!GROUPED.test(stripped) && !PLAIN.test(stripped)) return null;

  const n = Number.parseFloat(stripped.replace(/,/g, ''));
  return Number.isFinite(n) ? sign * n : null;
}

/**
 * Strings that mean "no value here", not "here is a category".
 *
 * Deliberately a short closed list of unambiguous markers. Adding anything
 * judgement-dependent to it would start discarding real categorical values as
 * missing, which is the opposite error and equally silent.
 */
const MISSING_MARKERS: ReadonlySet<string> = new Set([
  'n/a',
  'na',
  'n.a.',
  '-',
  '--',
  'null',
  'none',
  'nil',
  'nan',
  'undefined',
  '?',
]);

/** Text of a cell, without descending into anything scripted or hidden. */
function cellText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Picks the table worth analysing.
 *
 * The LARGEST by cell count, not the first. Real pages open with layout tables,
 * nav tables and one-row summary tables; the data is usually the biggest thing
 * on the page. Ties break toward the earlier one so the choice is stable across
 * steps - an analysis that silently switched tables between steps would make
 * every trend meaningless.
 */
export function chooseTable(doc: Document): { table: Element; index: number; found: number } | null {
  const tables = Array.from(doc.querySelectorAll('table'));
  if (tables.length === 0) return null;

  let best = -1;
  let bestCells = -1;
  tables.forEach((t, i) => {
    const cells = t.querySelectorAll('td,th').length;
    if (cells > bestCells) {
      bestCells = cells;
      best = i;
    }
  });
  const table = tables[best];
  if (table === undefined || bestCells <= 0) return null;
  return { table, index: best, found: tables.length };
}

/**
 * Classify a column from what parsed, without looking at any single value.
 *
 * REDACTED CELLS ARE NOT COUNTED AGAINST THE NUMERIC RATIO, and getting that
 * wrong made this feature silently useless on exactly the pages it exists for.
 *
 * The denominator was `nonEmpty`, which includes cells the redactor replaced.
 * So a column of three numbers and one stripped email scored 3/4 = 0.75 against
 * a 0.8 threshold, came back `unknown`, and its values were discarded - a
 * perfectly good telemetry column dropped because one row happened to contain
 * PII. The more PII a page had, the less of it could be analysed.
 *
 * The right denominator is what was AVAILABLE to parse: of the cells redaction
 * left us, how many were numbers. A redacted cell is a known unknown; it is
 * counted in `nRedacted` and excluded from the judgement, not held against it.
 */
function classify(
  numeric: number,
  redacted: number,
  nonEmpty: number,
  distinct: number,
): ColumnKind {
  if (nonEmpty === 0) return 'unknown';
  // Every populated cell was a placeholder: this column WAS PII, and saying so
  // is the most useful thing the receipt can carry about a table.
  if (redacted > 0 && redacted === nonEmpty) return 'redacted';

  const available = nonEmpty - redacted;
  if (available <= 0) return 'redacted';
  if (numeric >= available * 0.8) return 'numeric';
  // Few distinct values across many rows is a category, not free text.
  if (distinct > 0 && distinct <= Math.max(2, available / 4)) return 'categorical';
  return 'unknown';
}

/**
 * Reads one table into columns of numbers.
 *
 * Bounded by `limits` in three directions - rows, columns and total cells -
 * because a table is page-controlled and therefore attacker-controlled. A
 * hostile page handing the extension ten million cells would spend the user's
 * main thread, which costs metric 4 and metric 5 at once. `truncated` says when
 * a ceiling bit, so a partial read is never reported as a whole one.
 */
export function readTable(table: Element, limits: AnalysisLimits): ReadTableResult {
  const rowEls = Array.from(table.querySelectorAll('tr'));
  if (rowEls.length === 0) {
    return { columns: [], rows: 0, cells: 0, truncated: false };
  }

  /*
   * The header is the first row that is all <th>, or failing that the first row.
   * Its cells become the only page text this module emits, and they go through
   * `toDataAtom` exactly as an accessible name does.
   */
  /*
   * A HEADER IS AN ALL-<th> ROW OR THERE IS NO HEADER, and the fallback that
   * used to sit here shipped page data to the model.
   *
   * It was `... ?? rowEls[0]`, so on any table without a proper header row -
   * which is most hand-written HTML - the FIRST DATA ROW became the header and
   * its cells became `label` DataAtoms. A label is the ONE string this module
   * is allowed to emit, so a row of real values went out through the single
   * field the egress gate exists to let through. That is the leak this whole
   * layer is built to make impossible, arriving through the front door.
   *
   * With no header the columns are unlabelled and the model reads `col0`,
   * `col1`. Less useful and honest. The row also stays in the BODY, where it
   * belongs, rather than being dropped from every statistic.
   */
  const headerRow = rowEls.find((r) => {
    const cs = Array.from(r.children);
    return cs.length > 0 && cs.every((c) => c.tagName === 'TH');
  });

  const headerCells = headerRow === undefined ? [] : Array.from(headerRow.children);
  const bodyRows = headerRow === undefined ? rowEls : rowEls.filter((r) => r !== headerRow);

  // With no header the width comes from the widest body row, so an unlabelled
  // table is still analysable rather than silently empty.
  const widest = bodyRows.reduce((m, r) => Math.max(m, r.children.length), 0);
  const declaredCols = headerCells.length > 0 ? headerCells.length : widest;
  const nCols = Math.min(declaredCols, limits.maxColumns);
  if (nCols === 0) return { columns: [], rows: 0, cells: 0, truncated: false };

  const maxRows = Math.min(bodyRows.length, limits.maxRows, Math.floor(limits.maxCells / nCols));
  const truncated = maxRows < bodyRows.length || declaredCols > limits.maxColumns;

  const numeric: number[][] = Array.from({ length: nCols }, () => []);
  const rowIdx: number[][] = Array.from({ length: nCols }, () => []);
  const missing = new Array<number>(nCols).fill(0);
  const redacted = new Array<number>(nCols).fill(0);
  const nonEmpty = new Array<number>(nCols).fill(0);
  const unparsed = new Array<number>(nCols).fill(0);
  /*
   * Distinct-value tracking is CAPPED. An uncapped Set over a 100,000-row
   * free-text column is both a memory cost and, more importantly, a structure
   * holding every distinct cell value in it - which is the thing this module
   * exists not to build. Past the cap the column is not categorical anyway.
   */
  const DISTINCT_CAP = 64;
  const distinct: Set<string>[] = Array.from({ length: nCols }, () => new Set<string>());
  const distinctOverflow = new Array<boolean>(nCols).fill(false);

  let cells = 0;
  for (let r = 0; r < maxRows; r += 1) {
    const row = bodyRows[r];
    if (row === undefined) continue;
    const cs = row.children;
    for (let c = 0; c < nCols; c += 1) {
      const cell = cs[c];
      if (cell === undefined) {
        missing[c] = (missing[c] ?? 0) + 1;
        continue;
      }
      cells += 1;
      const text = cellText(cell);

      if (text === '') {
        missing[c] = (missing[c] ?? 0) + 1;
        continue;
      }
      /*
       * AN EXPLICIT "NO VALUE" IS MISSING, NOT A CATEGORY.
       *
       * A column of 1,000 rows where 400 read "N/A" was counted as 600 numbers
       * and 400 distinct-ish strings, which made `classify` see 600/1000 = 0.6
       * against its 0.8 threshold, call the column CATEGORICAL, and discard all
       * 600 numbers. The more incomplete a column, the less of it could be
       * analysed - the same shape of bug as counting redacted cells against the
       * numeric ratio, arriving through a different door.
       *
       * A closed list, not a heuristic: these are the strings that MEAN absent.
       * Anything else that fails to parse is still counted as `nUnparsed`, which
       * is reported rather than assumed.
       */
      if (MISSING_MARKERS.has(text.toLowerCase())) {
        missing[c] = (missing[c] ?? 0) + 1;
        continue;
      }

      nonEmpty[c] = (nonEmpty[c] ?? 0) + 1;

      /*
       * THE PLACEHOLDER CHECK, BEFORE ANY PARSE.
       *
       * `hasAnyPlaceholder` and not the /g regex directly: `ANY_PLACEHOLDER_RE`
       * carries the global flag, so `.test()` on it resumes from `lastIndex` and
       * alternates true/false across consecutive calls regardless of input.
       * CLAUDE.md records that exact bug making `DataAtom.redacted` wrong for
       * half the elements on a page, and this loop calls it once per cell.
       */
      if (hasAnyPlaceholder(text)) {
        redacted[c] = (redacted[c] ?? 0) + 1;
        continue;
      }

      /*
       * DISTINCT COUNTS EVERY VALUE, not only the ones that failed to parse.
       *
       * It used to be tallied inside the parse-failure branch, so a column of
       * "12", "15", "in review", "12" reported ONE distinct value - the count
       * only ever saw the non-numeric cells. That number then went to the model
       * as `categorical, 1 distinct values` for a column with four. The count is
       * meaningless for a numeric column and dropped there, so counting
       * everything costs nothing and makes the categorical case true.
       */
      if (!distinctOverflow[c]) {
        const set = distinct[c];
        if (set !== undefined) {
          set.add(text);
          if (set.size > DISTINCT_CAP) {
            distinctOverflow[c] = true;
            set.clear();
          }
        }
      }

      const n = parseNumber(text);
      if (n === null) {
        // Held something, was not redacted, was not a declared absence, and was
        // not a number. Previously reported by no counter at all.
        unparsed[c] = (unparsed[c] ?? 0) + 1;
        continue;
      }
      (numeric[c] as number[]).push(n);
      (rowIdx[c] as number[]).push(r);
    }
  }

  const columns: RawColumn[] = [];
  for (let c = 0; c < nCols; c += 1) {
    const head = headerCells[c];
    const labelText = head === undefined ? '' : cellText(head);
    const nums = numeric[c] ?? [];
    const kind = classify(
      nums.length,
      redacted[c] ?? 0,
      nonEmpty[c] ?? 0,
      distinctOverflow[c] === true ? Number.MAX_SAFE_INTEGER : (distinct[c]?.size ?? 0),
    );
    columns.push({
      index: c,
      /*
       * The ONE piece of page text that leaves this module, and it takes the
       * same route every other one does: re-marked untrusted, then through
       * `toDataAtom`, which neutralises control and bidi characters, defangs
       * prompt fence tokens and caps the length. A header is page-authored and
       * gets no more trust than a button label.
       */
      /*
       * `redacted` REPORTS, it does not assert. This passed a hard-coded
       * `false`, so a header the redactor had rewritten - a column titled
       * with an email address, say - travelled describing itself as
       * unredacted. Every other DataAtom in the codebase derives this from
       * the text it actually holds, and so does this one now.
       */
      label:
        labelText === ''
          ? null
          : toDataAtom(markUntrusted(labelText), { redacted: hasAnyPlaceholder(labelText) }),
      kind,
      values: kind === 'numeric' ? nums : [],
      rowIndexes: kind === 'numeric' ? (rowIdx[c] ?? []) : [],
      nMissing: missing[c] ?? 0,
      nRedacted: redacted[c] ?? 0,
      nUnparsed: unparsed[c] ?? 0,
      distinct:
        kind === 'categorical'
          ? distinctOverflow[c] === true
            ? null
            : (distinct[c]?.size ?? 0)
          : null,
    });
  }

  return { columns, rows: maxRows, cells, truncated };
}
