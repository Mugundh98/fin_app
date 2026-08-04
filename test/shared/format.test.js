import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupIndian, digitsOnly, amountInWords, monthsBetween, describeMonths
} from "../../public/src/shared/format.js";

/* ------------------------------------------------------------------
   Indian grouping
   ------------------------------------------------------------------ */

test("groups in the Indian style: last three, then twos", () => {
  assert.equal(groupIndian(1000), "1,000");
  assert.equal(groupIndian(250000), "2,50,000");
  assert.equal(groupIndian(1276000), "12,76,000");
  assert.equal(groupIndian(10000000), "1,00,00,000");
  assert.equal(groupIndian(125000000), "12,50,00,000");
});

test("short numbers are left alone", () => {
  assert.equal(groupIndian(0), "0");
  assert.equal(groupIndian(7), "7");
  assert.equal(groupIndian(999), "999");
});

test("grouping handles negatives and rounds", () => {
  assert.equal(groupIndian(-250000), "-2,50,000");
  assert.equal(groupIndian(1234.6), "1,235");
});

test("grouping never returns NaN", () => {
  for(const v of [NaN, Infinity, undefined, null]){
    assert.equal(groupIndian(v), "0");
  }
});

test("digitsOnly strips grouping back out", () => {
  assert.equal(digitsOnly("12,76,000"), "1276000");
  assert.equal(digitsOnly("₹1,00,00,000"), "10000000");
  assert.equal(digitsOnly(""), "");
  assert.equal(digitsOnly("abc"), "");
});

test("grouping and digitsOnly round-trip", () => {
  for(const n of [0, 5, 999, 1000, 250000, 1276000, 10000000, 987654321]){
    assert.equal(Number(digitsOnly(groupIndian(n))), n);
  }
});

/* ------------------------------------------------------------------
   Words
   ------------------------------------------------------------------ */

test("spells amounts in crore, lakh and thousand", () => {
  assert.equal(amountInWords(10000000), "1 crore");
  assert.equal(amountInWords(12500000), "1 crore 25 lakh");
  assert.equal(amountInWords(1276000), "12 lakh 76 thousand");
  assert.equal(amountInWords(850000), "8 lakh 50 thousand");
  assert.equal(amountInWords(50000), "50 thousand");
});

test("the remainder below a thousand is spoken as a plain number", () => {
  assert.equal(amountInWords(1250), "1 thousand 250");
  assert.equal(amountInWords(999), "999");
  assert.equal(amountInWords(100001), "1 lakh 1");
});

test("units with a zero count are skipped, not spoken", () => {
  assert.equal(amountInWords(10000000 + 5000), "1 crore 5 thousand");
  assert.equal(amountInWords(2000000), "20 lakh");
});

test("zero and negatives read sensibly", () => {
  assert.equal(amountInWords(0), "zero");
  assert.equal(amountInWords(-250000), "minus 2 lakh 50 thousand");
});

test("words never return NaN", () => {
  for(const v of [NaN, Infinity, undefined, null]){
    assert.equal(amountInWords(v), "");
  }
});

/* ------------------------------------------------------------------
   Dates
   ------------------------------------------------------------------ */

test("counts whole months between two dates", () => {
  assert.equal(monthsBetween("2026-01-01", "2026-02-01"), 1);
  assert.equal(monthsBetween("2026-01-01", "2027-01-01"), 12);
  assert.equal(monthsBetween("2026-01-01", "2029-05-01"), 40);
});

test("a month is only counted once the day of month is reached", () => {
  assert.equal(monthsBetween("2026-01-15", "2026-02-14"), 0);
  assert.equal(monthsBetween("2026-01-15", "2026-02-15"), 1);
  assert.equal(monthsBetween("2026-01-15", "2026-02-16"), 1);
});

test("an end date on or before the start is zero, never negative", () => {
  assert.equal(monthsBetween("2026-06-01", "2026-06-01"), 0);
  assert.equal(monthsBetween("2026-06-01", "2025-06-01"), 0);
});

test("dates crossing a year boundary count correctly", () => {
  assert.equal(monthsBetween("2026-11-10", "2027-02-10"), 3);
  assert.equal(monthsBetween("2026-12-31", "2027-01-30"), 0);
});

test("unparseable dates give zero rather than NaN", () => {
  for(const v of ["", null, undefined, "not a date", "2026-13"]){
    assert.equal(monthsBetween(v, "2027-01-01"), 0);
    assert.equal(monthsBetween("2026-01-01", v), 0);
  }
});

test("Date objects work as well as ISO strings", () => {
  const a = new Date(Date.UTC(2026, 0, 1)), b = new Date(Date.UTC(2027, 0, 1));
  assert.equal(monthsBetween(a, b), 12);
});

test("parsing is timezone-proof — a date is a date, not an instant", () => {
  /* Parsed naively with local time, an IST offset would drag 2026-03-01 back
     into February and lose a month. */
  assert.equal(monthsBetween("2026-01-01", "2026-03-01"), 2);
  assert.equal(monthsBetween("2026-01-31", "2026-12-31"), 11);
});

/* ------------------------------------------------------------------
   Describing a horizon
   ------------------------------------------------------------------ */

test("describes months as years and months", () => {
  assert.equal(describeMonths(40), "3 years 4 months");
  assert.equal(describeMonths(12), "1 year");
  assert.equal(describeMonths(24), "2 years");
  assert.equal(describeMonths(8), "8 months");
  assert.equal(describeMonths(13), "1 year 1 month");
});

test("singular and plural are both right", () => {
  assert.equal(describeMonths(1), "1 month");
  assert.equal(describeMonths(2), "2 months");
  assert.equal(describeMonths(12), "1 year");
  assert.equal(describeMonths(25), "2 years 1 month");
});

test("zero months is stated rather than left blank", () => {
  assert.equal(describeMonths(0), "0 months");
});
