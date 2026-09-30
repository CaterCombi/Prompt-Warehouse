import type {
  EngineerReportAssetSearchResult,
  EngineerReportPart,
  EngineerReportServiceRecord,
} from "@workspace/api-zod";
import { getSharePointGraphJson, getSharePointSiteId } from "./sharepoint.js";
import {
  buildChecks,
  checklistConfig,
  mapParts,
  normalizeHeader,
  type PartPrice,
  type PartPriceIndex,
} from "./engineerReportMappings.js";

const WORKBOOK_NAME = "Parts used on Refurbished Ovens.xlsx";
const FORM_SHEET_NAME = "Form1";
const PARTS_SHEET_NAME = "Parts Price List";
const REPORTS_DRIVE_NAME = "Documents";
const PRIVATE_METADATA_START_COLUMN = 6;

type GraphDrive = { id: string; name: string; driveType?: string };
type GraphItem = {
  id: string;
  name: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
};
type GraphWorksheet = { id: string; name: string };
type GraphUsedRange = { rowCount: number; columnCount: number; address?: string };
type WorkbookSheetContext = {
  id: string;
  rowCount: number;
  columnCount: number;
  headers: string[];
};
type WorkbookContext = {
  driveId: string;
  workbookId: string;
  form: WorkbookSheetContext;
  parts: WorkbookSheetContext;
};
let workbookContextCache: { value: WorkbookContext; expiresAt: number } | null = null;
let partPriceCache: { value: PartPriceIndex; expiresAt: number } | null = null;

function graphPath(path: string) {
  return getSharePointGraphJson(path) as Promise<Record<string, unknown>>;
}

function excelColumnName(columnIndex: number): string {
  let value = columnIndex + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function findHeader(headers: string[], names: string[]): number | null {
  const accepted = new Set(names.map(normalizeHeader));
  const index = headers.findIndex((header) => accepted.has(normalizeHeader(header)));
  return index < 0 ? null : index;
}

function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function columnRange(startIndex: number, endIndex: number, firstRow: number, lastRow: number): string {
  return `${excelColumnName(startIndex)}${firstRow}:${excelColumnName(endIndex)}${lastRow}`;
}

async function getWorkbookContext(): Promise<WorkbookContext> {
  if (workbookContextCache && workbookContextCache.expiresAt > Date.now()) {
    return workbookContextCache.value;
  }

  const siteId = await getSharePointSiteId();
  const drivesResponse = await graphPath(`/sites/${encodeURIComponent(siteId)}/drives?$select=id,name,driveType`);
  const drives = (drivesResponse["value"] ?? []) as GraphDrive[];
  const drive =
    drives.find((candidate) => candidate.name === REPORTS_DRIVE_NAME) ??
    (drives.filter((candidate) => candidate.driveType === "documentLibrary").length === 1
      ? drives.find((candidate) => candidate.driveType === "documentLibrary")
      : undefined);
  if (!drive?.id) {
    throw new Error(`Could not find the SharePoint document library "${REPORTS_DRIVE_NAME}".`);
  }

  const search = await graphPath(
    `/drives/${encodeURIComponent(drive.id)}/root/search(q='${encodeURIComponent("Parts used on Refurbished Ovens")}')?$select=id,name,lastModifiedDateTime`,
  );
  const exactMatches = ((search["value"] ?? []) as GraphItem[])
    .filter((item) => item.name.toLocaleLowerCase("en-GB") === WORKBOOK_NAME.toLocaleLowerCase("en-GB"))
    .sort((left, right) => (right.lastModifiedDateTime ?? "").localeCompare(left.lastModifiedDateTime ?? ""));
  const workbook = exactMatches[0];
  if (!workbook?.id) {
    throw new Error(`The SharePoint workbook "${WORKBOOK_NAME}" was not found.`);
  }

  const worksheetsResponse = await graphPath(
    `/drives/${encodeURIComponent(drive.id)}/items/${encodeURIComponent(workbook.id)}/workbook/worksheets?$select=id,name`,
  );
  const worksheets = (worksheetsResponse["value"] ?? []) as GraphWorksheet[];
  const formSheet = worksheets.find((sheet) => sheet.name === FORM_SHEET_NAME);
  const partsSheet = worksheets.find((sheet) => sheet.name === PARTS_SHEET_NAME);
  if (!formSheet?.id || !partsSheet?.id) {
    throw new Error(`The workbook must contain "${FORM_SHEET_NAME}" and "${PARTS_SHEET_NAME}" worksheets.`);
  }

  const [formRange, partsRange] = await Promise.all([
    graphPath(
      `/drives/${encodeURIComponent(drive.id)}/items/${encodeURIComponent(workbook.id)}/workbook/worksheets/${encodeURIComponent(formSheet.id)}/usedRange(valuesOnly=true)?$select=rowCount,columnCount`,
    ),
    graphPath(
      `/drives/${encodeURIComponent(drive.id)}/items/${encodeURIComponent(workbook.id)}/workbook/worksheets/${encodeURIComponent(partsSheet.id)}/usedRange(valuesOnly=true)?$select=rowCount,columnCount`,
    ),
  ]);
  const formUsed = formRange as unknown as GraphUsedRange;
  const partsUsed = partsRange as unknown as GraphUsedRange;
  if (!formUsed.rowCount || !formUsed.columnCount || !partsUsed.rowCount || !partsUsed.columnCount) {
    throw new Error("The workbook worksheets have no readable used range.");
  }

  const [formHeaderRange, partsHeaderRange] = await Promise.all([
    getSheetRange(drive.id, workbook.id, formSheet.id, `A1:${excelColumnName(formUsed.columnCount - 1)}1`),
    getSheetRange(drive.id, workbook.id, partsSheet.id, `A1:${excelColumnName(partsUsed.columnCount - 1)}1`),
  ]);
  const context: WorkbookContext = {
    driveId: drive.id,
    workbookId: workbook.id,
    form: {
      id: formSheet.id,
      rowCount: formUsed.rowCount,
      columnCount: formUsed.columnCount,
      headers: (formHeaderRange[0] ?? []).map((value) => String(value ?? "").trim()),
    },
    parts: {
      id: partsSheet.id,
      rowCount: partsUsed.rowCount,
      columnCount: partsUsed.columnCount,
      headers: (partsHeaderRange[0] ?? []).map((value) => String(value ?? "").trim()),
    },
  };

  workbookContextCache = { value: context, expiresAt: Date.now() + 5 * 60 * 1000 };
  return context;
}

async function getSheetRange(
  driveId: string,
  workbookId: string,
  worksheetId: string,
  address: string,
): Promise<unknown[][]> {
  const response = await graphPath(
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(workbookId)}/workbook/worksheets/${encodeURIComponent(worksheetId)}/range(address='${address}')?$select=values`,
  );
  return ((response["values"] ?? []) as unknown[][]);
}

function valueAsIsoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 24 * 60 * 60 * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  const text = cellText(value);
  if (!text) return null;
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
  }
  const ukMatch = text.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/);
  if (ukMatch) {
    return `${ukMatch[3]}-${ukMatch[2].padStart(2, "0")}-${ukMatch[1].padStart(2, "0")}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

async function getPartPrices(context: WorkbookContext): Promise<{
  byNumber: Map<string, PartPrice>;
  byDescription: Map<string, PartPrice[]>;
}> {
  if (partPriceCache && partPriceCache.expiresAt > Date.now()) {
    return partPriceCache.value;
  }

  const partNumberIndex = findHeader(context.parts.headers, ["Part number"]);
  const descriptionIndices = [
    findHeader(context.parts.headers, ["Part description 1"]),
    findHeader(context.parts.headers, ["Part description 2"]),
    findHeader(context.parts.headers, ["Part description 3"]),
    findHeader(context.parts.headers, ["Part description 4"]),
  ].filter((index): index is number => index !== null);
  if (partNumberIndex === null || descriptionIndices.length === 0) {
    throw new Error("The Parts Price List must include a Part number column and at least one Part description column.");
  }

  const firstColumn = Math.min(partNumberIndex, ...descriptionIndices);
  const lastColumn = Math.max(partNumberIndex, ...descriptionIndices);
  const rows = await getSheetRange(
    context.driveId,
    context.workbookId,
    context.parts.id,
    columnRange(firstColumn, lastColumn, 2, context.parts.rowCount),
  );
  const byNumber = new Map<string, PartPrice>();
  const byDescription = new Map<string, PartPrice[]>();
  for (const row of rows) {
    const partNumber = cellText(row[partNumberIndex - firstColumn]);
    if (!partNumber) continue;
    const description = descriptionIndices
      .map((index) => cellText(row[index - firstColumn]))
      .find((value): value is string => Boolean(value));
    if (!description) continue;
    const price = { partNumber, description };
    byNumber.set(partNumber.toLocaleLowerCase("en-GB"), price);
    const key = normalizeHeader(description);
    byDescription.set(key, [...(byDescription.get(key) ?? []), price]);
  }

  const value = { byNumber, byDescription };
  partPriceCache = { value, expiresAt: Date.now() + 30 * 60 * 1000 };
  return value;
}

function findOptionalColumn(headers: string[], exactNames: string[]): number | null {
  return findHeader(headers, exactNames);
}

function optionalText(row: unknown[], index: number | null, startColumn: number): string | null {
  return index === null ? null : cellText(row[index - startColumn]);
}

export async function getEngineerReportAssetRecords(
  assetNumber: string,
): Promise<EngineerReportAssetSearchResult> {
  const context = await getWorkbookContext();
  const assetColumn = findHeader(context.form.headers, ["Oven Asset Number"]);
  if (assetColumn === null || assetColumn < PRIVATE_METADATA_START_COLUMN) {
    throw new Error("The Form1 response table does not contain a safe Oven Asset Number column.");
  }

  const serialColumn = findHeader(context.form.headers, ["Oven Serial Number"]);
  const dateColumn = findHeader(context.form.headers, ["Date of Refurbishment", "Date of Service"]);
  const engineerColumn = findHeader(context.form.headers, ["Engineer completing the works", "Engineer"]);
  const hoursColumn = findHeader(context.form.headers, [
    "Total working hours for the oven (Add a single number only)",
    "Operating hours",
    "Hours",
  ]);
  if (serialColumn === null || dateColumn === null || engineerColumn === null || hoursColumn === null) {
    throw new Error("The Form1 response table is missing a required service-record column.");
  }

  const partColumns = context.form.headers
    .map((header, index) => ({ header: normalizeHeader(header), index }))
    .filter(({ header, index }) => index >= PRIVATE_METADATA_START_COLUMN && /^part used\d*$/.test(header))
    .map(({ index }) => index);
  if (partColumns.length === 0) {
    throw new Error("The Form1 response table has no Part used fields.");
  }

  const makeColumn = findOptionalColumn(context.form.headers, ["Make"]);
  const modelColumn = findOptionalColumn(context.form.headers, ["Model"]);
  const fuelColumn = findOptionalColumn(context.form.headers, ["Fuel type", "Fuel"]);
  const startColumn = Math.min(assetColumn, serialColumn, dateColumn, engineerColumn, hoursColumn, ...partColumns);
  const endColumn = Math.max(assetColumn, serialColumn, dateColumn, engineerColumn, hoursColumn, ...partColumns);
  if (startColumn < PRIVATE_METADATA_START_COLUMN) {
    throw new Error("The service data range unexpectedly overlaps private submission metadata.");
  }

  const assetValues = await getSheetRange(
    context.driveId,
    context.workbookId,
    context.form.id,
    `${excelColumnName(assetColumn)}2:${excelColumnName(assetColumn)}${context.form.rowCount}`,
  );
  const normalizedAsset = assetNumber.trim().toLocaleLowerCase("en-GB");
  const matchingRowNumbers = assetValues
    .map((row, index) => (cellText(row[0])?.toLocaleLowerCase("en-GB") === normalizedAsset ? index + 2 : null))
    .filter((rowNumber): rowNumber is number => rowNumber !== null);

  if (matchingRowNumbers.length === 0) {
    return { assetNumber: assetNumber.trim(), records: [] };
  }

  const [priceIndex, records] = await Promise.all([
    getPartPrices(context),
    Promise.all(
      matchingRowNumbers.map(async (rowNumber) => {
        const rows = await getSheetRange(
          context.driveId,
          context.workbookId,
          context.form.id,
          columnRange(startColumn, endColumn, rowNumber, rowNumber),
        );
        return { rowNumber, row: rows[0] ?? [] };
      }),
    ),
  ]);

  const serviceRecords = records.map(({ rowNumber, row }): EngineerReportServiceRecord => {
    const parts = mapParts(partColumns.map((column) => row[column - startColumn]), priceIndex);
    const serviceDate = valueAsIsoDate(row[dateColumn - startColumn]);
    const engineer = optionalText(row, engineerColumn, startColumn);
    const serialNumber = optionalText(row, serialColumn, startColumn);
    const operatingHours = optionalText(row, hoursColumn, startColumn);
    const make = optionalText(row, makeColumn, startColumn);
    const model = optionalText(row, modelColumn, startColumn);
    const fuelType = optionalText(row, fuelColumn, startColumn);

    const warnings: string[] = [];
    if (!serviceDate) warnings.push("Service date not recorded.");
    if (!engineer) warnings.push("Engineer not recorded.");
    if (!serialNumber) warnings.push("Serial number not recorded.");
    if (!operatingHours) warnings.push("Operating hours not recorded.");
    if (!make && !model) warnings.push("Make/model not recorded.");
    else if (!make) warnings.push("Make not recorded.");
    else if (!model) warnings.push("Model not recorded.");
    if (!fuelType) warnings.push("Fuel type not recorded; gas-only checks 27–28 need confirmation.");
    for (const part of parts.filter((item) => !item.matched)) {
      warnings.push(`Unmatched part: ${part.description}${part.partNumber ? ` (${part.partNumber})` : ""}`);
    }

    return {
      recordId: String(rowNumber),
      serviceDate: serviceDate ? new Date(`${serviceDate}T00:00:00.000Z`) : null,
      engineer,
      serialNumber,
      operatingHours,
      make,
      model,
      fuelType,
      parts,
      checks: buildChecks(parts, fuelType),
      warnings,
    };
  });

  serviceRecords.sort((left, right) => {
    const leftDate = left.serviceDate?.getTime() ?? 0;
    const rightDate = right.serviceDate?.getTime() ?? 0;
    return rightDate - leftDate || Number(right.recordId) - Number(left.recordId);
  });

  return { assetNumber: assetNumber.trim(), records: serviceRecords };
}

export async function getEngineerReportRecord(
  assetNumber: string,
  recordId: string,
): Promise<EngineerReportServiceRecord | null> {
  const result = await getEngineerReportAssetRecords(assetNumber);
  return result.records.find((record) => record.recordId === recordId) ?? null;
}

export async function getEngineerReportDriveId(): Promise<string> {
  return (await getWorkbookContext()).driveId;
}

export function formatServiceDate(value: Date | null): string {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}