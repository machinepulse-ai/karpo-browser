/**
 * The value a native typed input takes (`<input type=date|time|…>`), read from what a task supplied. The browser's
 * own controls accept only their standard forms (2026-12-25, 19:45); typing into their segments depends on the
 * browser's locale. A value is converted only when its reading is unambiguous: 03/04/2026 could be either month
 * first, so it is not guessed.
 */

/** The input types whose value is set through the element, not typed. */
export const NATIVE_VALUE_TYPES = ["date", "time", "datetime-local", "month", "week", "number", "range"];

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
/** The months that have 30 days. */
const THIRTY_DAY_MONTHS = [4, 6, 9, 11];
/** The fewest letters a month's name is recognized by. */
const MONTH_MIN_LETTERS = 3;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function monthOf(word: string): number | undefined {
  const start = word.toLowerCase().replace(/\.$/, "");
  if (start.length < MONTH_MIN_LETTERS) return undefined;
  const index = MONTHS.findIndex((month) => month.startsWith(start));
  return index < 0 ? undefined : index + 1;
}

function leap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The date when it is a real one, in the standard form; a year below 100 is no year a task means. */
function realDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || year < 100) return undefined;
  const days = month === 2 ? (leap(year) ? 29 : 28) : THIRTY_DAY_MONTHS.includes(month) ? 30 : 31;
  if (day > days) return undefined;
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

function wordsOf(text: string): string[] {
  return text.split(/[\s,]+/).filter((word) => word !== "");
}

function dateValue(value: string): string | undefined {
  const text = value.trim();
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (iso) return realDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const written = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (written) {
    const [a, b, year] = [Number(written[1]), Number(written[2]), Number(written[3])];
    if (a === b) return realDate(year, a, b);
    if (a > 12 && b <= 12) return realDate(year, b, a);
    if (b > 12 && a <= 12) return realDate(year, a, b);
    return undefined;
  }
  // Words: a month name, a day and a four-digit year in any order; a weekday name is ignored.
  let month: number | undefined;
  let day: number | undefined;
  let year: number | undefined;
  for (const word of wordsOf(text)) {
    const clean = word.replace(/(st|nd|rd|th)$/i, "");
    if (/^\d{4}$/.test(clean) && year === undefined) year = Number(clean);
    else if (/^\d{1,2}$/.test(clean) && day === undefined) day = Number(clean);
    else if (monthOf(word) !== undefined && month === undefined) month = monthOf(word);
    else if (!/^(mon|tue|wed|thu|fri|sat|sun)/i.test(word)) return undefined;
  }
  return month === undefined || day === undefined || year === undefined ? undefined : realDate(year, month, day);
}

function timeValue(value: string): string | undefined {
  const found = /^(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2}))?\s*([ap])?\.?\s*(?:m\.?)?$/.exec(value.trim().toLowerCase());
  if (!found) return undefined;
  const [, hours, minutes, seconds, half] = found;
  if (minutes === undefined && !half) return undefined;
  let hour = Number(hours);
  const minute = minutes === undefined ? 0 : Number(minutes);
  const second = seconds === undefined ? undefined : Number(seconds);
  if (half) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (half === "p" ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || (second !== undefined && second > 59)) return undefined;
  return `${pad(hour)}:${pad(minute)}${second === undefined ? "" : `:${pad(second)}`}`;
}

function monthValue(value: string): string | undefined {
  const text = value.trim();
  const yearFirst = /^(\d{4})[-/.](\d{1,2})$/.exec(text);
  const monthFirst = /^(\d{1,2})[-/.](\d{4})$/.exec(text);
  const numbers = yearFirst
    ? [yearFirst[1]!, yearFirst[2]!]
    : monthFirst
      ? [monthFirst[2]!, monthFirst[1]!]
      : undefined;
  if (numbers) {
    const month = Number(numbers[1]);
    return month >= 1 && month <= 12 ? `${numbers[0]}-${pad(month)}` : undefined;
  }
  const words = wordsOf(text);
  if (words.length !== 2) return undefined;
  const [a, b] = [words[0]!, words[1]!];
  const month = monthOf(a) ?? monthOf(b);
  const year = /^\d{4}$/.test(b) ? b : /^\d{4}$/.test(a) ? a : undefined;
  return year === undefined || month === undefined ? undefined : `${year}-${pad(month)}`;
}

function dateTimeValue(value: string): string | undefined {
  const text = value.trim();
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)$/.exec(text);
  if (iso) {
    const real = dateValue(iso[1]!) !== undefined && timeValue(iso[2]!) !== undefined;
    return real ? `${iso[1]}T${iso[2]}` : undefined;
  }
  const found = /^(.*?)[\s,T@]+(?:at\s+)?(\d{1,2}(?:[:.]\d{2}){0,2}\s*(?:[ap]\.?\s*m?\.?)?)$/i.exec(text);
  const date = found ? dateValue(found[1]!) : undefined;
  const time = found ? timeValue(found[2]!) : undefined;
  return date === undefined || time === undefined ? undefined : `${date}T${time}`;
}

function numberValue(value: string): string | undefined {
  let text = value.trim();
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replaceAll(",", "");
  return /^-?\d+(\.\d+)?$/.test(text) ? text : undefined;
}

/** The standard value for a native input `type`; undefined when `text` cannot be read as one unambiguously. */
export function nativeValue(type: string, text: string): string | undefined {
  switch (type) {
    case "date":
      return dateValue(text);
    case "time":
      return timeValue(text);
    case "datetime-local":
      return dateTimeValue(text);
    case "month":
      return monthValue(text);
    case "week":
      return /^\d{4}-W\d{2}$/i.test(text.trim()) ? text.trim().toUpperCase() : undefined;
    case "number":
    case "range":
      return numberValue(text);
    default:
      return undefined;
  }
}

/** The first number in a text, thousands separators dropped ("1,250.5" → 1250.5); a minus sign before it counts. */
export function firstNumber(text: string): number | undefined {
  const found = /-?\d[\d,]*(?:\.\d+)?/.exec(text);
  const number = found ? Number(found[0].replaceAll(",", "")) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}
