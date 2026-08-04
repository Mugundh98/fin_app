/* Number formatting shared by every planner — pure functions, no DOM.

   Indian grouping is implemented here rather than via toLocaleString("en-IN")
   so the output does not depend on which ICU data the runtime happens to
   ship, and so it can be tested in Node exactly as it renders in a browser. */

/* 1234567 -> "12,34,567". Last three digits, then twos. */
export function groupIndian(n){
  if(!Number.isFinite(n)) return "0";
  const negative = n < 0;
  const s = String(Math.round(Math.abs(n)));
  const body = s.length <= 3
    ? s
    : s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + s.slice(-3);
  return (negative ? "-" : "") + body;
}

/* Digits only, for reading a value back out of a comma-formatted field. */
export function digitsOnly(s){
  return String(s ?? "").replace(/[^\d]/g, "");
}

/* 1276000 -> "12 lakh 76 thousand".
   The point is to make a long string of zeroes readable at a glance, so it
   stops at the largest few units rather than spelling out every digit. */
export function amountInWords(n){
  if(!Number.isFinite(n)) return "";
  const negative = n < 0;
  let rest = Math.round(Math.abs(n));
  if(rest === 0) return "zero";

  const parts = [];
  const take = (unit, label) => {
    const count = Math.floor(rest / unit);
    if(count > 0){ parts.push(count + " " + label); rest -= count * unit; }
  };
  take(10000000, "crore");
  take(100000, "lakh");
  take(1000, "thousand");
  if(rest > 0) parts.push(String(rest));

  return (negative ? "minus " : "") + parts.join(" ");
}

/* Whole months between two dates, counting only complete months — a goal
   dated the 30th of next month is 0 months away on the 31st of this one.
   Parsed as UTC so a timezone offset cannot shift the day and lose a month. */
export function monthsBetween(start, end){
  const a = toUtcDate(start), b = toUtcDate(end);
  if(!a || !b) return 0;
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12
             + (b.getUTCMonth() - a.getUTCMonth());
  if(b.getUTCDate() < a.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

function toUtcDate(v){
  if(v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
  if(!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/* 40 -> "3 years 4 months". Used wherever a horizon is derived rather than
   typed, so the user can see what their dates actually came to. */
export function describeMonths(months){
  const m = Math.max(0, Math.round(months));
  const y = Math.floor(m / 12), rem = m % 12;
  const bits = [];
  if(y > 0) bits.push(y + (y === 1 ? " year" : " years"));
  if(rem > 0) bits.push(rem + (rem === 1 ? " month" : " months"));
  return bits.length ? bits.join(" ") : "0 months";
}
