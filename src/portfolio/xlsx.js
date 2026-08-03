/* Spreadsheet reader — .xlsx and .csv, with no library.

   An .xlsx file is a ZIP archive of XML parts. Everything needed to open one
   is now a platform primitive: DataView to walk the ZIP directory, and
   DecompressionStream("deflate-raw") to inflate the members. That keeps the
   project's promise of no dependencies and no build step.

   Deliberately avoids DOMParser so this runs in Node under `node --test` as
   well as in the browser. The XML shapes inside a workbook are narrow and
   well known, so scanning them directly is honest rather than fragile.

   Known limits: no ZIP64 (files above 4GB), no encrypted workbooks, and no
   support for the old binary .xls format — those are reported as errors
   rather than guessed at. Formula cells yield their last cached value. */

const SIG_EOCD = 0x06054b50;
const SIG_CEN  = 0x02014b50;
const SIG_LOC  = 0x04034b50;

/* ============================================================
   ZIP
   ============================================================ */

export function findZipEntries(bytes){
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  /* The end-of-central-directory record sits at the very end, after a comment
     of up to 64KB. Scan backwards for its signature. */
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 66000);
  for(let i = bytes.length - 22; i >= floor; i--){
    if(dv.getUint32(i, true) === SIG_EOCD){ eocd = i; break; }
  }
  if(eocd === -1) throw new Error("This does not look like an .xlsx file — no ZIP directory found.");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);

  const entries = new Map();
  const dec = new TextDecoder();
  for(let n = 0; n < count; n++){
    if(p + 46 > bytes.length || dv.getUint32(p, true) !== SIG_CEN) break;
    const method         = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size           = dv.getUint32(p + 24, true);
    const nameLen        = dv.getUint16(p + 28, true);
    const extraLen       = dv.getUint16(p + 30, true);
    const commentLen     = dv.getUint16(p + 32, true);
    const localOffset    = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(bytes){
  if(typeof DecompressionStream !== "function"){
    throw new Error("This browser cannot unzip .xlsx files. Save the sheet as CSV and upload that instead.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipEntry(bytes, entry){
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const off = entry.localOffset;
  if(dv.getUint32(off, true) !== SIG_LOC) throw new Error("Damaged .xlsx file — bad local header.");
  const nameLen  = dv.getUint16(off + 26, true);
  const extraLen = dv.getUint16(off + 28, true);
  const start = off + 30 + nameLen + extraLen;
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if(entry.method === 0) return raw;
  if(entry.method === 8) return inflateRaw(raw);
  throw new Error(`Unsupported compression inside the .xlsx file (method ${entry.method}).`);
}

/* ============================================================
   XML
   ============================================================ */

const NAMED = { amp:"&", lt:"<", gt:">", quot:'"', apos:"'" };

export function decodeXml(s){
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ent) => {
    if(ent[0] === "#"){
      const hex = ent[1] === "x" || ent[1] === "X";
      const code = hex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code >= 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ent] ?? whole;
  });
}

/* "A1" -> 0, "B7" -> 1, "AA1" -> 26 */
export function colRefToIndex(ref){
  const m = /^([A-Za-z]+)/.exec(String(ref ?? ""));
  if(!m) return -1;
  let n = 0;
  for(const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const allText = frag => {
  let out = "", m;
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  while((m = re.exec(frag))) out += m[1];
  return decodeXml(out);
};

export function parseSharedStrings(xml){
  const out = [];
  const re = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while((m = re.exec(xml))) out.push(m[1] == null ? "" : allText(m[1]));
  return out;
}

function cellValue(attrs, body, shared){
  const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
  if(type === "inlineStr") return allText(body);
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
  if(!v) return "";
  const raw = decodeXml(v[1]);
  if(type === "s") return shared[Number(raw)] ?? "";
  if(type === "str" || type === "e") return raw;
  if(type === "b") return raw === "1";
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) ? n : raw;
}

export function parseSheet(xml, shared = []){
  const rows = [];
  const rowRe = /<row\b([^>]*)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm;
  while((rm = rowRe.exec(xml))){
    const attrs = rm[1] ?? rm[2] ?? "";
    const body  = rm[3] ?? "";
    const declared = /\br="(\d+)"/.exec(attrs)?.[1];
    const rowIdx = declared ? Number(declared) - 1 : rows.length;

    const cells = [];
    const cRe = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cm, next = 0;
    while((cm = cRe.exec(body))){
      const cAttrs = cm[1] ?? cm[2] ?? "";
      const cBody  = cm[3] ?? "";
      const ref = /\br="([A-Za-z]+\d+)"/.exec(cAttrs)?.[1];
      const col = ref ? colRefToIndex(ref) : next;
      next = col + 1;
      cells[col] = cellValue(cAttrs, cBody, shared);
    }
    for(let i = 0; i < cells.length; i++) if(cells[i] === undefined) cells[i] = "";
    rows[rowIdx] = cells;
  }
  for(let i = 0; i < rows.length; i++) if(!rows[i]) rows[i] = [];
  return rows;
}

function parseWorkbook(xml){
  const out = [];
  const re = /<sheet\b([^>]*)\/>|<sheet\b([^>]*)>[\s\S]*?<\/sheet>/g;
  let m;
  while((m = re.exec(xml))){
    const a = m[1] ?? m[2] ?? "";
    out.push({
      name: decodeXml(/\bname="([^"]*)"/.exec(a)?.[1] ?? ""),
      rid: /\br:id="([^"]*)"/.exec(a)?.[1]
    });
  }
  return out;
}

function parseRels(xml){
  const map = {};
  const re = /<Relationship\b([^>]*)\/>/g;
  let m;
  while((m = re.exec(xml))){
    const id = /\bId="([^"]*)"/.exec(m[1])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[1])?.[1];
    if(id && target) map[id] = target;
  }
  return map;
}

/* ============================================================
   WORKBOOK
   ============================================================ */

export async function readXlsx(bytes, sheetIndex = 0){
  const entries = findZipEntries(bytes);
  const dec = new TextDecoder();
  const textOf = async name =>
    entries.has(name) ? dec.decode(await readZipEntry(bytes, entries.get(name))) : null;

  const sharedXml = await textOf("xl/sharedStrings.xml");
  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];

  /* Tab order lives in workbook.xml; the file each tab maps to lives in the
     rels part. sheet1.xml is NOT reliably the first tab, so resolve properly
     and only fall back to guessing if those parts are missing. */
  const sheets = parseWorkbook(await textOf("xl/workbook.xml") ?? "");
  const rels = parseRels(await textOf("xl/_rels/workbook.xml.rels") ?? "");

  let path = null, sheetName = null;
  const chosen = sheets[sheetIndex] ?? sheets[0];
  if(chosen){
    sheetName = chosen.name;
    const target = chosen.rid ? rels[chosen.rid] : null;
    if(target) path = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
  }
  if(!path || !entries.has(path)){
    path = [...entries.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  }
  if(!path) throw new Error("No worksheet found inside the workbook.");

  const rows = parseSheet(dec.decode(await readZipEntry(bytes, entries.get(path))), shared);
  return { rows, sheetName, sheetNames: sheets.map(s => s.name), path };
}

/* ============================================================
   CSV
   ============================================================ */

export function parseCsv(text, delimiter){
  const src = String(text ?? "").replace(/^﻿/, "");
  if(!delimiter){
    const firstLine = src.slice(0, src.indexOf("\n") === -1 ? src.length : src.indexOf("\n"));
    const tabs = (firstLine.match(/\t/g) || []).length;
    const commas = (firstLine.match(/,/g) || []).length;
    const semis = (firstLine.match(/;/g) || []).length;
    delimiter = tabs > commas && tabs > semis ? "\t" : (semis > commas ? ";" : ",");
  }

  const rows = [];
  let row = [], field = "", quoted = false;
  for(let i = 0; i < src.length; i++){
    const ch = src[i];
    if(quoted){
      if(ch === '"'){
        if(src[i + 1] === '"'){ field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    }
    else if(ch === '"') quoted = true;
    else if(ch === delimiter){ row.push(field); field = ""; }
    else if(ch === "\n"){ row.push(field); rows.push(row); row = []; field = ""; }
    else if(ch !== "\r") field += ch;
  }
  if(field !== "" || row.length){ row.push(field); rows.push(row); }
  return rows;
}

/* ============================================================
   ENTRY POINT
   ============================================================ */

/* `data` is a Uint8Array for a real file, or a string for pasted text. */
export async function readSpreadsheet(data, filename = ""){
  if(typeof data === "string") return { rows: parseCsv(data), sheetName: null, kind: "csv" };

  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  /* Old binary .xls starts with an OLE2 compound-file header. It is a wholly
     different format — say so rather than failing obscurely. */
  if(bytes[0] === 0xD0 && bytes[1] === 0xCF){
    throw new Error("That is an old .xls file. Re-save it as .xlsx or CSV and try again.");
  }
  if(bytes[0] === 0x50 && bytes[1] === 0x4B || /\.xlsx$/i.test(filename)){
    return { ...await readXlsx(bytes), kind: "xlsx" };
  }
  return { rows: parseCsv(new TextDecoder().decode(bytes)), sheetName: null, kind: "csv" };
}
