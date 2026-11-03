'use strict';

// unpaidallowances.json: how many unpaid app messages a node takes from one client and from one
// admitting operator, and the submitter ranges granted a client cap of their own. Mirrors the
// reader in FluxOS (ZelBack/src/services/utils/unpaidAllowances.js): a document this accepts and
// a node rejects leaves every node on its release defaults.

const {
  CLIENT_MAX_DAYS, DAY_MS, clientRangeProblem, isCalendarDate,
} = require('./blocklist');

const FIELDS = ['clientTagCap', 'originKeyCap', 'submitters'];
const SUBMITTER_FIELDS = ['value', 'cap', 'reason', 'added', 'expires'];

const isCap = (value) => Number.isInteger(value) && value > 0;

/**
 * Every problem with one submitter entry.
 * @param {unknown} entry
 * @param {number} index
 * @param {{clientTagCap: number, originKeyCap: number}} caps
 * @returns {string[]}
 */
function submitterProblems(entry, index, { clientTagCap, originKeyCap }) {
  const at = `submitter ${index}`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [`${at}: must be an object`];
  const problems = [];
  if (typeof entry.value !== 'string') {
    problems.push(`${at}: value must be a CIDR`);
  } else {
    const rangeProblem = clientRangeProblem(entry.value);
    if (rangeProblem) problems.push(`${at}: value must be ${rangeProblem}`);
  }
  if (!isCap(entry.cap) || entry.cap < clientTagCap || entry.cap > originKeyCap) {
    problems.push(`${at}: cap must be a whole number from clientTagCap (${clientTagCap}) to originKeyCap (${originKeyCap})`);
  }
  if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
    problems.push(`${at}: reason must say what the range submits`);
  }
  // As for a client ban: an address goes to another customer when its renter lets it go, so a
  // grant that outlives its submitter lands on whoever rents the address next.
  const today = new Date().toISOString().slice(0, 10);
  if (!isCalendarDate(entry.added)) problems.push(`${at}: added must be a YYYY-MM-DD calendar date`);
  else if (entry.added > today) problems.push(`${at}: added ${entry.added} is after today, ${today}`);
  if (!isCalendarDate(entry.expires)) {
    problems.push(`${at}: expires must be a YYYY-MM-DD calendar date — a grant always ends`);
  } else if (isCalendarDate(entry.added)) {
    const days = (Date.parse(entry.expires) - Date.parse(entry.added)) / DAY_MS;
    if (!(days > 0)) problems.push(`${at}: expires must be after added`);
    else if (days > CLIENT_MAX_DAYS) problems.push(`${at}: expires is ${days} days after added — at most ${CLIENT_MAX_DAYS}`);
  }
  const extra = Object.keys(entry).filter((key) => !SUBMITTER_FIELDS.includes(key));
  if (extra.length) problems.push(`${at}: unexpected field(s) ${extra.join(', ')}`);
  return problems;
}

/**
 * Every problem with the document.
 * @param {unknown} parsed The parsed unpaidallowances.json
 * @returns {string[]}
 */
function documentProblems(parsed) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return ['must be an object of clientTagCap, originKeyCap and submitters'];
  }
  const problems = [];
  const { clientTagCap, originKeyCap, submitters } = parsed;
  if (!isCap(clientTagCap)) problems.push('clientTagCap must be a positive whole number');
  if (!isCap(originKeyCap)) problems.push('originKeyCap must be a positive whole number');
  if (isCap(clientTagCap) && isCap(originKeyCap) && clientTagCap > originKeyCap) {
    problems.push('clientTagCap must not be above originKeyCap: every client is admitted through some operator');
  }
  const extra = Object.keys(parsed).filter((key) => !FIELDS.includes(key));
  if (extra.length) problems.push(`unexpected field(s) ${extra.join(', ')}`);
  if (!Array.isArray(submitters)) {
    problems.push('submitters must be an array, empty when no range is granted a cap');
    return problems;
  }
  if (problems.length) return problems;
  submitters.forEach((entry, index) => problems.push(...submitterProblems(entry, index, parsed)));
  const seen = new Map();
  submitters.forEach((entry, index) => {
    if (typeof entry?.value !== 'string') return;
    if (seen.has(entry.value)) problems.push(`submitter ${index}: duplicate of submitter ${seen.get(entry.value)} — ${entry.value}`);
    else seen.set(entry.value, index);
  });
  return problems;
}

module.exports = { documentProblems };
