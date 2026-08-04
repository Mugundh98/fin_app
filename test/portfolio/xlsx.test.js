import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import {
  findZipEntries, readZipEntry, decodeXml, colRefToIndex,
  parseSharedStrings, parseSheet, parseCsv, readXlsx, readSpreadsheet
} from "../../public/src/shared/xlsx.js";

/* ------------------------------------------------------------------
   A real ZIP writer, so the reader is tested against actual bytes
   rather than a mock. Supports stored and deflated members, which are
   the only two methods a workbook ever uses.
   ------------------------------------------------------------------ */
function buildZip(files){
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;

  for(const f of files){
    const nameBytes = enc.encode(f.name);
    const content = enc.encode(f.data);
    const method = f.deflate ? 8 : 0;
    const body = f.deflate ? new Uint8Array(deflateRawSync(Buffer.from(content))) : content;

    const local = new Uint8Array(30 + nameBytes.length + body.length);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(8, method, true);
    ldv.setUint32(18, body.length, true);
    ldv.setUint32(22, content.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(body, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(10, method, true);
    cdv.setUint32(20, body.length, true);
    cdv.setUint32(24, content.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, offset, true);

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for(const l of locals){ out.set(l, p); p += l.length; }
  for(const c of centrals){ out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

/* A minimal but structurally genuine workbook. */
function buildWorkbook({ deflate = false, sheetName = "Holdings" } = {}){
  const shared = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="8" uniqueCount="8">
<si><t>Name</t></si><si><t>Value</t></si><si><t>Class</t></si>
<si><t>HDFC Flexi Cap</t></si><si><t>Equity</t></si>
<si><t>SBI Liquid</t></si><si><t>Debt</t></si>
<si><t>Sovereign Gold Bond &amp; co</t></si>
</sst>`;

  const sheet = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>250000</v></c><c r="C2" t="s"><v>4</v></c></row>
<row r="3"><c r="A3" t="s"><v>5</v></c><c r="B3"><v>150000</v></c><c r="C3" t="s"><v>6</v></c></row>
<row r="4"><c r="A4" t="s"><v>7</v></c><c r="B4"><v>100000</v></c></row>
<row r="5"><c r="A5" t="inlineStr"><is><t>Inline Cash</t></is></c><c r="B5"><v>50000</v></c><c r="C5" t="inlineStr"><is><t>Debt</t></is></c></row>
</sheetData></worksheet>`;

  const workbook = `<?xml version="1.0"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const rels = `<?xml version="1.0"?>
<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

  return buildZip([
    { name: "[Content_Types].xml", data: "<Types/>", deflate },
    { name: "xl/workbook.xml", data: workbook, deflate },
    { name: "xl/_rels/workbook.xml.rels", data: rels, deflate },
    { name: "xl/sharedStrings.xml", data: shared, deflate },
    { name: "xl/worksheets/sheet1.xml", data: sheet, deflate }
  ]);
}

/* ------------------------------------------------------------------
   ZIP
   ------------------------------------------------------------------ */

test("reads the central directory of a stored-method zip", () => {
  const zip = buildZip([{ name: "a.txt", data: "hello" }, { name: "b/c.xml", data: "<x/>" }]);
  const entries = findZipEntries(zip);
  assert.deepEqual([...entries.keys()], ["a.txt", "b/c.xml"]);
  assert.equal(entries.get("a.txt").method, 0);
});

test("reads a stored member back byte for byte", async () => {
  const zip = buildZip([{ name: "a.txt", data: "hello world" }]);
  const out = await readZipEntry(zip, findZipEntries(zip).get("a.txt"));
  assert.equal(new TextDecoder().decode(out), "hello world");
});

test("inflates a deflated member", async () => {
  const body = "compress me ".repeat(200);
  const zip = buildZip([{ name: "big.txt", data: body, deflate: true }]);
  const entries = findZipEntries(zip);
  assert.equal(entries.get("big.txt").method, 8);
  assert.ok(entries.get("big.txt").compressedSize < body.length);
  const out = await readZipEntry(zip, entries.get("big.txt"));
  assert.equal(new TextDecoder().decode(out), body);
});

test("rejects bytes that are not a zip at all", () => {
  assert.throws(() => findZipEntries(new Uint8Array(200)), /does not look like an \.xlsx/i);
});

/* ------------------------------------------------------------------
   XML
   ------------------------------------------------------------------ */

test("decodes xml entities including numeric ones", () => {
  assert.equal(decodeXml("a &amp; b"), "a & b");
  assert.equal(decodeXml("&lt;tag&gt;"), "<tag>");
  assert.equal(decodeXml("&quot;q&quot; &apos;a&apos;"), `"q" 'a'`);
  assert.equal(decodeXml("&#8377;100"), "₹100");
  assert.equal(decodeXml("&#x20B9;100"), "₹100");
  assert.equal(decodeXml("plain"), "plain");
});

test("converts column references to indices", () => {
  assert.equal(colRefToIndex("A1"), 0);
  assert.equal(colRefToIndex("B2"), 1);
  assert.equal(colRefToIndex("Z9"), 25);
  assert.equal(colRefToIndex("AA1"), 26);
  assert.equal(colRefToIndex("AB1"), 27);
  assert.equal(colRefToIndex("BA10"), 52);
  assert.equal(colRefToIndex(""), -1);
});

test("shared strings handle rich-text runs and entities", () => {
  const xml = `<sst><si><t>Plain</t></si>
    <si><r><t>Rich </t></r><r><t>Text</t></r></si>
    <si><t>A &amp; B</t></si></sst>`;
  assert.deepEqual(parseSharedStrings(xml), ["Plain", "Rich Text", "A & B"]);
});

test("sheet parsing honours cell references, leaving gaps empty", () => {
  const xml = `<sheetData><row r="1">
    <c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row></sheetData>`;
  const rows = parseSheet(xml, ["first"]);
  assert.deepEqual(rows[0], ["first", "", 42]);
});

test("sheet parsing places rows by their declared number", () => {
  const xml = `<sheetData><row r="3"><c r="A3"><v>9</v></c></row></sheetData>`;
  const rows = parseSheet(xml, []);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], []);
  assert.deepEqual(rows[2], [9]);
});

test("sheet parsing reads inline strings and self-closing cells", () => {
  const xml = `<sheetData><row r="1">
    <c r="A1" t="inlineStr"><is><t>Hi</t></is></c><c r="B1"/></row></sheetData>`;
  assert.deepEqual(parseSheet(xml, [])[0], ["Hi", ""]);
});

test("numeric cells come back as numbers, text as strings", () => {
  const xml = `<sheetData><row r="1">
    <c r="A1"><v>1234.5</v></c><c r="B1" t="str"><v>=A1</v></c></row></sheetData>`;
  const [row] = parseSheet(xml, []);
  assert.equal(typeof row[0], "number");
  assert.equal(row[0], 1234.5);
  assert.equal(row[1], "=A1");
});

/* ------------------------------------------------------------------
   Whole workbook
   ------------------------------------------------------------------ */

for(const deflate of [false, true]){
  test(`reads a whole workbook (${deflate ? "deflated" : "stored"})`, async () => {
    const { rows, sheetName } = await readXlsx(buildWorkbook({ deflate }));
    assert.equal(sheetName, "Holdings");
    assert.deepEqual(rows[0], ["Name", "Value", "Class"]);
    assert.deepEqual(rows[1], ["HDFC Flexi Cap", 250000, "Equity"]);
    assert.deepEqual(rows[2], ["SBI Liquid", 150000, "Debt"]);
    assert.deepEqual(rows[3], ["Sovereign Gold Bond & co", 100000]);
    assert.deepEqual(rows[4], ["Inline Cash", 50000, "Debt"]);
  });
}

test("resolves the worksheet through workbook rels, not by filename", async () => {
  const { path } = await readXlsx(buildWorkbook());
  assert.equal(path, "xl/worksheets/sheet1.xml");
});

test("readSpreadsheet detects xlsx from its magic bytes", async () => {
  const res = await readSpreadsheet(buildWorkbook({ deflate: true }), "anything.dat");
  assert.equal(res.kind, "xlsx");
  assert.equal(res.rows[1][0], "HDFC Flexi Cap");
});

test("readSpreadsheet rejects the old binary .xls format clearly", async () => {
  const ole = new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0]);
  await assert.rejects(() => readSpreadsheet(ole, "old.xls"), /old \.xls file/i);
});

/* ------------------------------------------------------------------
   CSV
   ------------------------------------------------------------------ */

test("parses plain csv", () => {
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a","b"],["1","2"]]);
});

test("csv honours quotes, embedded commas, newlines and escaped quotes", () => {
  const rows = parseCsv(`Name,Value\n"Kotak, Gold ETF",50000\n"He said ""hi""",10\n"two\nlines",5`);
  assert.deepEqual(rows[1], ["Kotak, Gold ETF", "50000"]);
  assert.deepEqual(rows[2], [`He said "hi"`, "10"]);
  assert.deepEqual(rows[3], ["two\nlines", "5"]);
});

test("csv survives CRLF line endings", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a","b"],["1","2"]]);
});

test("csv strips a leading byte order mark", () => {
  const rows = parseCsv("﻿Name,Value\nX,1");
  assert.equal(rows[0][0], "Name");
});

test("csv auto-detects tab and semicolon delimiters", () => {
  assert.deepEqual(parseCsv("a\tb\n1\t2"), [["a","b"],["1","2"]]);
  assert.deepEqual(parseCsv("a;b\n1;2"), [["a","b"],["1","2"]]);
});

test("a trailing newline does not invent an empty row", () => {
  assert.equal(parseCsv("a,b\n1,2\n").length, 2);
});
