import assert from "node:assert/strict";
import test from "node:test";
import {
  findEngineerReportAssetSource,
  reconcileEngineerReportValue,
  toEngineerReportAssetDetails,
} from "../src/lib/engineerReportAssetDetails.ts";

const sourceRecords = [
  {
    assetNumber: "14118",
    manufacturer: "Other",
    model: "Unrelated",
    fuel: "Gas",
    size: "10 Grid",
  },
  {
    assetNumber: "4118",
    manufacturer: "  Rational ",
    model: "SCC WE",
    fuel: "E",
    size: "202",
  },
];

test("asset-register lookup matches the whole normalized asset number", () => {
  const source = findEngineerReportAssetSource(sourceRecords, " 4118 ");
  assert.equal(source?.assetNumber, "4118");
  assert.deepEqual(toEngineerReportAssetDetails(source), {
    manufacturer: "Rational",
    model: "SCC WE",
    powerSource: "E",
    size: "202",
  });
});

test("missing asset-register values stay unknown instead of being inferred", () => {
  const source = findEngineerReportAssetSource(
    [{ assetNumber: "9001", manufacturer: "", model: null, fuel: "", size: null }],
    "9001",
  );
  assert.deepEqual(toEngineerReportAssetDetails(source), {
    manufacturer: null,
    model: null,
    powerSource: null,
    size: null,
  });
});

test("ambiguous exact asset-register matches fail explicitly", () => {
  assert.throws(
    () => findEngineerReportAssetSource([...sourceRecords, sourceRecords[1]], "4118"),
    /More than one asset-register record/,
  );
});

test("asset-register values take precedence on disagreements and unknown fields stay unknown", () => {
  const warnings = [];
  assert.equal(reconcileEngineerReportValue("Make", "Rational", "Rational", warnings), "Rational");
  assert.equal(reconcileEngineerReportValue("Model", "SCC 202", "SCC WE", warnings), "SCC WE");
  assert.equal(reconcileEngineerReportValue("Power source", null, "E", warnings), "E");
  assert.equal(reconcileEngineerReportValue("Size", null, null, warnings), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Model differs between the selected refurbishment record/);
  assert.match(warnings[0], /SCC 202.*SCC WE/);
});