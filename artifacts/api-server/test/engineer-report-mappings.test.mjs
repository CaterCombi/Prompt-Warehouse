import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChecks,
  checklistConfig,
  mapParts,
  matchChecks,
} from "../src/lib/engineerReportMappings.ts";

const emptyPriceIndex = { byNumber: new Map(), byDescription: new Map() };

test("the report checklist contains exactly checks 1 through 57", () => {
  const numbers = checklistConfig.checks.map((check) => check.number);
  assert.deepEqual(numbers, Array.from({ length: 57 }, (_, index) => index + 1));
});

test("part descriptions map to the expected checklist points", () => {
  const cases = [
    ["Door gasket", [3]],
    ["Fixing device middle for intermediate glass pane", [4]],
    ["Bulb socket", [11]],
    ["Core temperature probe", [14]],
    ["Gasket for heating element", [26]],
    ["Convection heating element", [24]],
    ["Steam generator heating element", [25]],
    ["Fan motor with motor shaft gasket", [30, 32, 33]],
    ["Motor shaft gasket D15", [33]],
    ["Gasket for inspection lid", [35]],
    ["Steam hose kit", [39]],
    ["Flap Care container", [48]],
    ["Overlay *RAT*", [52]],
    ["Dial for pulse generator", [52]],
    ["Air inlet pipe", []],
    ["Cover, air inlet", []],
  ];

  for (const [description, expected] of cases) {
    assert.deepEqual(matchChecks(description), expected, description);
  }
});

test("abbreviations expand, repeated items combine, and unmatched parts remain visible", () => {
  const price = { partNumber: "11.00.123P", description: "Gasket f. heating element" };
  const priceIndex = {
    byNumber: new Map([[price.partNumber.toLocaleLowerCase("en-GB"), price]]),
    byDescription: new Map([["gasket f. heating element", [price]]]),
  };
  const parts = mapParts(
    [price.partNumber, price.partNumber, "Air inlet pipe", "Air inlet pipe"],
    priceIndex,
  );

  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], {
    description: "Gasket for heating element",
    partNumber: "11.00.123P",
    quantity: 2,
    matchedChecks: [26],
    matched: true,
  });
  assert.deepEqual(parts[1], {
    description: "Air inlet pipe",
    partNumber: null,
    quantity: 2,
    matchedChecks: [],
    matched: false,
  });
});

test("unknown fuel leaves gas-only checks unticked with an engineer confirmation note", () => {
  const checks = buildChecks([], null);
  const check27 = checks.find((check) => check.number === 27);
  const check28 = checks.find((check) => check.number === 28);

  assert.equal(checks.length, 57);
  assert.equal(checks.find((check) => check.number === 1)?.pass, true);
  for (const check of [check27, check28]) {
    assert.equal(check?.pass, false);
    assert.equal(check?.fail, false);
    assert.equal(check?.notApplicable, false);
    assert.equal(check?.notes, "Gas only: confirm fuel type");
  }
});

test("electric ovens mark gas-only checks N/A and mapped gas replacement parts do not pass", () => {
  const electricChecks = buildChecks([], "Electric");
  assert.equal(electricChecks.find((check) => check.number === 27)?.notApplicable, true);
  assert.equal(electricChecks.find((check) => check.number === 28)?.notApplicable, true);

  const gasChecks = buildChecks(
    [{
      description: "Burner",
      partNumber: null,
      quantity: 1,
      matchedChecks: [27],
      matched: true,
    }],
    "Gas",
  );
  assert.equal(gasChecks.find((check) => check.number === 27)?.pass, false);
  assert.equal(gasChecks.find((check) => check.number === 27)?.notes, "Part replaced: Burner");
  assert.equal(gasChecks.find((check) => check.number === 28)?.pass, true);
});