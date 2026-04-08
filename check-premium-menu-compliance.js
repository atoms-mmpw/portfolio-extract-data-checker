#!/usr/bin/env node
/**
 * Premium menu compliance checker for Xplan portfolio extracts.
 *
 * Goal: For each "premium" portfolio on Sheet2, confirm every eligible holding ticker
 * appears in the correct allow-list (agnostic vs sustainable) from the rebalance template.
 *
 * ---------------------------------------------------------------------------
 * Phase 1 — Startup (main)
 * ---------------------------------------------------------------------------
 *  1. Input path: if argv[2] is set, use it (one .xlsx/.xlsm or a directory of them via
 *     listInputFiles). If omitted, use DEFAULT_EXTRACTS_ROOT: among immediate subdirectories
 *     named Run rebal extract template-YYYY-MM-DD-HHmmss, pick the newest by that embedded
 *     date/time and collect workbooks only from that folder (listWorkbooksFromDefaultExtractsRoot).
 *  2. loadMenus() — see Phase 2. On failure, print [FATAL] and exit 1.
 *  3. Log [INFO] with menu counts; printMenuTables() writes agnostic + sustainable tables
 *     to stdout, and the ex-gambling table if present (that third menu is never used in
 *     compliance logic — display only).
 *  4. Resolve workbook file list (see step 1). If none found, [FATAL] and exit 1.
 *  5. Evaluate each file in parallel via worker threads (concurrency from PREMIUM_MENU_WORKERS
 *     or CPU count); stderr progress while running; then printResult() in original file order.
 *  6. Write JSON snapshot under OFFENDING_OUTPUT_DIR: summary includes inspected_extracts_directory
 *     (folder containing the workbooks), runDate, generated_at; filename offending-portfolios-{runDate}.json
 *     uses the extract run folder date when derivable from Run rebal extract template-* (else today's local date).
 *     Prune snapshots older than 6 months. Print [SUMMARY] totals. Exit 1 if any file had a fatal
 *     error or any [FLAG] rows; exit 0 only when every file succeeded and no violations.
 *
 * ---------------------------------------------------------------------------
 * Phase 2 — Template menus (loadMenus, pickTemplateSheet, scanMenusOnSheet)
 * ---------------------------------------------------------------------------
 *  Source: fixed path TEMPLATE_PATH (.xlsm rebalance template — not the Xplan extract).
 *
 *  1. Open the template workbook.
 *  2. Choose a sheet: prefer name "Target", else try every sheet until one qualifies.
 *  3. On that sheet, scan column BO top-to-bottom for section title rows (trimmed string,
 *     exact equality — so "Industry Equal Weight" does not match the sustainability title).
 *     - "Industry Equal Weight" → agnostic menu; tickers in column BQ from the next row
 *       downward until BQ is blank (padding rows may have numbers in BO but empty BQ).
 *     - Sustainability: first matching BO text in HEADER_SUSTAINABLE_ALIASES (hyphen or
 *       em dash variants) → sustainable menu; same BQ-until-blank rule.
 *     - "Ex Gambling" section: same scan; tickers kept for printing only, not for checks.
 *  4. Validate: both agnostic and sustainable blocks must exist and each have at least
 *     MIN_MENU_TICKERS entries. Otherwise throw with a descriptive error.
 *  5. Build Set + ordered arrays for agnostic and sustainable (for fast lookup + console).
 *     Warn if ex-gambling header missing or empty; warn on duplicate tickers within a menu.
 *
 * ---------------------------------------------------------------------------
 * Phase 3 — Each Xplan extract (evaluateWorkbook)
 * ---------------------------------------------------------------------------
 *  1. Resolve Sheet2: exact name "Sheet2", else second sheet by index (fallback).
 *  2. Resolve Sheet1: must exist by name "Sheet1" (case-insensitive match). No "Target"
 *     sheet and no column BQ are used for extracts.
 *  3. Sheet2 row 1 = headers. resolveExtractColumns() maps titles (case-insensitive) to
 *     column indices: MMPW Model Portfolio, Direct Equities Model, Entity Name, External ID.
 *     Missing any title → fatal for this file.
 *  4. Sheet1 row 1 = headers. Same helper for Code, Entity ID, External ID, and Owner.
 *     Missing any title → fatal.
 *  5. buildHoldingsIndex(): walk Sheet1 from row 2 onward; for each row with External ID,
 *     read Code as a ticker: normalize, uppercase, skip if empty or length > 3 (treat as
 *     non–plain-equity / non-checkable). Also read Entity ID and Owner on that row. Append
 *     {ticker, owner, entityId} to a Map keyed by External ID (many rows per id allowed).
 *  6. Walk Sheet2 from row 2 onward. Skip rows where MMPW Model Portfolio is not "premium"
 *     (case-insensitive).
 *  7. For each premium row:
 *     - Direct Equities Model === "sustainable" (case-insensitive) → sustainable Set;
 *       anything else → agnostic Set.
 *     - Read External ID; if blank → warning, skip (not counted in checked).
 *     - Increment checked. Look up tickers for that External ID in the holdings Map.
 *     - If none eligible → warning, count as compliant (nothing to violate).
 *     - Else unique tickers; any not in the chosen Set → [FLAG] with portfolio name (col A),
 *       owner (Entity Name), row, externalId, menu type, offenders list.
 *     - All in set → compliant.
 *
 * ---------------------------------------------------------------------------
 * Phase 4 — Reporting (printResult, stderr vs stdout)
 * ---------------------------------------------------------------------------
 *  - Progress, [INFO], [WARN], [FLAG], [ERROR], [SUMMARY] go to stderr.
 *  - Menu tables (Phase 2) go to stdout so you can pipe or separate them if needed.
 *
 * Usage:
 *   node check-premium-menu-compliance.js
 *   node check-premium-menu-compliance.js [<extract.xlsx|folder>]
 *   npm run check-premium-menu -- [<extract.xlsx|folder>]
 *
 * With no args, workbooks are taken from the single newest Run rebal extract template-* folder
 * under DEFAULT_EXTRACTS_ROOT.
 *
 * Optional: PREMIUM_MENU_WORKERS=max concurrent worker threads (default 4, capped by CPU count).
 * Optional: PREMIUM_MENU_PROGRESS_EVERY=log every N completed workbooks (default scales with total).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import {
  loadMenus,
  menusToSerializable,
  printMenuTables,
  printResult,
} from "./premium-menu-compliance-core.js";

const WORKER_URL = new URL(
  "./premium-menu-compliance-worker.js",
  import.meta.url
);

/** When no CLI path is given: newest subdir matching RUN_EXTRACT_DIR_RE is used. */
const DEFAULT_EXTRACTS_ROOT =
  "/mnt/processes/portfolio-rebalance/extracts";
/** Group 1 = YYYY-MM-DD (filename + summary.runDate); group 2 = HHmmss. Sort key = `${g1}-${g2}`. */
const RUN_EXTRACT_DIR_RE =
  /^Run rebal extract template-(\d{4}-\d{2}-\d{2})-(\d{6})$/;

const OFFENDING_OUTPUT_DIR =
  "/mnt/data/portfolio-data/portfolios-with-off-menu-positions";
const OFFENDING_SNAPSHOT_BASENAME = "offending-portfolios";
const OFFENDING_SNAPSHOT_DATED_RE = new RegExp(
  `^${OFFENDING_SNAPSHOT_BASENAME}-(\\d{4}-\\d{2}-\\d{2})\\.json$`
);

/** YYYY-MM-DD in the machine's local timezone (matches cron "today"). */
function formatLocalYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Calendar "today minus 6 months", with day clamped to the target month's last day. */
function subtractSixCalendarMonths(d) {
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  let ty = y;
  let tm = m - 6;
  while (tm < 0) {
    tm += 12;
    ty -= 1;
  }
  const lastDay = new Date(ty, tm + 1, 0).getDate();
  const td = Math.min(day, lastDay);
  return new Date(ty, tm, td);
}

/**
 * Removes dated `offending-portfolios-YYYY-MM-DD.json` files strictly older than 6 calendar months.
 * Only names matching OFFENDING_SNAPSHOT_DATED_RE are considered. Prune errors are warnings only.
 */
async function pruneOldOffendingSnapshots(dir, today = new Date()) {
  const cutoffYmd = formatLocalYmd(subtractSixCalendarMonths(today));
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    console.error(
      `[WARN] Could not read directory for retention prune (${dir}): ${err.message}`
    );
    return;
  }
  let removed = 0;
  for (const name of names) {
    const match = name.match(OFFENDING_SNAPSHOT_DATED_RE);
    if (!match) continue;
    const fileYmd = match[1];
    if (fileYmd >= cutoffYmd) continue;
    try {
      await fs.unlink(path.join(dir, name));
      removed += 1;
    } catch (err) {
      console.error(
        `[WARN] Could not delete old snapshot "${name}": ${err.message}`
      );
    }
  }
  if (removed > 0) {
    console.error(
      `[INFO] Pruned ${removed} offending snapshot(s) older than 6 months under ${dir}`
    );
  }
}

function isWorkbookFile(name) {
  const lower = name.toLowerCase();
  return (
    !name.startsWith("~$") &&
    (lower.endsWith(".xlsx") || lower.endsWith(".xlsm"))
  );
}

async function listInputFiles(inputPath) {
  const resolved = path.resolve(inputPath);
  const stats = await fs.stat(resolved);
  if (stats.isFile()) return [resolved];
  if (!stats.isDirectory()) {
    throw new Error(`Input path is neither file nor directory: ${resolved}`);
  }
  const entries = await fs.readdir(resolved);
  return entries
    .filter(isWorkbookFile)
    .map((name) => path.join(resolved, name))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Stable order for JSON rows / UIs: Entity–portfolio label, Entity ID, External ID, then ticker.
 */
function sortOffendingRowsForSnapshot(rows) {
  const collator = new Intl.Collator(undefined, {
    sensitivity: "base",
    numeric: true,
  });
  const entityPortfolioKey = (r) =>
    (r.entityName || r.portfolioName || r.owner || "").trim();
  rows.sort((a, b) => {
    let c = collator.compare(entityPortfolioKey(a), entityPortfolioKey(b));
    if (c !== 0) return c;
    c = collator.compare(String(a.entityId ?? ""), String(b.entityId ?? ""));
    if (c !== 0) return c;
    c = collator.compare(String(a.externalId ?? ""), String(b.externalId ?? ""));
    if (c !== 0) return c;
    return collator.compare(String(a.offender ?? ""), String(b.offender ?? ""));
  });
}

function runFolderDateYmd(folderName) {
  const m = folderName.match(RUN_EXTRACT_DIR_RE);
  return m ? m[1] : null;
}

async function resolveSnapshotRunDateYmd({
  useDefaultExtracts,
  selectedRunFolder,
  explicitPath,
}) {
  if (useDefaultExtracts && selectedRunFolder) {
    const d = runFolderDateYmd(selectedRunFolder);
    if (d) return d;
  }
  if (!useDefaultExtracts && explicitPath) {
    const resolved = path.resolve(explicitPath);
    try {
      const stats = await fs.stat(resolved);
      let cur = stats.isFile() ? path.dirname(resolved) : resolved;
      const seen = new Set();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const d = runFolderDateYmd(path.basename(cur));
        if (d) return d;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    } catch {
      /* fall through to today */
    }
  }
  return formatLocalYmd(new Date());
}

/**
 * Among immediate subdirectories of root matching RUN_EXTRACT_DIR_RE, pick the newest by
 * date/time in the folder name; collect .xlsx/.xlsm from that folder only (non-recursive).
 */
async function listWorkbooksFromDefaultExtractsRoot(root) {
  const resolved = path.resolve(root);
  const stats = await fs.stat(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`Default extracts path is not a directory: ${resolved}`);
  }
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const candidates = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const m = ent.name.match(RUN_EXTRACT_DIR_RE);
    if (!m) continue;
    candidates.push({ name: ent.name, sortKey: `${m[1]}-${m[2]}` });
  }
  if (candidates.length === 0) {
    return {
      files: [],
      runFolderCount: 0,
      selectedRunFolder: null,
    };
  }
  candidates.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const newest = candidates[candidates.length - 1];
  const subDir = path.join(resolved, newest.name);
  const inner = await fs.readdir(subDir);
  const files = inner
    .filter(isWorkbookFile)
    .map((name) => path.join(subDir, name))
    .sort((a, b) => a.localeCompare(b));
  return {
    files,
    runFolderCount: candidates.length,
    selectedRunFolder: newest.name,
  };
}

function workerConcurrencyFor(fileCount) {
  const raw = process.env.PREMIUM_MENU_WORKERS;
  const parsed = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  const fromEnv =
    Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 4;
  const cpus = Math.max(1, os.cpus().length - 1);
  return Math.max(1, Math.min(fromEnv, cpus, fileCount));
}

function runEvaluateWorkerOnce(worker, filePath) {
  return new Promise((resolve, reject) => {
    const onMsg = (msg) => {
      worker.off("message", onMsg);
      worker.off("error", onErr);
      resolve(msg);
    };
    const onErr = (err) => {
      worker.off("message", onMsg);
      worker.off("error", onErr);
      reject(err);
    };
    worker.on("message", onMsg);
    worker.on("error", onErr);
    worker.postMessage({ type: "evaluate", filePath });
  });
}

/** Step between progress lines when PREMIUM_MENU_PROGRESS_EVERY is unset (~40 updates for large runs). */
function progressLogInterval(total) {
  const raw = process.env.PREMIUM_MENU_PROGRESS_EVERY;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  if (total <= 0) return 1;
  const step = Math.floor(total / 40);
  return Math.max(5, Math.min(250, step || 5));
}

async function processFilesWithWorkerPool(files, menusPayload, concurrency) {
  const total = files.length;
  const progressEvery = progressLogInterval(total);
  let completed = 0;

  function noteWorkbookDone() {
    completed += 1;
    const pct = Math.round((100 * completed) / total);
    const isFirst = completed === 1;
    const isLast = completed === total;
    const isMilestone =
      progressEvery > 0 &&
      completed % progressEvery === 0 &&
      !isLast;
    if (isFirst || isLast || isMilestone) {
      console.error(
        `[INFO] Progress: ${completed}/${total} workbooks (${pct}%)`
      );
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(
      new Worker(fileURLToPath(WORKER_URL), {
        workerData: { menusPayload },
      })
    );
  }
  try {
    const results = new Array(files.length);
    let next = 0;
    function getNextIndex() {
      const i = next;
      next += 1;
      return i < files.length ? i : null;
    }
    await Promise.all(
      workers.map((worker) =>
        (async () => {
          while (true) {
            const i = getNextIndex();
            if (i === null) break;
            const filePath = files[i];
            const msg = await runEvaluateWorkerOnce(worker, filePath);
            if (!msg.ok) {
              results[i] = {
                file: msg.filePath ?? filePath,
                fatal: `Failed to read workbook: ${msg.error}`,
                checked: 0,
                compliant: 0,
                flagged: [],
                warnings: [],
              };
            } else {
              results[i] = msg.result;
            }
            noteWorkbookDone();
          }
        })()
      )
    );
    return results;
  } finally {
    for (const w of workers) {
      try {
        w.postMessage({ type: "shutdown" });
      } catch {
        /* ignore */
      }
      await w.terminate().catch(() => {});
    }
  }
}

async function main() {
  const explicitPath = process.argv[2]?.trim();
  const useDefaultExtracts = !explicitPath;

  let menus;
  try {
    menus = await loadMenus();
  } catch (err) {
    console.error(`[FATAL] ${err.message}`);
    process.exit(1);
  }

  console.error(
    `[INFO] Loaded menus from template sheet "${menus.sourceSheet}" (agnostic=${menus.agnostic.size}, sustainable=${menus.sustainable.size}${menus.exGambling.size ? `, ex_gambling=${menus.exGambling.size}` : ""})`
  );
  printMenuTables(menus);

  let files;
  let selectedRunFolder = null;
  try {
    if (useDefaultExtracts) {
      const discovered = await listWorkbooksFromDefaultExtractsRoot(
        DEFAULT_EXTRACTS_ROOT
      );
      files = discovered.files;
      selectedRunFolder = discovered.selectedRunFolder;
      if (selectedRunFolder) {
        console.error(
          `[INFO] Default extracts root ${DEFAULT_EXTRACTS_ROOT}: using newest run folder "${selectedRunFolder}" (${discovered.runFolderCount} candidate(s)), ${files.length} workbook(s)`
        );
      } else {
        console.error(
          `[INFO] Default extracts root ${DEFAULT_EXTRACTS_ROOT}: no Run rebal extract template-* folders found`
        );
      }
    } else {
      files = await listInputFiles(explicitPath);
    }
  } catch (err) {
    console.error(`[FATAL] ${err.message}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error("[FATAL] No workbook files found to process.");
    process.exit(1);
  }

  const concurrency = workerConcurrencyFor(files.length);
  console.error(
    `[INFO] Processing ${files.length} workbook(s) with ${concurrency} worker thread(s)`
  );

  const menusPayload = menusToSerializable(menus);
  const results = await processFilesWithWorkerPool(
    files,
    menusPayload,
    concurrency
  );

  const aggregate = {
    files: 0,
    checked: 0,
    compliant: 0,
    flagged: 0,
    fatalFiles: 0,
  };

  const offendingRows = [];

  for (const result of results) {
    aggregate.files += 1;
    printResult(result);

    if (result.fatal) {
      aggregate.fatalFiles += 1;
      continue;
    }
    aggregate.checked += result.checked;
    aggregate.compliant += result.compliant;
    aggregate.flagged += result.flagged.length;

    for (const item of result.flagged) {
      for (const o of item.offenders) {
        offendingRows.push({
          filename: path.basename(result.file),
          mmpwModelPortfolio: item.premiumValue ?? "",
          directEquitiesModel: item.modelValue ?? "",
          menu: item.menuLabel ?? item.menuType ?? "",
          entityId: o.entityId ?? "",
          externalId: item.externalId ?? "",
          entityName: item.owner ?? "",
          portfolioName: item.portfolioName ?? "",
          owner: o.sheet1Owner ?? "",
          offender: o.ticker,
        });
      }
    }
  }

  sortOffendingRowsForSnapshot(offendingRows);

  const inspectedExtractsDirectory = path.dirname(path.resolve(files[0]));

  const generatedAt = new Date();
  const runDate = await resolveSnapshotRunDateYmd({
    useDefaultExtracts,
    selectedRunFolder,
    explicitPath: explicitPath || null,
  });
  const snapshot = {
    summary: {
      runDate,
      generated_at: generatedAt.toISOString(),
      inspected_extracts_directory: inspectedExtractsDirectory,
      files: aggregate.files,
      premium_portfolios_checked: aggregate.checked,
      compliant: aggregate.compliant,
      flagged: aggregate.flagged,
      fatal_files: aggregate.fatalFiles,
      offender_rows: offendingRows.length,
    },
    rows: offendingRows,
  };
  await fs.mkdir(OFFENDING_OUTPUT_DIR, { recursive: true });
  const outJsonPath = path.join(
    OFFENDING_OUTPUT_DIR,
    `${OFFENDING_SNAPSHOT_BASENAME}-${runDate}.json`
  );
  await fs.writeFile(outJsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.error(
    `[INFO] Wrote offending portfolios snapshot (${offendingRows.length} row(s)) to ${outJsonPath}`
  );
  await pruneOldOffendingSnapshots(OFFENDING_OUTPUT_DIR);

  console.error(
    `\n[SUMMARY]\n  inspected_extracts_directory: ${inspectedExtractsDirectory}\n  files: ${aggregate.files}\n  premium_portfolios_checked: ${aggregate.checked}\n  compliant: ${aggregate.compliant}\n  flagged: ${aggregate.flagged}\n  fatal_files: ${aggregate.fatalFiles}`
  );

  if (aggregate.fatalFiles > 0 || aggregate.flagged > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[FATAL] Unexpected error: ${err.message}`);
  process.exit(1);
});
