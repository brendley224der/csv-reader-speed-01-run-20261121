// A faster drop-in for csv-reader 1.0.0: the same answers, read in one pass.
//
// How it works, in brief: the reference builds every field one character at
// a time. This reader instead cuts each field out of the text with slice()
// once its end is known, scanning for that end with a tight charCodeAt loop
// that keeps no per-character string. A record whose line holds no quote and
// no stray carriage return is cut in one go with split(','). Quoted fields
// are found by jumping from quote to quote with indexOf('"'), and their
// content is one slice unless it holds a doubled quote or a line break, in
// which case the short span is walked once. Every rule below mirrors the reference's broken
// row policy exactly: BOM dropped, empty lines are no records, a lone CR
// outside quotes is dropped (stray_cr), a quoted field runs to the next
// non-doubled quote with "" read as one quote and every CR or CRLF inside
// read as LF, junk after a closing quote is appended as-is (quote_junk), a
// quote that never closes is literal and the rest is re-read unquoted
// (unterminated_quote), a quote inside an unquoted field is literal, and
// rows are padded (short_row) or cut (long_row) to the first record's width.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Dependency-free ES module; run(input) returns {columns, rows,
// errors} for one case's input {text, header}.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/**
 * Reads one unquoted field starting at `pos`, with `init` already in its
 * value ('' for a plain field, '"' for the re-read after an unterminated
 * quote, the quoted value for the junk after a closing quote). Writes
 * [value, ended, pos, line] into `out` and pushes a stray_cr error for every
 * lone CR dropped. The field ends at the first comma, line break, or end of
 * text after `pos`; a CR right before a LF is the CRLF line break, not a
 * stray CR.
 */
function readUnquoted(text, pos, init, line, recordLine, recordRow, errors, out) {
  const n = text.length;
  let i = pos;
  let segStart = pos;
  let parts = null;
  let ended;
  let adv = 1;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 44) { ended = COMMA; break; }
    if (c === 10) { ended = LINE_BREAK; break; }
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) { ended = LINE_BREAK; adv = 2; break; }
      if (parts === null) parts = [];
      parts.push(text.slice(segStart, i));
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      i += 1;
      segStart = i;
      continue;
    }
    i += 1;
  }
  if (i >= n) ended = END;
  const tail = text.slice(segStart, i);
  const seg = parts === null ? tail : parts.join('') + tail;
  out[0] = init === '' ? seg : init + seg;
  out[1] = ended;
  out[2] = ended === END ? n : i + adv;
  out[3] = ended === LINE_BREAK ? line + 1 : line;
}

/** csv-reader 1.0.0's answer for one case's input, read faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0; // a U+FEFF at the very start is dropped
  let line = 1;
  const out = ['', 0, 0, 0]; // scratch for readUnquoted: [value, ended, pos, line]

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
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
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // Fast path: one whole record with no quote and no stray CR. Find the
    // line's end, and when the line (minus a trailing CRLF) holds neither a
    // quote nor a CR, its fields are just the line split on commas.
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? n : lf;
    const effEnd =
      lf !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    const lineStr = text.slice(pos, effEnd);
    if (lineStr.indexOf('"') === -1 && lineStr.indexOf('\r') === -1) {
      const fields = lineStr.split(',');
      pos = lf === -1 ? n : lf + 1;
      line += 1;
      // A line that held only stray CRs is left with no characters: no
      // record. (Unreachable here — such a line holds a CR — but kept so the
      // fast path and the slow path agree.)
      if (fields.length === 1 && fields[0] === '') continue;
      if (width < 0) width = fields.length;
      if (header && columns === null) {
        columns = fields;
        continue;
      }
      if (fields.length < width) {
        errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
      }
      rows.push(fields);
      continue;
    }

    // Slow path: the record holds a quote, a stray CR, or a quoted field
    // spanning lines. Read it field by field.
    const fields = [];
    let lastQuoted = false;
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        const open = pos;
        const openLine = line;
        // Find the closing quote, jumping from quote to quote; a quote
        // doubled by another quote is one literal quote, not a close.
        let i = pos + 1;
        let closed = -1;
        for (;;) {
          const q = text.indexOf('"', i);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            i = q + 2;
            continue;
          }
          closed = q;
          break;
        }
        if (closed === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          readUnquoted(text, open + 1, '"', openLine, recordLine, recordRow, errors, out);
          pos = out[2];
          line = out[3];
          fields.push(out[0]);
          if (out[1] !== COMMA) break;
          continue;
        }
        // The quoted content is one slice, unless it holds a doubled quote
        // or a line break, in which case walk the short span once: "" reads
        // as one quote, every CRLF or lone CR reads as LF, and each counts
        // one line.
        const raw = text.slice(open + 1, closed);
        let value = raw;
        if (raw.indexOf('"') !== -1 || raw.indexOf('\n') !== -1 || raw.indexOf('\r') !== -1) {
          const parts = [];
          let seg = 0;
          for (let k = 0; k < raw.length; k++) {
            const c = raw.charCodeAt(k);
            if (c === 34) {
              parts.push(raw.slice(seg, k), '"');
              if (raw.charCodeAt(k + 1) === 34) k += 1;
              seg = k + 1;
            } else if (c === 13) {
              parts.push(raw.slice(seg, k), '\n');
              line += 1;
              if (raw.charCodeAt(k + 1) === 10) k += 1;
              seg = k + 1;
            } else if (c === 10) {
              parts.push(raw.slice(seg, k), '\n');
              line += 1;
              seg = k + 1;
            }
          }
          parts.push(raw.slice(seg));
          value = parts.join('');
        }
        pos = closed + 1;
        if (pos >= n) {
          fields.push(value);
          break;
        }
        const c = text.charCodeAt(pos);
        if (c === 44) {
          fields.push(value);
          pos += 1;
          continue;
        }
        if (c === 10) {
          fields.push(value);
          pos += 1;
          line += 1;
          break;
        }
        if (c === 13 && text.charCodeAt(pos + 1) === 10) {
          fields.push(value);
          pos += 2;
          line += 1;
          break;
        }
        // What follows the closing quote is appended as it stands, up to
        // the next comma or line break.
        readUnquoted(text, pos, value, line, recordLine, recordRow, errors, out);
        if (out[0].length - value.length > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
        pos = out[2];
        line = out[3];
        fields.push(out[0]);
        if (out[1] !== COMMA) break;
        continue;
      }
      // Unquoted field: a quote inside it is a literal character.
      lastQuoted = false;
      readUnquoted(text, pos, '', line, recordLine, recordRow, errors, out);
      pos = out[2];
      line = out[3];
      fields.push(out[0]);
      if (out[1] !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
