import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLowStockProducts,
  getSyncOverview,
  runSync,
} from "../src/lib/shopify.ts";

const originalEnv = {
  SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET,
};

function product(sku, id = sku, published = true) {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Product ${sku}`,
    status: "ACTIVE",
    publishedOnPublication: published,
    variants: { nodes: [{ sku }] },
  };
}

function mockShopify(products, mutations = []) {
  const originalFetch = globalThis.fetch;
  process.env.SHOPIFY_STORE_DOMAIN = "unit-test.myshopify.com";
  process.env.SHOPIFY_CLIENT_ID = "test-client";
  process.env.SHOPIFY_CLIENT_SECRET = "test-secret";

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/admin/oauth/access_token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "test-access-token", expires_in: 3600 }),
      };
    }
    if (!url.endsWith("/graphql.json")) {
      throw new Error(`Unexpected Shopify request: ${url}`);
    }

    const { query } = JSON.parse(init.body);
    if (query.includes("query SyncShopContext")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            shop: { name: "Test shop", myshopifyDomain: "unit-test.myshopify.com" },
            publications: { nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store" }] },
          },
        }),
      };
    }
    if (query.includes("query SyncProducts")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            products: {
              nodes: products,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      };
    }
    if (query.includes("mutation PublishProduct") || query.includes("mutation UnpublishProduct")) {
      mutations.push(query);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            publishablePublish: { userErrors: [] },
            publishableUnpublish: { userErrors: [] },
          },
        }),
      };
    }
    throw new Error(`Unexpected Shopify GraphQL operation: ${query}`);
  };

  return () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function asset(id, assetNumber, status, manufacturer, model = "CM", size = "61", fuel = "Electric") {
  return { id, assetNumber, status, manufacturer, model, size, fuel };
}

test("Catercombi accessories, including X367 Drain Pump, never create a Shopify mutation", async () => {
  const mutations = [];
  const restore = mockShopify([
    product("CAT-SINGULAR", "singular"),
    product("CAT-PLURAL", "plural", false),
    product("X367"),
  ], mutations);
  try {
    const assets = [
      asset("1", "CAT-SINGULAR", "Booked", "Catercombi Accessory"),
      asset("2", "CAT-PLURAL", "Available", "Catercombi Accessories"),
      asset("3", "X367", "Booked", "RATIONAL", "Drain Pump"),
    ];

    const overview = await getSyncOverview(assets);
    assert.equal(
      overview.rows.some((row) => ["CAT-SINGULAR", "CAT-PLURAL", "X367"].includes(row.assetNumber)),
      false,
    );

    const result = await runSync(assets);
    assert.equal(result.actions.some((action) => action.action === "unpublished"), false);
    assert.deepEqual(mutations, []);
  } finally {
    restore();
  }
});

test("stacked AMT assets stay out of Control Room results without changing the source register", async () => {
  const assets = [
    asset("base", "4111", "Available", "RATIONAL"),
    asset("component-a", "4112", "On the bay", "RATIONAL"),
    asset("component-b", "4113", "Cleaning", "RATIONAL"),
  ];
  const originalAssets = structuredClone(assets);
  const restore = mockShopify([
    product("4111", "4111"),
    product("4112", "4112"),
    product("4113", "4113"),
  ]);

  try {
    const overview = await getSyncOverview(assets);
    assert.equal(overview.rows.some((row) => ["4112", "4113"].includes(row.assetNumber)), false);
    assert.equal(overview.rows.some((row) => row.assetNumber === "4111"), true);

    const lowStock = buildLowStockProducts(assets);
    const rationalCm = lowStock.find(
      (item) => item.model === "CM" && item.shopifySize === "6 x 1/1" && item.fuel === "E",
    );
    assert.ok(rationalCm);
    assert.equal(rationalCm.physicalStockCount, 1);
    assert.deepEqual(rationalCm.assetNumbers, ["4111"]);
    assert.equal(
      lowStock.some((item) =>
        item.assetNumbers.some((number) => ["4112", "4113"].includes(number)),
      ),
      false,
    );
    assert.deepEqual(assets, originalAssets);
  } finally {
    restore();
  }
});

test("Control Room low-stock counts the defined in-building AMT statuses", () => {
  const includedStatuses = [
    "Available",
    "Priority",
    "Cleaning",
    "On the Bay",
    "Refurbishment",
    "Reserved",
  ];

  for (const [index, status] of includedStatuses.entries()) {
    const assetNumber = `IN-${index + 1}`;
    const products = buildLowStockProducts([
      asset(String(index + 1), assetNumber, status, "RATIONAL"),
    ]);
    const combination = products.find(
      (item) => item.model === "CM" && item.shopifySize === "6 x 1/1" && item.fuel === "E",
    );

    assert.ok(combination, `expected ${status} to remain in the low-stock results`);
    assert.equal(combination.physicalStockCount, 1, `${status} should count as in-building stock`);
    assert.deepEqual(combination.assetNumbers, [assetNumber]);
  }
});

test("Control Room low-stock does not count non-building statuses as physical stock", () => {
  for (const status of ["Booked", "On Hire", "Sold", "Purchased"]) {
    const products = buildLowStockProducts([
      asset(`non-building-${status}`, `OUT-${status}`, status, "RATIONAL"),
    ]);
    const combination = products.find(
      (item) => item.model === "CM" && item.shopifySize === "6 x 1/1" && item.fuel === "E",
    );

    assert.ok(combination, `expected ${status} to remain represented as a zero-stock combination`);
    assert.equal(combination.physicalStockCount, 0, `${status} should not count as in-building stock`);
    assert.deepEqual(combination.assetNumbers, []);
  }
});

test("two in-building assets across included statuses do not appear as low stock", () => {
  const products = buildLowStockProducts([
    asset("1", "RES-1", "Reserved", "RATIONAL"),
    asset("2", "CLEAN-1", "Cleaning", "RATIONAL"),
  ]);

  assert.equal(
    products.some(
      (item) => item.model === "CM" && item.shopifySize === "6 x 1/1" && item.fuel === "E",
    ),
    false,
  );
});

test("Reserved counts as physical stock but remains unavailable for Shopify publishing", async () => {
  const restore = mockShopify([product("RES-1")]);
  const reservedAsset = asset("reserved-id", "RES-1", "Reserved", "RATIONAL");

  try {
    const lowStock = buildLowStockProducts([reservedAsset]).find(
      (item) => item.model === "CM" && item.shopifySize === "6 x 1/1" && item.fuel === "E",
    );
    assert.equal(lowStock?.physicalStockCount, 1);

    const overview = await getSyncOverview([reservedAsset]);
    assert.equal(
      overview.rows.find((row) => row.assetNumber === "RES-1")?.action,
      "unpublish",
    );
  } finally {
    restore();
  }
});

test("Refurbishment website gaps group missing and hidden listings by model, size, and fuel", async () => {
  const restore = mockShopify([
    product("REF-HIDDEN", "hidden-refurb", false),
    product("REF-VISIBLE", "visible-refurb", true),
    product("CMP-REF-HIDDEN", "hidden-cmp-refurb", false),
  ]);
  const assets = [
    asset("ref-1", "REF-1", "Refurbishment", "RATIONAL", "CM", "61", "Electric"),
    asset("ref-2", "REF-2", "Refurbishment", "RATIONAL", "CM", "61", "Electric"),
    asset("ref-hidden", "REF-HIDDEN", "Refurbishment", "RATIONAL", "CM", "61", "Electric"),
    asset("ref-visible", "REF-VISIBLE", "Refurbishment", "RATIONAL", "CM", "61", "Electric"),
    asset("ref-gas", "REF-GAS", "Refurbishment", "RATIONAL", "CM", "61", "Gas"),
    asset("cmp-ref-3", "CMP-REF-3", "Refurbishment", "RATIONAL", "CMP", "61", "Electric"),
    asset("cmp-ref-hidden", "CMP-REF-HIDDEN", "Refurbishment", "RATIONAL", "CMP", "61", "Electric"),
    asset("available", "AVAILABLE-1", "Available", "RATIONAL", "CM", "61", "Electric"),
    asset("booked", "BOOKED-1", "Booked", "RATIONAL", "CM", "61", "Electric"),
    asset("stacked-a", "4112", "Refurbishment", "RATIONAL", "CM", "61", "Electric"),
    asset("stacked-b", "4113", "Refurbishment", "RATIONAL", "CM", "61", "Electric"),
    asset("accessory", "REF-ACCESSORY", "Refurbishment", "Catercombi Accessory", "CM", "61", "Electric"),
  ];

  try {
    const overview = await getSyncOverview(assets);
    assert.deepEqual(overview.refurbishmentWebsiteGaps, [
      {
        key: '["rational","cm","61","gas"]',
        manufacturer: "RATIONAL",
        model: "CM",
        size: "61",
        fuel: "Gas",
        missingAssetNumbers: ["REF-GAS"],
        hiddenAssetNumbers: [],
      },
      {
        key: '["rational","cmp","61","electric"]',
        manufacturer: "RATIONAL",
        model: "CMP",
        size: "61",
        fuel: "Electric",
        missingAssetNumbers: ["CMP-REF-3"],
        hiddenAssetNumbers: ["CMP-REF-HIDDEN"],
      },
    ]);
    assert.equal(
      overview.refurbishmentWebsiteGaps.some((gap) => gap.model === "CM" && gap.fuel === "Electric"),
      false,
      "a visible listing for the same model, size, and fuel suppresses a misleading model gap",
    );
    assert.equal(
      overview.rows.some((row) => ["REF-1", "REF-2", "REF-GAS", "CMP-REF-3"].includes(row.assetNumber)),
      false,
      "unlisted Refurbishment assets stay out of the Shopify sync queue",
    );
  } finally {
    restore();
  }
});