'use strict';

// The inputs both geo build scripts read: HTTP with a cache on disk, IPv4
// arithmetic, and the DB-IP City Lite database.
//
// The DB-IP file is ~90 MB gzipped and ~700 MB as text, so it is only ever read
// as a stream. Its rows are `start,end,continent,country,stateProvName,city,
// lat,lon`, sorted by start and non-overlapping, covering the whole IPv4 space
// (reserved blocks carry country ZZ). IPv6 rows share the file and are skipped:
// their start field contains a colon.
//
// db-ip.com IP to City Lite database, CC BY 4.0 (https://db-ip.com).

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const stream = require('stream');
const streamPromises = require('stream/promises');
const zlib = require('zlib');

const DBIP_BASE = 'https://download.db-ip.com/free/dbip-city-lite-';
const FETCH_TIMEOUT_MS = 120000;
const DOWNLOAD_TIMEOUT_MS = 900000;

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function usable(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
}

async function cachedText(url, cacheDir, filename) {
  const filePath = path.join(cacheDir, filename);
  if (usable(filePath)) return fs.readFileSync(filePath, 'utf8');
  process.stderr.write(`downloading ${url}\n`);
  const text = await fetchText(url);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(filePath, text);
  return text;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function intToIpv4(value) {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

function monthStamp(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function previousMonthStamp(month) {
  const [year, index] = month.split('-').map(Number);
  return index === 1 ? `${year - 1}-12` : `${year}-${String(index - 1).padStart(2, '0')}`;
}

// Reads the first `count` comma-separated fields, honouring RFC 4180 quoting:
// place names carry commas and the quoted form is what the file uses for them.
function splitFields(line, count) {
  const fields = [];
  let cursor = 0;
  while (fields.length < count && cursor <= line.length) {
    if (line[cursor] === '"') {
      let value = '';
      cursor += 1;
      for (;;) {
        const quote = line.indexOf('"', cursor);
        if (quote === -1) { value += line.slice(cursor); cursor = line.length + 1; break; }
        if (line[quote + 1] === '"') { value += `${line.slice(cursor, quote)}"`; cursor = quote + 2; continue; }
        value += line.slice(cursor, quote);
        cursor = quote + 2; // past the closing quote and its comma
        break;
      }
      fields.push(value);
    } else {
      const comma = line.indexOf(',', cursor);
      if (comma === -1) { fields.push(line.slice(cursor)); cursor = line.length + 1; break; }
      fields.push(line.slice(cursor, comma));
      cursor = comma + 1;
    }
  }
  return fields;
}

async function downloadDbip(month, filePath) {
  const url = `${DBIP_BASE}${month}.csv.gz`;
  process.stderr.write(`downloading ${url}\n`);
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const partial = `${filePath}.partial`;
  await streamPromises.pipeline(stream.Readable.fromWeb(response.body), fs.createWriteStream(partial));
  fs.renameSync(partial, filePath);
}

// Resolves the database for the current month, downloading only when asked to and
// only when nothing usable is cached. An unstamped cache file is taken as the
// current month's copy: the free database carries no serial to check it against,
// so the build date is the best statement of vintage available.
async function resolveDbipCsv(cacheDir, { download = false, now = new Date() } = {}) {
  const month = monthStamp(now);
  const stamped = path.join(cacheDir, `dbip-city-lite-${month}.csv.gz`);
  if (usable(stamped)) return { file: stamped, month };

  const unstamped = path.join(cacheDir, 'dbip-city-lite.csv.gz');
  if (usable(unstamped)) {
    process.stderr.write(`using unstamped ${unstamped} as the ${month} database; rename it to dbip-city-lite-<month>.csv.gz to have a later month download\n`);
    return { file: unstamped, month };
  }

  if (!download) throw new Error(`no DB-IP database cached: expected ${stamped} or ${unstamped}`);

  fs.mkdirSync(cacheDir, { recursive: true });
  try {
    await downloadDbip(month, stamped);
    return { file: stamped, month };
  } catch (error) {
    // A month's file appears on the 1st; until it does, the previous month's is
    // the current database rather than a stale one.
    const fallbackMonth = previousMonthStamp(month);
    const fallback = path.join(cacheDir, `dbip-city-lite-${fallbackMonth}.csv.gz`);
    process.stderr.write(`${error.message}; falling back to ${fallbackMonth}\n`);
    if (!usable(fallback)) await downloadDbip(fallbackMonth, fallback);
    return { file: fallback, month: fallbackMonth };
  }
}

// Calls onRow(start, end, countryCode, stateProvName) for every IPv4 row, in file
// order. countryCode is null for ZZ and any other non-ISO placeholder;
// stateProvName is the raw name, empty when the row carries none.
async function streamDbipRows(file, onRow) {
  const lines = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  const stats = { rows: 0, malformed: 0, unsorted: 0 };
  let previousEnd = -1;
  for await (const line of lines) {
    if (!line) continue;
    const fields = splitFields(line, 5);
    if (fields.length < 5) { stats.malformed += 1; continue; }
    if (fields[0].includes(':')) continue; // IPv6
    const start = ipv4ToInt(fields[0]);
    const end = ipv4ToInt(fields[1]);
    if (start === null || end === null || end < start) { stats.malformed += 1; continue; }
    if (start <= previousEnd) { stats.unsorted += 1; continue; }
    previousEnd = end;
    stats.rows += 1;
    onRow(start, end, /^[A-Z]{2}$/.test(fields[3]) && fields[3] !== 'ZZ' ? fields[3] : null, fields[4]);
  }
  return stats;
}

module.exports = {
  fetchJson, cachedText, ipv4ToInt, intToIpv4, resolveDbipCsv, streamDbipRows,
};
