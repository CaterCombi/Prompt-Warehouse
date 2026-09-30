import { Router, type Request } from "express";
import type {
  EngineerReportAssetSearchResult,
  EngineerReportGenerateRequest,
  EngineerReportGenerateResult,
} from "@workspace/api-zod";
import { z } from "zod";
import { getEngineerReportAssetRecords, getEngineerReportDriveId, getEngineerReportRecord } from "../lib/engineerReportData.js";
import { generateEngineerReportPdf } from "../lib/engineerReportPdf.js";
import {
  getSharePointGraphJson,
  postSharePointGraphJson,
  SharePointConflictError,
  uploadSharePointDriveFile,
  type SharePointDriveFile,
} from "../lib/sharepoint.js";
import { requireAuth } from "../middlewares/requireAuth.js";

const router = Router();
router.use(requireAuth);

const assetNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Asset number contains unsupported characters.");

const generateRequestSchema = z.object({
  assetNumber: assetNumberSchema,
  recordId: z.string().trim().regex(/^\d+$/, "Select a valid service record."),
});

type AuthenticatedRequest = Request & {
  user: { id: string; username: string; displayName: string };
};

type DriveChild = {
  id: string;
  name: string;
  webUrl?: string;
  folder?: Record<string, unknown>;
  file?: Record<string, unknown>;
};

type DriveChildrenResponse = {
  value?: DriveChild[];
  "@odata.nextLink"?: string;
};

type DriveItem = {
  id: string;
  name: string;
  webUrl?: string;
};

function graphPath(path: string) {
  return getSharePointGraphJson(path) as Promise<Record<string, unknown>>;
}

async function listChildren(driveId: string, parentId: string): Promise<DriveChild[]> {
  const children: DriveChild[] = [];
  let nextPath: string | null = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentId)}/children?$select=id,name,webUrl,file,folder&$top=999`;
  while (nextPath) {
    const response = (await graphPath(nextPath)) as unknown as DriveChildrenResponse;
    children.push(...(response.value ?? []));
    nextPath = response["@odata.nextLink"] ?? null;
  }
  return children;
}

async function getOrCreateFolder(
  driveId: string,
  parentId: string,
  folderName: string,
): Promise<DriveItem> {
  const findFolder = async () =>
    (await listChildren(driveId, parentId)).find(
      (item) => item.folder && item.name.toLocaleLowerCase("en-GB") === folderName.toLocaleLowerCase("en-GB"),
    );
  const existing = await findFolder();
  if (existing?.id) return existing;

  try {
    const created = (await postSharePointGraphJson(
      `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentId)}/children`,
      {
        name: folderName,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      },
    )) as DriveItem;
    if (!created.id || !created.name) {
      throw new Error(`SharePoint did not return the created folder "${folderName}".`);
    }
    return created;
  } catch (error) {
    const racedFolder = await findFolder().catch(() => undefined);
    if (racedFolder?.id) return racedFolder;
    throw error;
  }
}

async function getRootItemId(driveId: string): Promise<string> {
  const root = await graphPath(`/drives/${encodeURIComponent(driveId)}/root?$select=id`);
  const id = String(root["id"] ?? "");
  if (!id) throw new Error("Could not resolve the SharePoint document library root.");
  return id;
}

function reportDateParts(serviceDate: Date | null): { fileDate: string; numberDate: string } {
  if (!serviceDate) return { fileDate: "undated", numberDate: "UNDATED" };
  const isoDate = serviceDate.toISOString().slice(0, 10);
  return { fileDate: isoDate, numberDate: isoDate.replaceAll("-", "") };
}

function versionSuffix(version: number): string {
  return version === 1 ? "" : `-${version}`;
}

function createReportLog(
  assetNumber: string,
  reportNumber: string,
  fileName: string,
  generatedAt: Date,
  generatedBy: string,
  pdfFile: SharePointDriveFile,
  serviceDate: Date | null,
) {
  return {
    asset: assetNumber,
    reportNumber,
    serviceDate,
    dateGenerated: generatedAt,
    generatedBy,
    sharePointFileName: fileName,
    sharePointFileLink: pdfFile.webUrl,
  };
}

async function uploadReportLog(
  driveId: string,
  folderId: string,
  fileName: string,
  logRecord: ReturnType<typeof createReportLog>,
): Promise<void> {
  const contents = Buffer.from(`${JSON.stringify(logRecord, null, 2)}\n`, "utf8");
  await uploadSharePointDriveFile(driveId, folderId, fileName, contents, "application/json; charset=utf-8");
}

router.get("/assets/:assetNumber", async (req, res) => {
  const parsedAsset = assetNumberSchema.safeParse(String(req.params.assetNumber ?? ""));
  if (!parsedAsset.success) {
    res.status(400).json({ message: parsedAsset.error.issues[0]?.message ?? "Enter a valid asset number." });
    return;
  }

  try {
    const result: EngineerReportAssetSearchResult = await getEngineerReportAssetRecords(parsedAsset.data);
    res.json(result);
  } catch (error) {
    req.log.error({ error }, "Failed to read Engineer's Report source data");
    res.status(502).json({ message: "Could not read the refurbishment records from SharePoint." });
  }
});

router.post("/generate", async (req, res) => {
  const parsedRequest = generateRequestSchema.safeParse(req.body as EngineerReportGenerateRequest);
  if (!parsedRequest.success) {
    res.status(400).json({ message: "Enter a valid asset number and select a service record." });
    return;
  }

  const { assetNumber, recordId } = parsedRequest.data;
  let savedPdf: SharePointDriveFile | null = null;
  try {
    const record = await getEngineerReportRecord(assetNumber, recordId);
    if (!record) {
      res.status(404).json({ message: "The selected service record was not found. Search the asset again." });
      return;
    }

    const driveId = await getEngineerReportDriveId();
    const rootId = await getRootItemId(driveId);
    const reportsFolder = await getOrCreateFolder(driveId, rootId, "Engineer Reports");
    const assetFolder = await getOrCreateFolder(driveId, reportsFolder.id, assetNumber);
    const existingNames = new Set((await listChildren(driveId, assetFolder.id)).map((item) => item.name.toLocaleLowerCase("en-GB")));
    const { fileDate, numberDate } = reportDateParts(record.serviceDate);
    const baseName = `CaterCombi-Engineers-Report-${assetNumber}-${fileDate}`;
    const generatedAt = new Date();
    const requestUser = (req as AuthenticatedRequest).user;
    const generatedBy = requestUser.displayName.trim() || requestUser.username;

    for (let version = 1; version <= 999; version += 1) {
      const suffix = versionSuffix(version);
      const fileName = `${baseName}${suffix}.pdf`;
      const logFileName = `${baseName}${suffix}.json`;
      if (existingNames.has(fileName.toLocaleLowerCase("en-GB")) || existingNames.has(logFileName.toLocaleLowerCase("en-GB"))) {
        continue;
      }

      const reportNumber = `ER-${assetNumber}-${numberDate}${suffix}`;
      const pdf = await generateEngineerReportPdf(assetNumber, record, reportNumber);
      try {
        savedPdf = await uploadSharePointDriveFile(driveId, assetFolder.id, fileName, pdf, "application/pdf");
      } catch (error) {
        if (error instanceof SharePointConflictError) continue;
        throw error;
      }

      if (!savedPdf.webUrl) {
        throw new Error("SharePoint saved the PDF but did not return a file link.");
      }

      const logRecord = createReportLog(
        assetNumber,
        reportNumber,
        fileName,
        generatedAt,
        generatedBy,
        savedPdf,
        record.serviceDate,
      );
      await uploadReportLog(driveId, assetFolder.id, logFileName, logRecord);

      const result: EngineerReportGenerateResult = {
        reportNumber,
        fileName,
        sharePointUrl: savedPdf.webUrl,
        generatedAt,
        generatedBy,
        warnings: record.warnings,
        pdfBase64: Buffer.from(pdf).toString("base64"),
      };
      res.json(result);
      return;
    }

    res.status(409).json({ message: "Could not find an unused report version number. Contact an administrator." });
  } catch (error) {
    req.log.error({ error, assetNumber, recordId }, "Failed to generate or save Engineer's Report");
    if (savedPdf) {
      res.status(502).json({
        message: `The PDF was saved as "${savedPdf.name}", but its audit log could not be saved. No existing report was overwritten.`,
      });
      return;
    }
    res.status(502).json({ message: "Could not generate and save the report. No existing SharePoint file was overwritten." });
  }
});

export default router;