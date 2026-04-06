import fs from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import * as XLSX from "xlsx";
import {
  evaluateWorkbook,
  menusFromSerializable,
  READ_OPTS,
} from "./premium-menu-compliance-core.js";

const menus = menusFromSerializable(workerData.menusPayload);

parentPort.on("message", async (msg) => {
  if (msg?.type === "shutdown") {
    process.exit(0);
  }
  if (msg?.type !== "evaluate" || !msg.filePath) return;
  try {
    const buf = await fs.readFile(msg.filePath);
    const workbook = XLSX.read(buf, READ_OPTS);
    const result = evaluateWorkbook(msg.filePath, workbook, menus);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: err.message,
      filePath: msg.filePath,
    });
  }
});
