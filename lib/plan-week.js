const PLAN_URL = 'https://raw.githubusercontent.com/adamneedelman/nycmarathonan/main/plan-full.json';
const EASTERN_TZ = 'America/New_York';

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// Parses a plan-full.json "date" field like "Jul 6" into an ISO YYYY-MM-DD
// string, using the given year (the plan doesn't span multiple years).
function toIsoDate(shortDate, year) {
  const [monthAbbr, day] = shortDate.split(' ');
  const month = MONTHS[monthAbbr];
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
}

// Converts an Eastern-time wall-clock date/time into its UTC epoch (ms),
// correctly accounting for EDT/EST regardless of the time of year.
function easternToUtcMs(isoDate, hour, minute, second) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(guessUtcMs)).map((p) => [p.type, p.value]));
  const asIfUtcMs = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    parts.hour === '24' ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second)
  );

  return guessUtcMs + (guessUtcMs - asIfUtcMs);
}

function todayIsoInEastern() {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: EASTERN_TZ }).format(new Date());
}

export async function fetchPlan() {
  const res = await fetch(PLAN_URL + '?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to fetch plan: HTTP ${res.status}`);
  }
  return res.json();
}

// Resolves the week whose actual calendar date range (per plan-full.json,
// not a fixed Monday-Sunday offset) contains today's date in Eastern time.
// Falls back to the first/last week if today is outside the whole plan.
export function resolveCurrentWeek(plan) {
  const year = Number(plan.meta.blockStart.slice(0, 4));
  const today = todayIsoInEastern();

  const weeks = plan.weeks.map((w) => ({
    week: w.week,
    totalMiles: w.totalMiles,
    startIso: toIsoDate(w.days[0].date, year),
    endIso: toIsoDate(w.days[w.days.length - 1].date, year),
  }));

  let match = weeks.find((w) => today >= w.startIso && today <= w.endIso);
  if (!match) {
    match = today < weeks[0].startIso ? weeks[0] : weeks[weeks.length - 1];
  }

  return {
    weekNumber: match.week,
    plannedMiles: match.totalMiles,
    startEpochMs: easternToUtcMs(match.startIso, 0, 0, 0),
    endEpochMs: easternToUtcMs(match.endIso, 23, 59, 59),
  };
}

// Resolves a specific week number's plan data by its real calendar dates
// (not a fixed Monday offset), for callers that need an arbitrary week
// rather than "today's" week.
export function getWeekByNumber(plan, weekNumber) {
  const year = Number(plan.meta.blockStart.slice(0, 4));
  const week = plan.weeks.find((w) => w.week === weekNumber);
  if (!week) return null;

  const days = week.days.map((d) => ({ ...d, dateIso: toIsoDate(d.date, year) }));
  const startIso = days[0].dateIso;
  const endIso = days[days.length - 1].dateIso;

  return {
    weekNumber: week.week,
    phase: week.phase,
    label: week.label,
    totalMiles: week.totalMiles,
    days,
    startIso,
    endIso,
    startEpochMs: easternToUtcMs(startIso, 0, 0, 0),
    endEpochMs: easternToUtcMs(endIso, 23, 59, 59),
  };
}

// Server-side sanity check (independent of the client's own 5pm-local badge
// logic): confirms week N's Sunday has reached 6pm US Eastern before a
// weekly review for that week may be generated.
export function isWeekReviewAvailableEastern(plan, weekNumber) {
  const wk = getWeekByNumber(plan, weekNumber);
  if (!wk) return false;
  const sundaySixPmMs = easternToUtcMs(wk.endIso, 18, 0, 0);
  return Date.now() >= sundaySixPmMs;
}
