#!/usr/bin/env node
/**
 * Scans a directory of .xlsx files and prints paths where the Entity ID parsed from
 * the filename (substring after the last "_" before ".xlsx") does not appear in any
 * cell of column I on the first worksheet. check-entity-ids.js portfolio-extract-data-checker
 *
 * Usage:
 *   node scripts/check-entity-ids.js [directory]
 *   npm run check-entity-ids -- [directory]
 *
 * Default directory (if omitted): ENTITY_LIST_DIR env or
 * /mnt/data/portfolio-data-extractor/Entity-List-Report-2024-03-24
 *
 * Stderr: per-file progress (PASS / FAIL / SKIP / ERROR), then a recap of failures.
 * Stdout: one file path per line for files that failed the column I check (for piping).
 */

import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";

const DEFAULT_DIR =
  "/mnt/data/portfolio-data-extractor/Entity-List-Report-2024-03-24";

const COL_I_INDEX = 8; // 0-based: column I

/** Lean parse: skip styles/HTML/formulas; faster than default full workbook parse. */
const READ_OPTS = {
  type: "buffer",
  cellDates: false,
  cellStyles: false,
  cellHTML: false,
  cellFormula: false,
  sheetStubs: false,
};

function resolveDir() {
  const fromEnv = process.env.ENTITY_LIST_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const arg = process.argv[2]?.trim();
  if (arg) return path.resolve(arg);
  return DEFAULT_DIR;
}

function parseEntityIdFromBasename(basenameNoExt) {
  const lastUnderscore = basenameNoExt.lastIndexOf("_");
  if (lastUnderscore === -1) return null;
  return basenameNoExt.slice(lastUnderscore + 1).trim() || null;
}

function normalizeCellValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Walk only column I (no sheet_to_json grid) and stop at first match.
 */
function entityIdInColumnI(sheet, entityId) {
  const ref = sheet["!ref"];
  if (!ref) return false;
  const range = XLSX.utils.decode_range(ref);
  const target = entityId.trim();
  for (let R = range.s.r; R <= range.e.r; R++) {
    const addr = XLSX.utils.encode_cell({ r: R, c: COL_I_INDEX });
    const cell = sheet[addr];
    if (!cell) continue;
    const v = cell.v;
    if (v === undefined || v === null || v === "") continue;
    if (normalizeCellValue(v) === target) return true;
  }
  return false;
}

function isXlsxFile(name) {
  if (!name.toLowerCase().endsWith(".xlsx")) return false;
  if (name.startsWith("~$")) return false;
  return true;
}

async function main() {
  const dir = resolveDir();
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    console.error(`check-entity-ids: cannot read directory: ${dir}`);
    console.error(err.message);
    process.exit(1);
  }

  const files = entries.filter(isXlsxFile).sort();
  const total = files.length;
  const failedPaths = [];
  const readErrorPaths = [];
  let skippedNoId = 0;

  for (let i = 0; i < files.length; i++) {
    const name = files[i];
    const filePath = path.join(dir, name);
    const n = i + 1;
    const base = path.basename(name, path.extname(name));
    const entityId = parseEntityIdFromBasename(base);

    if (entityId === null) {
      skippedNoId += 1;
      console.error(
        `[${n}/${total}] ${filePath}\n  SKIP (no "_" in filename — cannot parse Entity ID)`
      );
      continue;
    }

    let workbook;
    try {
      const buf = await fs.readFile(filePath);
      workbook = XLSX.read(buf, READ_OPTS);
    } catch (err) {
      readErrorPaths.push({ path: filePath, message: err.message });
      console.error(
        `[${n}/${total}] ${filePath}\n  ERROR (read failed): ${err.message}`
      );
      continue;
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      failedPaths.push(filePath);
      console.error(
        `[${n}/${total}] ${filePath}\n  FAIL (no worksheets — Entity ID "${entityId}" not in column I)`
      );
      continue;
    }

    const sheet = workbook.Sheets[sheetName];
    const ok = entityIdInColumnI(sheet, entityId);
    if (ok) {
      console.error(
        `[${n}/${total}] ${filePath}\n  PASS (Entity ID "${entityId}" found in column I)`
      );
    } else {
      failedPaths.push(filePath);
      console.error(
        `[${n}/${total}] ${filePath}\n  FAIL (Entity ID "${entityId}" not found in column I)`
      );
    }
  }

  console.error(
    "\n--- Failed: Entity ID not found in column I (first sheet) ---\n" +
      (failedPaths.length === 0
        ? "(none)"
        : `${failedPaths.length} file(s) — paths on stdout (one per line)`)
  );

  if (readErrorPaths.length > 0) {
    console.error("\n--- Read errors ---");
    for (const { path: p, message } of readErrorPaths) {
      console.error(`${p}: ${message}`);
    }
  }

  for (const p of failedPaths) {
    console.log(p);
  }

  console.error(
    `\ncheck-entity-ids: done — ${total} .xlsx file(s), ${failedPaths.length} failed column I check, ${skippedNoId} skipped (no ID in filename), ${readErrorPaths.length} read error(s)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});