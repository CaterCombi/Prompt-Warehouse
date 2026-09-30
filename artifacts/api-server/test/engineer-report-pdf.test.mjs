import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

test("generated engineer reports contain visible text on four A4 pages", async () => {
  const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temporaryDirectory = mkdtempSync(join(apiRoot, ".tmp-engineer-report-pdf-"));
  const bundlePath = join(temporaryDirectory, "engineerReportPdf.mjs");
  const checks = Array.from({ length: 57 }, (_, index) => ({
    number: index + 1,
    category: "Functional checks",
    label: `PDF text check ${index + 1}`,
    pass: false,
    fail: false,
    notApplicable: false,
    notes: "",
  }));
  const record = {
    serviceDate: new Date("2026-07-24T00:00:00.000Z"),
    engineer: "PDF Test Engineer",
    serialNumber: "SN-4118",
    operatingHours: "1234",
    make: "Rational",
    model: "SCC WE",
    fuelType: "E",
    assetDetails: {
      manufacturer: "Rational",
      model: "SCC WE",
      powerSource: "E",
      size: "202",
    },
    parts: [],
    checks,
    warnings: [],
  };

  try {
    await build({
      entryPoints: [join(apiRoot, "src/lib/engineerReportPdf.ts")],
      outfile: bundlePath,
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      plugins: [{
        name: "source-js-extension-resolution",
        setup(builder) {
          builder.onResolve({ filter: /\.js$/ }, (args) => {
            if (!args.path.startsWith(".")) return;
            const typescriptPath = resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
            return existsSync(typescriptPath) ? { path: typescriptPath } : undefined;
          });
        },
      }],
    });
    const { generateEngineerReportPdf } = await import(pathToFileURL(bundlePath).href);
    const pdf = await generateEngineerReportPdf("4118", record, "ER-4118-20260724");
    const pdfPath = join(temporaryDirectory, "report.pdf");
    writeFileSync(pdfPath, pdf);
    const metadata = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
    const text = execFileSync("pdftotext", [pdfPath, "-"], { encoding: "utf8" });

    assert.match(metadata, /Pages:\s+4/);
    assert.match(metadata, /Page size:.*A4/);
    for (const expected of [
      "Engineer's Report",
      "Job details",
      "Oven details",
      "Rational",
      "SCC WE",
      "Size (asset register)",
      "202",
      "Test readings",
      "Sign-off",
    ]) {
      assert.ok(text.includes(expected), `Expected generated PDF text to contain "${expected}".`);
    }
    assert.match(text, /Fuel\s*\/\s*power source[\s\S]*?\bE\b/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});