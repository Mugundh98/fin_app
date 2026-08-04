import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  isPdf, latin1, decodeLiteral, decodeHex, parseCMap,
  extractRuns, runsToRows, extractPdfRows, extractPdfText
} from "../../public/src/shared/pdf.js";

/* ------------------------------------------------------------------
   A real (if minimal) PDF writer, so the reader is tested against
   actual file bytes rather than a mock of what one might look like.
   ------------------------------------------------------------------ */
function pdfBytes(parts, { trailer = "<< /Root 1 0 R >>" } = {}){
  const chunks = [Buffer.from("%PDF-1.4\n", "latin1")];
  parts.forEach((p, i) => {
    chunks.push(Buffer.from(`${i + 1} 0 obj\n${p.dict}\nstream\n`, "latin1"));
    chunks.push(p.data);
    chunks.push(Buffer.from("\nendstream\nendobj\n", "latin1"));
  });
  chunks.push(Buffer.from(`trailer\n${trailer}\n%%EOF`, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}

const plain = text => ({
  dict: `<< /Length ${text.length} >>`,
  data: Buffer.from(text, "latin1")
});

const flate = text => {
  const d = deflateSync(Buffer.from(text, "latin1"));
  return { dict: `<< /Length ${d.length} /Filter /FlateDecode >>`, data: d };
};

/* A two-column holdings table, drawn the way a real statement draws one. */
const TABLE = `BT
/F1 10 Tf
50 700 Td (Fund) Tj
200 0 Td (Market Value) Tj
-200 -20 Td (HDFC Flexi Cap) Tj
200 0 Td (250000) Tj
-200 -20 Td (SBI Liquid Fund) Tj
200 0 Td (150000) Tj
ET`;

/* ------------------------------------------------------------------
   Detection
   ------------------------------------------------------------------ */

test("recognises a PDF by its magic bytes", () => {
  assert.equal(isPdf(pdfBytes([plain(TABLE)])), true);
  assert.equal(isPdf(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])), false);
  assert.equal(isPdf(new Uint8Array(3)), false);
  assert.equal(isPdf(null), false);
});

test("latin1 keeps one byte to one character", () => {
  const bytes = new Uint8Array([0, 65, 200, 255]);
  const s = latin1(bytes);
  assert.equal(s.length, 4);
  assert.equal(s.charCodeAt(2), 200);
  assert.equal(s.charCodeAt(3), 255);
});

test("latin1 survives a payload larger than the argument limit", () => {
  const big = new Uint8Array(200000).fill(65);
  assert.equal(latin1(big).length, 200000);
});

/* ------------------------------------------------------------------
   Strings
   ------------------------------------------------------------------ */

test("decodes literal string escapes", () => {
  assert.equal(decodeLiteral("plain"), "plain");
  assert.equal(decodeLiteral("a\\nb"), "a\nb");
  assert.equal(decodeLiteral("a\\tb"), "a\tb");
  assert.equal(decodeLiteral("\\(paren\\)"), "(paren)");
  assert.equal(decodeLiteral("back\\\\slash"), "back\\slash");
});

test("decodes octal escapes", () => {
  assert.equal(decodeLiteral("\\101\\102"), "AB");
  assert.equal(decodeLiteral("\\51"), ")");
});

test("literal strings may contain balanced parentheses", () => {
  assert.equal(decodeLiteral("a (nested) b"), "a (nested) b");
});

test("decodes hex strings", () => {
  assert.equal(decodeHex("48656C6C6F"), "Hello");
  assert.equal(decodeHex("48 65 6C"), "Hel");
  assert.equal(decodeHex(""), "");
});

/* ------------------------------------------------------------------
   ToUnicode
   ------------------------------------------------------------------ */

test("parses a bfchar CMap", () => {
  const map = parseCMap(`
    2 beginbfchar
    <0003> <0041>
    <0004> <0042>
    endbfchar`);
  assert.equal(map.get(3), "A");
  assert.equal(map.get(4), "B");
});

test("parses a bfrange CMap", () => {
  const map = parseCMap(`
    1 beginbfrange
    <0010> <0012> <0061>
    endbfrange`);
  assert.equal(map.get(0x10), "a");
  assert.equal(map.get(0x11), "b");
  assert.equal(map.get(0x12), "c");
});

test("an absurd bfrange is ignored rather than exhausting memory", () => {
  const map = parseCMap(`1 beginbfrange
    <0000> <FFFFFF> <0041>
    endbfrange`);
  assert.equal(map.size, 0);
});

test("CMaps merge into one table", () => {
  const map = new Map();
  parseCMap("1 beginbfchar <0003> <0041> endbfchar", map);
  parseCMap("1 beginbfchar <0009> <005A> endbfchar", map);
  assert.equal(map.get(3), "A");
  assert.equal(map.get(9), "Z");
});

/* ------------------------------------------------------------------
   Content stream operators
   ------------------------------------------------------------------ */

test("extracts positioned runs from Td and Tj", () => {
  const runs = extractRuns("BT 50 700 Td (Hello) Tj ET");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, "Hello");
  assert.equal(runs[0].x, 50);
  assert.equal(runs[0].y, 700);
});

test("Td offsets accumulate along a line", () => {
  const runs = extractRuns("BT 50 700 Td (A) Tj 100 0 Td (B) Tj ET");
  assert.deepEqual(runs.map(r => [r.x, r.y, r.text]), [[50,700,"A"], [150,700,"B"]]);
});

test("Tm sets the position absolutely", () => {
  const runs = extractRuns("BT 1 0 0 1 300 400 Tm (X) Tj ET");
  assert.equal(runs[0].x, 300);
  assert.equal(runs[0].y, 400);
});

test("T* moves down by the leading", () => {
  const runs = extractRuns("BT 20 TL 50 700 Td (A) Tj T* (B) Tj ET");
  assert.deepEqual(runs.map(r => [r.y, r.text]), [[700,"A"], [680,"B"]]);
});

test("TJ arrays join their pieces, wide kerns becoming spaces", () => {
  const runs = extractRuns("BT 50 700 Td [(Hel) 0 (lo) -400 (World)] TJ ET");
  assert.equal(runs[0].text, "Hello World");
});

test("hex show-strings are decoded", () => {
  const runs = extractRuns("BT 50 700 Td <48656C6C6F> Tj ET");
  assert.equal(runs[0].text, "Hello");
});

test("a ToUnicode map is applied to two-byte hex strings", () => {
  const cmap = parseCMap("1 beginbfchar <0003> <0048> endbfchar\n1 beginbfchar <0004> <0069> endbfchar");
  const runs = extractRuns("BT 50 700 Td <00030004> Tj ET", cmap);
  assert.equal(runs[0].text, "Hi");
});

test("text with no content is dropped, not emitted blank", () => {
  assert.equal(extractRuns("BT 50 700 Td (   ) Tj ET").length, 0);
});

/* ------------------------------------------------------------------
   Layout reconstruction
   ------------------------------------------------------------------ */

test("runs on one baseline become one row", () => {
  const rows = runsToRows([
    { x: 50, y: 700, text: "Fund" },
    { x: 250, y: 700, text: "Value" }
  ]);
  assert.deepEqual(rows, [["Fund", "Value"]]);
});

test("rows come back top of page first", () => {
  const rows = runsToRows([
    { x: 50, y: 600, text: "second" },
    { x: 50, y: 700, text: "first" }
  ]);
  assert.deepEqual(rows, [["first"], ["second"]]);
});

test("baselines a hair apart are still the same row", () => {
  const rows = runsToRows([
    { x: 50, y: 700, text: "A" },
    { x: 250, y: 701.5, text: "B" }
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], ["A", "B"]);
});

test("a wide horizontal gap starts a new cell", () => {
  const rows = runsToRows([
    { x: 50, y: 700, text: "HDFC" },
    { x: 400, y: 700, text: "250000" }
  ]);
  assert.deepEqual(rows[0], ["HDFC", "250000"]);
});

test("adjacent runs stay in one cell", () => {
  const rows = runsToRows([
    { x: 50, y: 700, text: "HDFC" },
    { x: 71, y: 700, text: "Flexi" }
  ]);
  assert.equal(rows[0].length, 1);
  assert.match(rows[0][0], /HDFC.*Flexi/);
});

test("no runs means no rows", () => {
  assert.deepEqual(runsToRows([]), []);
});

/* ------------------------------------------------------------------
   Whole documents
   ------------------------------------------------------------------ */

test("reads a table out of an uncompressed PDF", async () => {
  const rows = await extractPdfRows(pdfBytes([plain(TABLE)]));
  assert.deepEqual(rows[0], ["Fund", "Market Value"]);
  assert.deepEqual(rows[1], ["HDFC Flexi Cap", "250000"]);
  assert.deepEqual(rows[2], ["SBI Liquid Fund", "150000"]);
});

test("reads a table out of a FlateDecode PDF", async () => {
  const rows = await extractPdfRows(pdfBytes([flate(TABLE)]));
  assert.deepEqual(rows[0], ["Fund", "Market Value"]);
  assert.deepEqual(rows[1], ["HDFC Flexi Cap", "250000"]);
});

test("compressed and uncompressed give identical results", async () => {
  const a = await extractPdfRows(pdfBytes([plain(TABLE)]));
  const b = await extractPdfRows(pdfBytes([flate(TABLE)]));
  assert.deepEqual(a, b);
});

test("text output is tab separated per row", async () => {
  const text = await extractPdfText(pdfBytes([plain(TABLE)]));
  assert.match(text, /HDFC Flexi Cap\t250000/);
});

test("streams from several pages are all read", async () => {
  const page2 = `BT 50 700 Td (SGB 2032) Tj 200 0 Td (100000) Tj ET`;
  const rows = await extractPdfRows(pdfBytes([plain(TABLE), plain(page2)]));
  assert.ok(rows.some(r => r[0] === "SGB 2032"));
  assert.ok(rows.some(r => r[0] === "HDFC Flexi Cap"));
});

test("a ToUnicode stream in the file is used to decode the text", async () => {
  const cmapStream = `/CIDInit /ProcSet findresource begin
    1 beginbfchar <0003> <0048> endbfchar
    1 beginbfchar <0004> <0069> endbfchar
    end`;
  const body = `BT 50 700 Td <00030004> Tj ET`;
  const rows = await extractPdfRows(pdfBytes([plain(cmapStream), plain(body)]));
  assert.deepEqual(rows[0], ["Hi"]);
});

/* ------------------------------------------------------------------
   Failures are reported, never guessed at
   ------------------------------------------------------------------ */

test("a password-protected PDF says so, and names the usual culprit", async () => {
  const bytes = pdfBytes([plain(TABLE)], { trailer: "<< /Root 1 0 R /Encrypt 9 0 R >>" });
  await assert.rejects(() => extractPdfRows(bytes), /password-protected/i);
  await assert.rejects(() => extractPdfRows(bytes), /CAMS/);
});

test("a non-PDF is rejected outright", async () => {
  await assert.rejects(() => extractPdfRows(new Uint8Array([1,2,3,4,5,6])), /does not look like a PDF/i);
});

test("a PDF with no text stream explains that it may be scanned", async () => {
  const image = { dict: "<< /Length 4 /Filter /DCTDecode >>", data: Buffer.from("\xff\xd8\xff\xe0", "latin1") };
  await assert.rejects(() => extractPdfRows(pdfBytes([image])), /scanned/i);
});

test("a damaged compressed stream is skipped, not fatal, if others read", async () => {
  const broken = { dict: "<< /Length 8 /Filter /FlateDecode >>", data: Buffer.from("notzlib!", "latin1") };
  const rows = await extractPdfRows(pdfBytes([broken, plain(TABLE)]));
  assert.deepEqual(rows[0], ["Fund", "Market Value"]);
});
