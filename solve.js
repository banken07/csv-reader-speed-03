// Minimal-cold CSV reader: output identical to csv-reader 1.0.0.
// Hot path is one line slice + split, or one field scan per field.
// Rare paths (unterminated quote, quote junk, stray-CR counting) live
// in separate small functions so the common path stays tiny and
// monomorphic: one object shape for errors, one array shape for rows.
export function run(input) {
  const s = input.text, hdr = input.header === true, n = s.length;
  const rows = [], er = [];
  let cols = null, w = -1, p = 0, ln = 1;
  if (n > 0 && s.charCodeAt(0) === 0xfeff) p = 1;
  for (;;) {
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 10) { p++; ln++; }
      else if (c === 13 && s.charCodeAt(p + 1) === 10) { p += 2; ln++; }
      else break;
    }
    if (p >= n) break;
    const rl = ln, rr = hdr && cols === null ? null : rows.length;
    const eol = s.indexOf('\n', p), le = eol < 0 ? n : eol, raw = s.slice(p, le);
    let f = null, fq = false;
    if (raw.indexOf('"') < 0) {
      if (raw.charCodeAt(raw.length - 1) === 13) {
        if (eol >= 0) {
          const b = raw.slice(0, -1);
          if (b.length > 0 && b.indexOf('\r') < 0) { f = b.split(','); p = eol + 1; ln++; }
        }
      } else if (raw.indexOf('\r') < 0) {
        if (raw.length > 0) { f = raw.split(','); p = eol < 0 ? n : eol + 1; ln++; }
        else { p = eol < 0 ? n : eol + 1; ln++; continue; }
      }
    }
    if (f === null) {
      f = [];
      let le2 = eol, term = 2;
      for (;;) {
        const q = s.charCodeAt(p) === 34;
        if (f.length === 0) fq = q;
        let v;
        if (!q) {
          const cm = s.indexOf(',', p);
          if (cm !== -1 && (le2 === -1 || cm < le2)) {
            v = s.slice(p, cm);
            if (v.indexOf('\r') !== -1) v = cut(er, v, rl, rr);
            p = cm + 1; term = 0;
          } else if (le2 !== -1) {
            v = s.slice(p, le2);
            if (v.indexOf('\r') !== -1) {
              v = v.charCodeAt(v.length - 1) === 13 ? v.slice(0, -1) : v;
              if (v.indexOf('\r') !== -1) v = cut(er, v, rl, rr);
            }
            p = le2 + 1; ln++; le2 = s.indexOf('\n', p); term = 1;
          } else {
            v = s.slice(p, n);
            if (v.indexOf('\r') !== -1) v = cut(er, v, rl, rr);
            p = n; term = 2;
          }
        } else {
          const op = p, ol = ln;
          let q2 = s.indexOf('"', op + 1);
          while (q2 !== -1 && s.charCodeAt(q2 + 1) === 34) q2 = s.indexOf('"', q2 + 2);
          if (q2 === -1) {
            er.push({ code: 'unterminated_quote', line: rl, row: rr });
            const r = unterm(s, er, op + 1, n, ol, rl, rr);
            v = r[0]; term = r[1]; p = r[2]; ln = r[3];
          } else {
            let c = s.slice(op + 1, q2);
            if (c.indexOf('\n') !== -1 || c.indexOf('\r') !== -1) {
              let b = 0;
              for (let i = 0; i < c.length; i++) {
                const cc = c.charCodeAt(i);
                if (cc === 10) b++;
                else if (cc === 13 && c.charCodeAt(i + 1) !== 10) b++;
              }
              ln += b;
              c = c.replace(/\r\n?/g, '\n');
            }
            if (c.indexOf('""') !== -1) c = c.replaceAll('""', '"');
            v = c; p = q2 + 1;
            if (p >= n) term = 2;
            else {
              const nx = s.charCodeAt(p);
              if (nx === 44) { p++; term = 0; }
              else if (nx === 10) { p++; ln++; term = 1; }
              else if (nx === 13 && s.charCodeAt(p + 1) === 10) { p += 2; ln++; term = 1; }
              else {
                const r = junk(s, er, p, n, ln, rl, rr, v);
                v = r[0]; term = r[1]; p = r[2]; ln = r[3];
                if (r[4] > 0) er.push({ code: 'quote_junk', line: rl, row: rr });
              }
            }
          }
          le2 = s.indexOf('\n', p);
        }
        f.push(v);
        if (term !== 0) break;
      }
    }
    if (f.length === 1 && f[0] === '' && !fq) continue;
    if (w < 0) w = f.length;
    if (hdr && cols === null) { cols = f; continue; }
    if (f.length < w) {
      er.push({ code: 'short_row', line: rl, row: rr, fields: f.length });
      while (f.length < w) f.push('');
    } else if (f.length > w) {
      er.push({ code: 'long_row', line: rl, row: rr, extra: f.splice(w) });
    }
    rows.push(f);
  }
  return { columns: hdr ? (cols ?? []) : null, rows, errors: er };
}

// Drop every CR in v, one stray_cr error per CR.
function cut(er, v, rl, rr) {
  let k = 0;
  for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) === 13) k++;
  for (let i = 0; i < k; i++) er.push({ code: 'stray_cr', line: rl, row: rr });
  return v.replaceAll('\r', '');
}

// Re-read after an unterminated quote: the quote is literal, the rest
// of the field reads as unquoted. Returns [value, term, pos, line]
// with term 0 = comma, 1 = break, 2 = EOF.
function unterm(s, er, p, n, ln, rl, rr) {
  let v = '"';
  for (;;) {
    if (p >= n) return [v, 2, p, ln];
    const c = s.charCodeAt(p);
    if (c === 44) return [v, 0, p + 1, ln];
    if (c === 10) return [v, 1, p + 1, ln + 1];
    if (c === 13) {
      if (s.charCodeAt(p + 1) === 10) return [v, 1, p + 2, ln + 1];
      er.push({ code: 'stray_cr', line: rl, row: rr });
      p++;
      continue;
    }
    v += s[p]; p++;
  }
}

// Scan junk after a closing quote up to the next comma or break.
// Returns [value, term, pos, line, added] where added counts the
// appended junk characters; the caller reports quote_junk if added > 0.
function junk(s, er, p, n, ln, rl, rr, v) {
  let added = 0;
  for (;;) {
    if (p >= n) return [v, 2, p, ln, added];
    const c = s.charCodeAt(p);
    if (c === 44) return [v, 0, p + 1, ln, added];
    if (c === 10) return [v, 1, p + 1, ln + 1, added];
    if (c === 13) {
      if (s.charCodeAt(p + 1) === 10) return [v, 1, p + 2, ln + 1, added];
      er.push({ code: 'stray_cr', line: rl, row: rr });
      p++;
      continue;
    }
    v += s[p]; added++; p++;
  }
}
