import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";

const TEMPLATE_PATH =
  "./templates/260223 Portfolio Rebalance - Template (New Debt Investments Model).xlsm";

const SHEET_2_NAME = "Sheet2";
const SHEET_1_NAME = "Sheet1";
/** Template workbook: prefer this sheet when loading menus (extracts use Sheet1 only). */
const TARGET_SHEET_NAME = "Target";

const EXTRACT_HEADER_ROW_1BASED = 1;

/** Sheet2 column titles on row 1 (keys are internal ids). */
const EXTRACT_SHEET2_TITLES = {
  premium: "MMPW Model Portfolio",
  model: "Direct Equities Model",
  owner: "Entity Name",
  externalId: "External ID",
};

/** Sheet1 holdings column titles on row 1. */
const EXTRACT_SHEET1_TITLES = {
  code: "Code",
  entityId: "Entity ID",
  externalId: "External ID",
  /** Column H — owner of the holding row (distinct from Sheet2 Entity Name). */
  sheet1Owner: "Owner",
};

const COL_BO = XLSX.utils.decode_col("BO");
const COL_BQ = XLSX.utils.decode_col("BQ");

/** Exact BO header for the agnostic (30-style) menu — must not substring-match sustainability. */
const HEADER_AGNOSTIC = "Industry Equal Weight";

/** Any of these BO values (after trim) identify the sustainable table. */
const HEADER_SUSTAINABLE_ALIASES = [
  "Industry Equal Weight - Sustainability",
  "Industry Equal Weight — Sustainability",
];

/** Optional section; loaded for console display only. */
const HEADER_EX_GAMBLING_ALIASES = [
  "Industry Equal Weight - ex Gambling",
  "Industry Equal Weight — ex Gambling",
];

const MIN_MENU_TICKERS = 20;

/**
 * Tickers that should be ignored for compliance checks even if they are holdings
 * and not present in the valid menu.
 */
const WHITELISTED_TICKERS = new Set(["MVE", "VIF"]);

export const READ_OPTS = {
  type: "buffer",
  cellDates: false,
  cellStyles: false,
  cellHTML: false,
  cellFormula: false,
  sheetStubs: false,
};

function normalizeValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeTicker(value) {
  return normalizeValue(value).toUpperCase();
}

function cellValue(sheet, row1Based, col0Based) {
  const addr = XLSX.utils.encode_cell({ r: row1Based - 1, c: col0Based });
  return sheet[addr]?.v;
}

/**
 * Map row-1 header titles to 0-based column indices (case-insensitive after trim).
 * @param {Record<string, string>} keyToTitle
 * @returns {{ ok: true, cols: Record<string, number> } | { ok: false, missing: string[] }}
 */
function resolveExtractColumns(sheet, headerRow1Based, keyToTitle) {
  const ref = sheet["!ref"];
  if (!ref) {
    return { ok: false, missing: ["(sheet has no used range)"] };
  }
  const range = XLSX.utils.decode_range(ref);
  const headerR0 = headerRow1Based - 1;
  if (headerR0 < range.s.r || headerR0 > range.e.r) {
    return {
      ok: false,
      missing: [`(header row ${headerRow1Based} outside sheet range)`],
    };
  }

  const titleNormToKey = new Map();
  for (const [key, title] of Object.entries(keyToTitle)) {
    titleNormToKey.set(normalizeValue(title).toLowerCase(), key);
  }

  const cols = {};
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cellKey = normalizeValue(
      cellValue(sheet, headerRow1Based, c)
    ).toLowerCase();
    if (!cellKey) continue;
    const logicalKey = titleNormToKey.get(cellKey);
    if (logicalKey !== undefined && cols[logicalKey] === undefined) {
      cols[logicalKey] = c;
    }
  }

  const missing = [];
  for (const [key, title] of Object.entries(keyToTitle)) {
    if (cols[key] === undefined) {
      missing.push(title);
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, cols };
}

/**
 * Holdings rows start at firstDataRow0Based (row 2 => 1). Tickers from Code;
 * each row also carries Sheet1 Entity ID and Owner when present.
 */
function buildHoldingsIndex(sheet, cols, firstDataRow0Based) {
  const index = new Map();
  const ref = sheet["!ref"];
  if (!ref) return index;
  const range = XLSX.utils.decode_range(ref);
  const cExt = cols.externalId;
  const cCode = cols.code;
  const cEntity = cols.entityId;
  const cOwner = cols.sheet1Owner;
  for (let r = firstDataRow0Based; r <= range.e.r; r++) {
    const externalId = normalizeValue(
      sheet[XLSX.utils.encode_cell({ r, c: cExt })]?.v
    );
    if (!externalId) continue;
    const ticker = normalizeTicker(
      sheet[XLSX.utils.encode_cell({ r, c: cCode })]?.v
    );
    if (!ticker || ticker.length > 3) continue;
    const entityId = normalizeValue(
      sheet[XLSX.utils.encode_cell({ r, c: cEntity })]?.v
    );
    const owner = normalizeValue(
      sheet[XLSX.utils.encode_cell({ r, c: cOwner })]?.v
    );
    if (!index.has(externalId)) index.set(externalId, []);
    index.get(externalId).push({ ticker, owner, entityId });
  }
  return index;
}

function getSheetRowRange1Based(sheet) {
  const ref = sheet["!ref"];
  if (!ref) return null;
  const d = XLSX.utils.decode_range(ref);
  return { min: d.s.r + 1, max: d.e.r + 1 };
}

/** Tickers from row start while BQ is non-empty (stops at padded rows with blank BQ). */
function collectTickerBlockFromBq(sheet, startRow1Based, rowMax1Based) {
  const tickers = [];
  for (let r = startRow1Based; r <= rowMax1Based; r++) {
    const ticker = normalizeTicker(cellValue(sheet, r, COL_BQ));
    if (!ticker) break;
    tickers.push(ticker);
  }
  return tickers;
}

/**
 * Scan BO for known headers; read each table until blank BQ.
 * @returns {{ bounds: {min:number,max:number}|null, rows: {agnostic:number|null, sustainable:number|null, exGambling:number|null}, agnostic: string[], sustainable: string[], exGambling: string[], sustainableHeaderLabel: string|null, exGamblingHeaderLabel: string|null }}
 */
function scanMenusOnSheet(sheet) {
  const bounds = getSheetRowRange1Based(sheet);
  const empty = {
    bounds,
    rows: { agnostic: null, sustainable: null, exGambling: null },
    agnostic: [],
    sustainable: [],
    exGambling: [],
    sustainableHeaderLabel: null,
    exGamblingHeaderLabel: null,
  };
  if (!bounds) return empty;

  const boText = (r) => normalizeValue(cellValue(sheet, r, COL_BO));

  for (let r = bounds.min; r <= bounds.max; r++) {
    const bo = boText(r);
    if (bo === HEADER_AGNOSTIC && empty.rows.agnostic === null) {
      empty.rows.agnostic = r;
    }
    if (empty.rows.sustainable === null) {
      const hit = HEADER_SUSTAINABLE_ALIASES.find((a) => bo === a);
      if (hit) {
        empty.rows.sustainable = r;
        empty.sustainableHeaderLabel = hit;
      }
    }
    if (empty.rows.exGambling === null) {
      const hitG = HEADER_EX_GAMBLING_ALIASES.find((a) => bo === a);
      if (hitG) {
        empty.rows.exGambling = r;
        empty.exGamblingHeaderLabel = hitG;
      }
    }
  }

  if (empty.rows.agnostic != null) {
    empty.agnostic = collectTickerBlockFromBq(
      sheet,
      empty.rows.agnostic + 1,
      bounds.max
    );
  }
  if (empty.rows.sustainable != null) {
    empty.sustainable = collectTickerBlockFromBq(
      sheet,
      empty.rows.sustainable + 1,
      bounds.max
    );
  }
  if (empty.rows.exGambling != null) {
    empty.exGambling = collectTickerBlockFromBq(
      sheet,
      empty.rows.exGambling + 1,
      bounds.max
    );
  }

  return empty;
}

function isMenuScanValid(scan) {
  return (
    scan.bounds != null &&
    scan.rows.agnostic != null &&
    scan.rows.sustainable != null &&
    scan.agnostic.length >= MIN_MENU_TICKERS &&
    scan.sustainable.length >= MIN_MENU_TICKERS
  );
}

function describeMenuScanFailure(scan) {
  const parts = [];
  if (!scan.bounds) parts.push("sheet has no used range (!ref)");
  if (scan.rows.agnostic == null) {
    parts.push(`missing BO header "${HEADER_AGNOSTIC}"`);
  } else if (scan.agnostic.length < MIN_MENU_TICKERS) {
    parts.push(
      `agnostic menu: ${scan.agnostic.length} tickers (need >= ${MIN_MENU_TICKERS})`
    );
  }
  if (scan.rows.sustainable == null) {
    parts.push(
      `missing sustainable BO header (try one of: ${HEADER_SUSTAINABLE_ALIASES.join(" | ")})`
    );
  } else if (scan.sustainable.length < MIN_MENU_TICKERS) {
    parts.push(
      `sustainable menu: ${scan.sustainable.length} tickers (need >= ${MIN_MENU_TICKERS})`
    );
  }
  return parts.join("; ");
}

function pickTemplateSheet(workbook) {
  const targetName = findSheetByName(workbook, TARGET_SHEET_NAME);
  const names = targetName
    ? [targetName, ...workbook.SheetNames.filter((n) => n !== targetName)]
    : [...workbook.SheetNames];

  for (const name of names) {
    const sheet = workbook.Sheets[name];
    const scan = scanMenusOnSheet(sheet);
    if (isMenuScanValid(scan)) {
      return { sheetName: name, sheet, scan };
    }
  }
  return null;
}

export async function loadMenus() {
  const resolvedTemplate = path.resolve(TEMPLATE_PATH);
  let workbook;
  try {
    const buf = await fs.readFile(resolvedTemplate);
    workbook = XLSX.read(buf, READ_OPTS);
  } catch (err) {
    throw new Error(
      `Failed to read template "${resolvedTemplate}": ${err.message}`
    );
  }

  const picked = pickTemplateSheet(workbook);
  if (!picked) {
    const targetName = findSheetByName(workbook, TARGET_SHEET_NAME);
    const probeName = targetName ?? workbook.SheetNames[0];
    const probeSheet = probeName ? workbook.Sheets[probeName] : null;
    const scan = probeSheet ? scanMenusOnSheet(probeSheet) : null;
    const detail = scan
      ? describeMenuScanFailure(scan)
      : "no workbook sheets";
    throw new Error(
      `Could not load agnostic and sustainable menus from template (${detail}). Tried sheet "${probeName ?? "n/a"}".`
    );
  }

  const { scan, sheetName } = picked;

  if (scan.rows.exGambling == null) {
    console.error(
      '[WARN] Template: BO header "Industry Equal Weight - ex Gambling" (or em-dash variant) not found; skipping ex Gambling menu display.'
    );
  } else if (scan.exGambling.length === 0) {
    console.error(
      "[WARN] Template: ex Gambling header found but no tickers before blank BQ."
    );
  }

  const agnostic = new Set(scan.agnostic);
  const sustainable = new Set(scan.sustainable);
  const exGambling = new Set(scan.exGambling);

  const agnosticOrder = [...scan.agnostic];
  const sustainableOrder = [...scan.sustainable];
  const exGamblingOrder = [...scan.exGambling];

  if (agnostic.size < scan.agnostic.length) {
    console.error(
      `[WARN] Agnostic menu contains duplicate tickers (${scan.agnostic.length} rows, ${agnostic.size} unique).`
    );
  }
  if (sustainable.size < scan.sustainable.length) {
    console.error(
      `[WARN] Sustainable menu contains duplicate tickers (${scan.sustainable.length} rows, ${sustainable.size} unique).`
    );
  }

  return {
    agnostic,
    sustainable,
    exGambling,
    agnosticOrder,
    sustainableOrder,
    exGamblingOrder,
    sourceSheet: sheetName,
    menuMeta: {
      agnosticHeaderRow: scan.rows.agnostic,
      sustainableHeaderRow: scan.rows.sustainable,
      exGamblingHeaderRow: scan.rows.exGambling,
      agnosticHeaderLabel: HEADER_AGNOSTIC,
      sustainableHeaderLabel: scan.sustainableHeaderLabel,
      exGamblingHeaderLabel: scan.exGamblingHeaderLabel,
    },
  };
}

/** Pretty-print template menus to stdout before validation runs. */
export function printMenuTables(menus) {
  const line = (ch, len = 62) => ch.repeat(len);
  const printBlock = (title, rangeLabel, tickers) => {
    const idxW = Math.max(2, String(Math.max(1, tickers.length)).length);
    const tickerW = Math.max(
      6,
      tickers.length ? Math.max(...tickers.map((t) => t.length)) : 6
    );
    console.log("");
    console.log(line("═"));
    console.log(`  ${title}`);
    console.log(`  ${rangeLabel}`);
    console.log(line("═"));
    console.log(`  ${"#".padEnd(idxW)}  ${"Ticker".padEnd(tickerW)}`);
    console.log(`  ${"─".repeat(idxW)}  ${"─".repeat(tickerW)}`);
    tickers.forEach((t, i) => {
      console.log(`  ${String(i + 1).padEnd(idxW)}  ${t.padEnd(tickerW)}`);
    });
    console.log(line("═"));
  };

  const m = menus.menuMeta;
  const sh = menus.sourceSheet;

  printBlock(
    `Agnostic menu (${menus.agnosticOrder.length} stocks)`,
    `${sh}!row ${m.agnosticHeaderRow} BO "${m.agnosticHeaderLabel}" → BQ until blank`,
    menus.agnosticOrder
  );
  printBlock(
    `Sustainable menu (${menus.sustainableOrder.length} stocks)`,
    `${sh}!row ${m.sustainableHeaderRow} BO "${m.sustainableHeaderLabel}" → BQ until blank`,
    menus.sustainableOrder
  );
  if (menus.exGamblingOrder.length > 0) {
    printBlock(
      `Ex-gambling menu (${menus.exGamblingOrder.length} stocks) — NOT used by any check; listed here for your reference only`,
      `${sh}!row ${m.exGamblingHeaderRow} BO "${m.exGamblingHeaderLabel}" → BQ until blank`,
      menus.exGamblingOrder
    );
  }
  console.log("");
}

function findSheetByName(workbook, preferredName) {
  const exact = workbook.SheetNames.find((n) => n === preferredName);
  if (exact) return exact;
  const ci = workbook.SheetNames.find(
    (n) => n.toLowerCase() === preferredName.toLowerCase()
  );
  return ci ?? null;
}

function getSheet2Name(workbook) {
  const named = findSheetByName(workbook, SHEET_2_NAME);
  if (named) return named;
  // Fallback: "sheet two" by position.
  return workbook.SheetNames[1] ?? null;
}

function getSheet1Name(workbook) {
  return findSheetByName(workbook, SHEET_1_NAME);
}

function detectMenuFromModelCell(modelCellLower) {
  const s = modelCellLower.trim();
  if (!s) return { menuKey: "agnostic", menuLabel: "Agnostic" };
  if (s.includes("sustain")) {
    return { menuKey: "sustainable", menuLabel: "Sustainability" };
  }
  if (s.includes("ex gambling") || s.includes("ex-gambling")) {
    return { menuKey: "exGambling", menuLabel: "Ex Gambling" };
  }
  return { menuKey: "agnostic", menuLabel: "Agnostic" };
}

export function evaluateWorkbook(workbookPath, workbook, menus) {
  const sheet2Name = getSheet2Name(workbook);
  if (!sheet2Name) {
    return {
      file: workbookPath,
      fatal: `Missing "${SHEET_2_NAME}" sheet`,
      checked: 0,
      compliant: 0,
      flagged: [],
      warnings: [],
    };
  }
  const holdingsName = getSheet1Name(workbook);
  if (!holdingsName) {
    return {
      file: workbookPath,
      fatal: `Missing "${SHEET_1_NAME}" sheet (Xplan holdings)`,
      checked: 0,
      compliant: 0,
      flagged: [],
      warnings: [],
    };
  }

  const sheet2 = workbook.Sheets[sheet2Name];
  const holdings = workbook.Sheets[holdingsName];

  const s2colsRes = resolveExtractColumns(
    sheet2,
    EXTRACT_HEADER_ROW_1BASED,
    EXTRACT_SHEET2_TITLES
  );
  if (!s2colsRes.ok) {
    return {
      file: workbookPath,
      fatal: `Sheet "${sheet2Name}" row ${EXTRACT_HEADER_ROW_1BASED}: missing column title(s): ${s2colsRes.missing.join(", ")}`,
      checked: 0,
      compliant: 0,
      flagged: [],
      warnings: [],
    };
  }

  const s1colsRes = resolveExtractColumns(
    holdings,
    EXTRACT_HEADER_ROW_1BASED,
    EXTRACT_SHEET1_TITLES
  );
  if (!s1colsRes.ok) {
    return {
      file: workbookPath,
      fatal: `Sheet "${holdingsName}" row ${EXTRACT_HEADER_ROW_1BASED}: missing column title(s): ${s1colsRes.missing.join(", ")}`,
      checked: 0,
      compliant: 0,
      flagged: [],
      warnings: [],
    };
  }

  const s2c = s2colsRes.cols;
  const h1c = s1colsRes.cols;
  const holdingsIndex = buildHoldingsIndex(
    holdings,
    h1c,
    EXTRACT_HEADER_ROW_1BASED
  );

  const result = {
    file: workbookPath,
    fatal: null,
    checked: 0,
    compliant: 0,
    flagged: [],
    warnings: [],
  };

  const ref = sheet2["!ref"];
  if (!ref) {
    result.warnings.push(`Sheet "${sheet2Name}" has no data range.`);
    return result;
  }
  const range = XLSX.utils.decode_range(ref);
  const dataStartR0 = EXTRACT_HEADER_ROW_1BASED;

  for (let r = dataStartR0; r <= range.e.r; r++) {
    const premiumValue = normalizeValue(
      sheet2[XLSX.utils.encode_cell({ r, c: s2c.premium })]?.v
    );
    const premiumCellLower = premiumValue.toLowerCase();
    if (premiumCellLower !== "premium") continue;

    const modelValue = normalizeValue(
      sheet2[XLSX.utils.encode_cell({ r, c: s2c.model })]?.v
    );
    const modelRawLower = modelValue.toLowerCase();
    const detected = detectMenuFromModelCell(modelRawLower);
    const menuType = detected.menuKey;
    const menuLabel = detected.menuLabel;
    const menuSetRaw = menus[menuType] ?? menus.agnostic;
    const menuSet =
      menuType === "exGambling" && menuSetRaw.size === 0
        ? menus.agnostic
        : menuSetRaw;
    const externalId = normalizeValue(
      sheet2[XLSX.utils.encode_cell({ r, c: s2c.externalId })]?.v
    );
    const portfolioName = normalizeValue(
      sheet2[XLSX.utils.encode_cell({ r, c: 0 })]?.v
    ) || `row-${r + 1}`;
    const owner = normalizeValue(
      sheet2[XLSX.utils.encode_cell({ r, c: s2c.owner })]?.v
    );

    if (!externalId) {
      result.warnings.push(
        `Sheet2 row ${r + 1} (${portfolioName}) is premium but has empty External ID.`
      );
      continue;
    }

    result.checked += 1;
    const holdingsRows = holdingsIndex.get(externalId) ?? [];
    if (holdingsRows.length === 0) {
      result.warnings.push(
        `No eligible tickers in "${holdingsName}" Code column for External ID "${externalId}" (${portfolioName}).`
      );
      result.compliant += 1;
      continue;
    }

    const unique = [...new Set(holdingsRows.map((h) => h.ticker))];
    const offenders = unique.filter(
      (t) => !menuSet.has(t) && !WHITELISTED_TICKERS.has(t)
    );
    if (offenders.length > 0) {
      const offendersWithOwner = offenders.map((ticker) => {
        const row = holdingsRows.find((h) => h.ticker === ticker);
        return {
          ticker,
          sheet1Owner: row?.owner ?? "",
          entityId: row?.entityId ?? "",
        };
      });
      result.flagged.push({
        row: r + 1,
        portfolioName,
        owner,
        externalId,
        menuType,
        tickersChecked: unique,
        offenders: offendersWithOwner,
        premiumValue,
        modelValue,
        menuLabel,
      });
    } else {
      result.compliant += 1;
    }
  }

  return result;
}

export function printResult(result) {
  const base = path.basename(result.file);
  if (result.fatal) {
    console.error(`\n[ERROR] ${base}: ${result.fatal}`);
    return;
  }

  console.error(
    `\n[FILE] ${base}\n  checked: ${result.checked}\n  compliant: ${result.compliant}\n  flagged: ${result.flagged.length}\n  warnings: ${result.warnings.length}`
  );

  for (const warning of result.warnings) {
    console.error(`  [WARN] ${warning}`);
  }

  for (const item of result.flagged) {
    const offenderCodes = item.offenders.map((o) => o.ticker).join(",");
    console.error(
      `  [FLAG] portfolio=${item.portfolioName} row=${item.row} owner=${JSON.stringify(item.owner)} externalId=${item.externalId} menu=${item.menuType} offenders=${offenderCodes}`
    );
  }
}

export function menusToSerializable(menus) {
  return {
    agnostic: [...menus.agnostic],
    sustainable: [...menus.sustainable],
    exGambling: [...menus.exGambling],
  };
}

export function menusFromSerializable(p) {
  return {
    agnostic: new Set(p.agnostic),
    sustainable: new Set(p.sustainable),
    exGambling: new Set(p.exGambling),
  };
}
