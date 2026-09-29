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
    assert.equal(rationalCm.availableCount, 1);
    assert.deepEqual(rationalCm.assetNumbers, ["4111"]);
    assert.equal(
      lowStock.some((item) =>
        [...item.assetNumbers, ...item.recommendations.map((recommendation) => recommendation.assetNumber)]
          .some((number) => ["4112", "4113"].includes(number)),
      ),
      false,
    );
    assert.deepEqual(assets, originalAssets);
  } finally {
    restore();
  }
});