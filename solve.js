// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// answer {columns, rows, errors} for an input {text, header}.
//
// How it reads (the same policy, restated in my own words): the text is scanned
// once, left to right. A leading U+FEFF is dropped. A record ends at LF or CRLF;
// a line left with no characters is no record. Outside quotes a CR not followed
// by LF is dropped and reported as stray_cr. A field that opens with a quote
// runs to the next quote that is not doubled ("" inside is one quote, each CRLF
// or lone CR inside reads as LF); whatever follows the closing quote up to the
// next comma or line break is appended as it stands (quote_junk when anything
// was appended); a quote that never closes is a literal character and the text
// after it is read again as unquoted (unterminated_quote). A quote inside an
// unquoted field is literal. Fields stay strings, never trimmed or converted.
// columns is the first record when header is true, else null; rows holds the
// records after it, each padded with "" (short_row, with fields: its count) or
// cut (long_row, with extra: the cut fields) to the first record's width. Each
// error is {code, line, row}, in the order met; line is the 1-based line its
// record starts on, row its index in rows (null for the header).
//
// Speed: instead of walking one character at a time, every field is cut out
// with indexOf jumps to its next delimiter, and quoted fields are cut out with
// indexOf jumps to the next quote. A field's text is sliced out whole; only a
// field that actually holds a stray CR, or a quoted span that actually holds a
// line break, takes a slower clean-up pass. Two shortcuts reuse work done once
// per record: the record's line end (the first LF from its start) lets an
// unquoted field find its end with a single comma search while no quoted field
// has swallowed a line break, and a record known to hold no stray CR skips the
// per-field CR check. Nothing is kept from one call to the next.
// Dependency-free, no WASM, no native code.

const CR_LF_OR_LONE = /\r\n?/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  // Shortcuts for the record being read, computed once at its start: the
  // position of its first LF (-1 when the text holds no more), and whether an
  // unquoted field of this record could hold a stray CR (a CR strictly inside
  // the record's first line, the closing CRLF's CR excluded). Both stay true
  // only while no quoted field has swallowed a line break; a quoted span that
  // holds an LF moves the record past that line end and clears them.
  let hintValid = false;
  let hintLineEnd = -1;
  let hintHasCR = false;

  // Reads an unquoted field starting at pos, onto `value` ("" for a fresh field,
  // the quoted value when reading junk after a closing quote). Returns the field
  // and how it ended: 0 at a comma, 1 at a line break, 2 at the end of the text.
  // `added` counts the characters kept after the starting value.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      let end;
      let ended;
      if (hintValid) {
        const comma = text.indexOf(',', pos);
        if (hintLineEnd === -1) {
          if (comma === -1) {
            end = len;
            ended = 2;
          } else {
            end = comma;
            ended = 0;
          }
        } else if (comma !== -1 && comma < hintLineEnd) {
          end = comma;
          ended = 0;
        } else {
          end = hintLineEnd;
          ended = 1;
        }
      } else {
        const comma = text.indexOf(',', pos);
        const nl = text.indexOf('\n', pos);
        if (comma === -1) {
          if (nl === -1) {
            end = len;
            ended = 2;
          } else {
            end = nl;
            ended = 1;
          }
        } else if (nl === -1 || comma < nl) {
          end = comma;
          ended = 0;
        } else {
          end = nl;
          ended = 1;
        }
      }
      // A line break at end is a CRLF when the character before it is a CR;
      // that CR belongs to the break, not to the field.
      let segEnd = end;
      if (ended === 1 && end > pos && text.charCodeAt(end - 1) === 13) segEnd = end - 1;
      if (segEnd > pos) {
        const seg = text.slice(pos, segEnd);
        if (!hintValid || hintHasCR) {
          const cr = seg.indexOf('\r');
          if (cr === -1) {
            value += seg;
            added += seg.length;
          } else {
            // Every CR left in the span is a lone one: each is dropped and
            // reported, in order. (No LF can sit inside the span: end is the
            // first comma or LF, so a CR+LF pair cannot hide here.)
            const parts = seg.split('\r');
            for (let i = 1; i < parts.length; i++) {
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            }
            const clean = parts.join('');
            value += clean;
            added += clean.length;
          }
        } else {
          value += seg;
          added += seg.length;
        }
      }
      pos = end;
      if (ended === 0) {
        pos += 1;
        return { value, ended: 0, added };
      }
      if (ended === 1) {
        pos += 1;
        line += 1;
        return { value, ended: 1, added };
      }
      return { value, ended: 2, added };
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field and
  // how it ended, with the same 0/1/2 codes as readUnquoted.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted. The scan's line counting is
        // thrown away with it, and the record shortcuts stand as they were.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (q > pos) {
        const seg = text.slice(pos, q);
        const hasNL = seg.indexOf('\n') !== -1;
        if (!hasNL && seg.indexOf('\r') === -1) {
          value += seg;
        } else {
          // CRLF and lone CR inside quotes each read as one LF. A span
          // holding an LF moves the record past the shortcut line end.
          if (hasNL) hintValid = false;
          const flat = seg.replace(CR_LF_OR_LONE, '\n');
          let breaks = 0;
          let at = -1;
          while ((at = flat.indexOf('\n', at + 1)) !== -1) breaks += 1;
          line += breaks;
          value += flat;
        }
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one literal quote; keep reading.
        value += '"';
        pos = q + 2;
        continue;
      }
      // The quote at q closes the field.
      pos = q + 1;
      if (pos >= len) return { value, ended: 2 };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: 0 };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: 1 };
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return { value, ended: 1 };
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = readUnquoted(value);
      if (junk.added > 0) {
        errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      }
      return junk;
    }
  }

  // Pads or cuts one finished record to the first record's width, records a
  // short_row or long_row error when it does, and files the record: as the
  // header when it is the first record of a headed file, else as a row.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The record's first line, and whether it holds a quote or a stray CR.
    // The line is sliced once and both checks run on the slice, so neither
    // scan can run past the line's end looking for the next quote or CR.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    const lineSlice = text.slice(pos, lineEnd);
    const hasQuote = lineSlice.indexOf('"') !== -1;
    const hasTrailingCR = nl !== -1 && lineSlice.charCodeAt(lineSlice.length - 1) === 13;
    const firstCR = lineSlice.indexOf('\r');
    const hasStrayCR = firstCR !== -1 && !(hasTrailingCR && firstCR === lineSlice.length - 1);

    // Fast path: a whole line with no quote in it and no stray CR is plain
    // fields. (A quoted field can span lines, so any quote at all rules the
    // fast path out.)
    if (!hasQuote && !hasStrayCR && lineEnd > pos) {
      const body = hasTrailingCR ? lineSlice.slice(0, -1) : lineSlice;
      const fields = body === '' ? [''] : body.split(',');
      pos = nl === -1 ? len : nl + 1;
      if (nl !== -1) line += 1;
      // A line left with no characters is no record.
      if (!(fields.length === 1 && fields[0] === '')) finishRecord(fields);
      continue;
    }

    // Shortcuts for the field-by-field reader below.
    hintValid = true;
    hintLineEnd = nl;
    hintHasCR = hasStrayCR;

    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === 0);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
