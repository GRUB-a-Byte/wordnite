#!/usr/bin/env node
/**
 * Generates lib/words/answers.ts and lib/words/valid.ts from open word lists:
 *
 *  - SCOWL (Spell Checker Oriented Word Lists, http://wordlist.aspell.net/, Copyright 2000-2018
 *    Kevin Atkinson, permissive licence — see lib/words/LICENSE-SCOWL.txt)
 *  - ENABLE (Enhanced North American Benchmark LExicon, public domain — see lib/words/LICENSE-ENABLE.txt)
 *
 * (The Oxford English Dictionary is proprietary — there is no open/downloadable edition — so the
 * guess list instead merges the largest permissively licensed English lists.)
 *
 * Usage:
 *   1. Download scowl-2020.12.07.tar.gz from https://sourceforge.net/projects/wordlist/files/SCOWL/
 *      and extract it anywhere (outside this repo).
 *   2. Optionally download enable1.txt (e.g. https://github.com/dolph/dictionary).
 *   3. node scripts/build-words.mjs /path/to/scowl-2020.12.07/final [/path/to/enable1.txt]
 *
 * Answer list (secret words, SRS §8.7): common words only — SCOWL size <= 35 (English + American),
 * plurals / 3rd-person "-s" forms and simple "-ed" past tenses removed, blocklist removed.
 *
 * Valid-guess list ("every potential five-letter word"): EVERY SCOWL word list up to the largest
 * size (95, "very obscure") in every spelling variant (American, British, Canadian, Australian and
 * their variant lists), plus ENABLE, plus every answer. Proper nouns, abbreviations and
 * contractions are separate SCOWL lists and are not included.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const finalDir = process.argv[2];
const enablePath = process.argv[3];
if (!finalDir || !existsSync(finalDir)) {
  console.error('Usage: node scripts/build-words.mjs <path to SCOWL final/ directory> [path to enable1.txt]');
  process.exit(1);
}
if (enablePath && !existsSync(enablePath)) {
  console.error(`ENABLE list not found: ${enablePath}`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const blocklist = new Set(
  readFileSync(join(root, 'lib/words/blocklist.txt'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#')),
);

const FIVE = /^[a-z]{5}$/;

function readList(name) {
  const file = join(finalDir, name);
  if (!existsSync(file)) return [];
  // SCOWL lists are ISO-8859-1; latin1 decoding keeps ASCII words intact and we filter to a-z anyway.
  return readFileSync(file, 'latin1').split(/\r?\n/);
}

// ---- Answers (unchanged rules — keeps the secret-word pool stable) ------------------------------
const ANSWER_LEVELS = [10, 20, 35];
const ANSWER_SPELLINGS = ['english', 'american'];
// Inflection detection uses the same reference set as before (size <= 80, en/us/gb), so adding the
// huge obscure lists below cannot change which common words count as plurals / past tenses.
const REF_LEVELS = [10, 20, 35, 40, 50, 55, 60, 70, 80];
const REF_SPELLINGS = ['english', 'american', 'british'];

function collect(spellings, levels) {
  const out = new Set();
  for (const spelling of spellings) {
    for (const level of levels) {
      for (const w of readList(`${spelling}-words.${level}`)) if (FIVE.test(w)) out.add(w);
    }
  }
  return out;
}

const refWords = new Set();
for (const spelling of REF_SPELLINGS) {
  for (const level of REF_LEVELS) {
    for (const w of readList(`${spelling}-words.${level}`)) if (/^[a-z]+$/.test(w)) refWords.add(w);
  }
}

function isInflection(w) {
  if (w.endsWith('s') && !w.endsWith('ss')) {
    if (refWords.has(w.slice(0, -1))) return true; // cakes -> cake
    if (w.endsWith('es') && refWords.has(w.slice(0, -2))) return true; // boxes -> box
    if (w.endsWith('ies') && refWords.has(w.slice(0, -3) + 'y')) return true; // flies -> fly
  }
  if (w.endsWith('ed')) {
    if (refWords.has(w.slice(0, -1))) return true; // liked -> like
    if (refWords.has(w.slice(0, -2))) return true; // aimed -> aim
    if (w.endsWith('ied') && refWords.has(w.slice(0, -3) + 'y')) return true; // tried -> try
    if (w.length >= 5 && w[w.length - 3] === w[w.length - 4] && refWords.has(w.slice(0, -3))) return true; // begged-style
  }
  return false;
}

const answers = [...collect(ANSWER_SPELLINGS, ANSWER_LEVELS)]
  .filter((w) => !isInflection(w))
  .filter((w) => !blocklist.has(w))
  .sort();

// ---- Valid guesses: everything ------------------------------------------------------------------
const WORD_FILE = /-words\.(\d+)$/; // e.g. british_variant_1-words.95 (excludes -upper, -abbreviations, -contractions, -proper-names)
const valid = new Set();
const sources = { scowl: 0, enable: 0 };
for (const name of readdirSync(finalDir)) {
  const m = WORD_FILE.exec(name);
  if (!m || Number(m[1]) > 95) continue;
  for (const w of readList(name)) {
    if (FIVE.test(w) && !valid.has(w)) {
      valid.add(w);
      sources.scowl++;
    }
  }
}
if (enablePath) {
  for (const raw of readFileSync(enablePath, 'utf8').split(/\r?\n/)) {
    const w = raw.trim();
    if (FIVE.test(w) && !valid.has(w)) {
      valid.add(w);
      sources.enable++;
    }
  }
}
for (const a of answers) valid.add(a);
const validSorted = [...valid].sort();

function emit(file, constName, words, comment) {
  const body = words.map((w) => w.toUpperCase()).join('');
  const src =
    `// AUTO-GENERATED by scripts/build-words.mjs (see lib/words/LICENSE-SCOWL.txt, LICENSE-ENABLE.txt). Do not edit.\n` +
    `// ${comment}\n` +
    `// ${words.length} words, packed as one string of consecutive 5-letter upper-case words.\n` +
    `export const ${constName} = '${body}';\n`;
  writeFileSync(join(root, file), src);
}

emit('lib/words/answers.ts', 'PACKED_ANSWERS', answers, 'Secret-word answer list (SCOWL size <= 35, curated common words).');
emit(
  'lib/words/valid.ts',
  'PACKED_VALID',
  validSorted,
  `Valid-guess list: all SCOWL lists up to size 95, every spelling variant${enablePath ? ' + ENABLE' : ''} + answers.`,
);
console.log(
  `answers: ${answers.length}, valid guesses: ${validSorted.length} (SCOWL ${sources.scowl}${enablePath ? `, +${sources.enable} from ENABLE` : ''})`,
);
