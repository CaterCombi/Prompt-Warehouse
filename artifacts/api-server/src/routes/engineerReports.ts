import { Router, type Request } from "express";
import type {
  EngineerReportAssetSearchResult,
  EngineerReportGenerateRequest,
  EngineerReportGenerateResult,
} from "@workspace/api-zod";
import { z } from "zod";
import { getEngineerReportAssetRecords, getEngineerReportRecord } from "../lib/engineerReportData.js";
import { generateEngineerReportPdf } from "../lib/engineerReportPdf.js";
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

function reportDateParts(serviceDate: Date | null): { fileDate: string; numberDate: string } {
  if (!serviceDate) return { fileDate: "undated", numberDate: "UNDATED" };
  const isoDate = serviceDate.toISOString().slice(0, 10);
  return { fileDate: isoDate, numberDate: isoDate.replaceAll("-", "") };
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
  try {
    const record = await getEngineerReportRecord(assetNumber, recordId);
    if (!record) {
      res.status(404).json({ message: "The selected service record was not found. Search the asset again." });
      return;
    }

    const { fileDate, numberDate } = reportDateParts(record.serviceDate);
    const baseName = `CaterCombi-Engineers-Report-${assetNumber}-${fileDate}`;
    const generatedAt = new Date();
    const requestUser = (req as AuthenticatedRequest).user;
    const generatedBy = requestUser.displayName.trim() || requestUser.username;
    const reportNumber = `ER-${assetNumber}-${numberDate}`;
    const fileName = `${baseName}.pdf`;
    const pdf = await generateEngineerReportPdf(assetNumber, record, reportNumber);

    const result: EngineerReportGenerateResult = {
      reportNumber,
      fileName,
      generatedAt,
      generatedBy,
      warnings: record.warnings,
      pdfBase64: Buffer.from(pdf).toString("base64"),
    };
    res.json(result);
  } catch (error) {
    req.log.error({ error, assetNumber, recordId }, "Failed to generate Engineer's Report");
    res.status(502).json({ message: "Could not generate the report. No report files were saved to SharePoint." });
  }
});

export default router;