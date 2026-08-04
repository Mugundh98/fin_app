/* PDF text extraction — no dependencies, no DOM.

   A PDF is not a table. Text is drawn at coordinates by content-stream
   operators, and any row-and-column structure is something the reader has to
   reconstruct from where the glyphs landed. That is what this does: pull out
   the text-showing operators with their positions, group them into lines by
   y, then split each line into cells by the gaps in x.

   FlateDecode streams are inflated with DecompressionStream("deflate") — note
   the zlib wrapper, unlike the raw deflate a ZIP member uses.

   What this will NOT do, reported as errors rather than guessed at:
     - Password-protected files. CAMS and KFintech CAS statements are always
       encrypted, so those need the password removed first, or a CSV export.
     - Scanned or image-only PDFs. There is no OCR here; a page of pixels has
       no text to find.
     - Exotic font encodings with no ToUnicode map may come back as mojibake.
   Anything it cannot read is meant to fall back to typing the numbers in. */

const PDF_MAGIC = "%PDF-";

/* Bytes -> a string where one char is one byte. Structural scanning has to
   happen on bytes, not UTF-8, or binary stream data corrupts the offsets. */
export function latin1(bytes){
  let out = "";
  const CHUNK = 0x8000;
  for(let i = 0; i < bytes.length; i += CHUNK){
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

export function isPdf(bytes){
  return !!bytes && bytes.length > 5 && latin1(bytes.subarray(0, 5)) === PDF_MAGIC;
}

async function inflate(bytes){
  if(typeof DecompressionStream !== "function"){
    throw new Error("This browser cannot decompress PDF streams. Export the statement as CSV instead.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ============================================================
   STRINGS
   ============================================================ */

/* PDF literal string: (text) with backslash escapes and balanced parens. */
export function decodeLiteral(src){
  let out = "", depth = 0;
  for(let i = 0; i < src.length; i++){
    const c = src[i];
    if(c === "\\"){
      const n = src[++i];
      if(n === "n") out += "\n";
      else if(n === "r") out += "\r";
      else if(n === "t") out += "\t";
      else if(n === "b") out += "\b";
      else if(n === "f") out += "\f";
      else if(n >= "0" && n <= "7"){
        let oct = n;
        while(oct.length < 3 && src[i+1] >= "0" && src[i+1] <= "7") oct += src[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      }
      else if(n === "\n") { /* line continuation */ }
      else out += n;
    }
    else if(c === "("){ depth++; out += c; }
    else if(c === ")"){ if(depth === 0) break; depth--; out += c; }
    else out += c;
  }
  return out;
}

/* PDF hex string: <48656C6C6F>, optionally with whitespace. */
export function decodeHex(src){
  const hex = src.replace(/[^0-9a-fA-F]/g, "");
  let out = "";
  for(let i = 0; i < hex.length; i += 2){
    out += String.fromCharCode(parseInt((hex.substr(i, 2) + "0").slice(0, 2), 16));
  }
  return out;
}

/* ============================================================
   ToUnicode CMaps
   ============================================================ */

/* Subset fonts map byte codes to arbitrary glyph ids, so without the font's
   ToUnicode map the text is meaningless. Maps from every font in the file are
   merged into one table — resolving which font is active would mean walking
   page resource dictionaries, and in practice the subsets agree. */
export function parseCMap(text, into = new Map()){
  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while((m = charRe.exec(text))){
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let p;
    while((p = pairRe.exec(m[1]))){
      into.set(parseInt(p[1], 16), hexToStr(p[2]));
    }
  }
  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while((m = rangeRe.exec(text))){
    const simple = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let r;
    while((r = simple.exec(m[1]))){
      const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16), dst = parseInt(r[3], 16);
      /* Guard against a corrupt range asking for millions of entries. */
      if(hi < lo || hi - lo > 65535) continue;
      for(let c = lo; c <= hi; c++) into.set(c, String.fromCodePoint(dst + (c - lo)));
    }
  }
  return into;
}

function hexToStr(hex){
  let out = "";
  for(let i = 0; i + 3 < hex.length + 1; i += 4){
    const code = parseInt(hex.substr(i, 4), 16);
    if(Number.isFinite(code)) out += String.fromCodePoint(code);
  }
  return out || String.fromCharCode(parseInt(hex, 16) || 0);
}

/* Apply a CMap to a raw show-string. Codes are two bytes when the map looks
   two-byte, one otherwise. */
function mapText(raw, cmap, twoByte){
  if(!cmap || cmap.size === 0) return raw;
  let out = "";
  if(twoByte){
    for(let i = 0; i + 1 < raw.length; i += 2){
      const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1);
      out += cmap.has(code) ? cmap.get(code) : "";
    }
    return out;
  }
  for(let i = 0; i < raw.length; i++){
    const code = raw.charCodeAt(i);
    out += cmap.has(code) ? cmap.get(code) : raw[i];
  }
  return out;
}

/* ============================================================
   CONTENT STREAMS
   ============================================================ */

/* Walk a content stream, returning positioned text runs.
   Only the operators that move the pen or show text are interpreted; the rest
   of the graphics model is irrelevant to reading a table. */
export function extractRuns(content, cmap){
  const runs = [];
  let x = 0, y = 0, lineX = 0, lineY = 0, leading = 0;
  let pending = "", pendingX = 0, pendingY = 0, started = false;

  const flush = () => {
    if(started && pending.trim()) runs.push({ x: pendingX, y: pendingY, text: pending });
    pending = ""; started = false;
  };
  const show = text => {
    if(!started){ pendingX = x; pendingY = y; started = true; }
    pending += text;
  };

  const re = /(\[(?:[^\][\\]|\\.)*\]|\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]*>|[-+0-9.]+|\/[^\s/[\]<>()]+|[A-Za-z'"*]+)/g;
  const stack = [];
  let tok;
  while((tok = re.exec(content))){
    const t = tok[0];

    if(/^[-+0-9.]+$/.test(t) || t[0] === "/" || t[0] === "(" || t[0] === "<" || t[0] === "["){
      stack.push(t);
      continue;
    }

    switch(t){
      case "BT": x = y = lineX = lineY = 0; flush(); break;
      case "ET": flush(); break;

      case "Td": {
        const ty = Number(stack.pop()), tx = Number(stack.pop());
        flush(); lineX += tx; lineY += ty; x = lineX; y = lineY;
        break;
      }
      case "TD": {
        const ty = Number(stack.pop()), tx = Number(stack.pop());
        flush(); leading = -ty; lineX += tx; lineY += ty; x = lineX; y = lineY;
        break;
      }
      case "Tm": {
        const f = Number(stack.pop()), e = Number(stack.pop());
        stack.pop(); stack.pop(); stack.pop(); stack.pop();
        flush(); lineX = e; lineY = f; x = e; y = f;
        break;
      }
      case "TL": leading = Number(stack.pop()) || 0; break;
      case "T*": flush(); lineY -= leading; x = lineX; y = lineY; break;

      case "Tj": case "'": case "\"": {
        if(t !== "Tj"){ flush(); lineY -= leading; x = lineX; y = lineY; }
        const s = stack.pop();
        if(s) show(decodeShow(s, cmap));
        break;
      }
      case "TJ": {
        const arr = stack.pop();
        if(arr) show(decodeArray(arr, cmap));
        break;
      }
      default: stack.length = 0;
    }
  }
  flush();
  return runs;
}

function decodeShow(token, cmap){
  if(token[0] === "("){
    return mapText(decodeLiteral(token.slice(1, -1)), cmap, false);
  }
  if(token[0] === "<"){
    return mapText(decodeHex(token.slice(1, -1)), cmap, true);
  }
  return "";
}

/* [(Fund) -250 (Name)] TJ — the numbers are kerning offsets. A large negative
   offset is a real gap between words, so it becomes a space. */
function decodeArray(token, cmap){
  let out = "";
  const re = /\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]*>|-?[\d.]+/g;
  let m;
  while((m = re.exec(token))){
    const t = m[0];
    if(t[0] === "(" || t[0] === "<") out += decodeShow(t, cmap);
    else if(Number(t) <= -120) out += " ";
  }
  return out;
}

/* ============================================================
   LAYOUT
   ============================================================ */

/* Runs -> rows of cells. Text sharing a baseline is one row; a horizontal gap
   wider than `gap` starts a new cell. */
export function runsToRows(runs, { yTolerance = 2.5, gap = 8 } = {}){
  if(!runs.length) return [];

  const lines = [];
  for(const r of [...runs].sort((a, b) => b.y - a.y || a.x - b.x)){
    const line = lines.find(l => Math.abs(l.y - r.y) <= yTolerance);
    if(line){ line.items.push(r); line.y = (line.y + r.y) / 2; }
    else lines.push({ y: r.y, items: [r] });
  }

  return lines.map(line => {
    const items = line.items.sort((a, b) => a.x - b.x);
    const cells = [];
    let current = "", lastEnd = null;
    for(const it of items){
      /* No font metrics here, so width is estimated from the character count.
         It only has to be good enough to tell a word space from a column. */
      const width = it.text.length * 5;
      if(lastEnd !== null && it.x - lastEnd > gap){ cells.push(current.trim()); current = ""; }
      current += (current && lastEnd !== null && it.x - lastEnd > 1 ? " " : "") + it.text;
      lastEnd = it.x + width;
    }
    if(current.trim()) cells.push(current.trim());
    return cells;
  }).filter(cells => cells.length > 0);
}

/* ============================================================
   DOCUMENT
   ============================================================ */

/* Pull every stream out of the file. Streams are located by their keyword
   rather than by parsing the cross-reference table, which keeps this robust
   against the incremental updates and broken xrefs real files are full of. */
async function readStreams(bytes){
  const s = latin1(bytes);
  const out = [];
  const re = /stream\r\n|stream\n|stream\r/g;
  let m;
  while((m = re.exec(s))){
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if(end === -1) continue;

    /* The dictionary sits immediately before the keyword. */
    const dictStart = s.lastIndexOf("<<", m.index);
    const dict = dictStart === -1 ? "" : s.slice(dictStart, m.index);

    /* A writer normally puts an EOL between the data and `endstream`, and that
       byte is not part of the stream. Feeding it to the inflater fails the
       whole stream, so trim it. /Length is authoritative when it is a direct
       number that lands where the keyword does — it is often an indirect
       reference, in which case the digits are an object number, not a size. */
    let stop = end;
    while(stop > start && (bytes[stop - 1] === 0x0A || bytes[stop - 1] === 0x0D)) stop--;
    const lenMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    if(lenMatch){
      const declared = start + Number(lenMatch[1]);
      if(declared <= end && end - declared <= 4) stop = declared;
    }

    let data = bytes.subarray(start, stop);
    if(/\/FlateDecode/.test(dict)){
      try { data = await inflate(data); }
      catch { continue; }                    // damaged or unsupported filter
    }
    else if(/\/Filter/.test(dict)) continue; // DCTDecode, CCITTFax and friends

    out.push({ dict, text: latin1(data) });
    re.lastIndex = end;
  }
  return out;
}

export async function extractPdfRows(bytes){
  if(!isPdf(bytes)) throw new Error("That does not look like a PDF file.");

  const head = latin1(bytes.subarray(0, Math.min(bytes.length, 4096)));
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 4096)));
  if(/\/Encrypt\b/.test(head) || /\/Encrypt\b/.test(tail)){
    throw new Error("This PDF is password-protected. CAS statements from CAMS and KFintech always are — open it, save an unprotected copy, and try again. A CSV export also works.");
  }

  const streams = await readStreams(bytes);
  if(!streams.length){
    throw new Error("No readable text found. If this is a scanned statement it is a picture, not text, and will have to be entered by hand.");
  }

  /* Merge every ToUnicode map in the file before decoding any text. */
  const cmap = new Map();
  for(const s of streams){
    if(/beginbfchar|beginbfrange/.test(s.text)) parseCMap(s.text, cmap);
  }

  const rows = [];
  for(const s of streams){
    if(!/\bTj\b|\bTJ\b/.test(s.text)) continue;
    const runs = extractRuns(s.text, cmap);
    if(runs.length) rows.push(...runsToRows(runs));
  }

  if(!rows.length){
    throw new Error("No readable text found. If this is a scanned statement it is a picture, not text, and will have to be entered by hand.");
  }
  return rows;
}

/* Plain text, for showing the user what was actually read. */
export async function extractPdfText(bytes){
  return (await extractPdfRows(bytes)).map(r => r.join("\t")).join("\n");
}
