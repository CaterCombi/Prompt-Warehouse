export type Asset = {
  id: string;
  assetNumber: string;
  status: string;
  manufacturer: string;
  model: string;
  size: string;
  fuel: string;
};

const SHOPIFY_API_VERSION = "2026-07";

type ShopifyAccessToken = {
  value: string;
  expiresAt: number;
};

let cachedAccessToken: ShopifyAccessToken | null = null;
let accessTokenRequest: Promise<string> | null = null;

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
};

type ShopContext = {
  shop: { name: string; myshopifyDomain: string };
  publications: { nodes: Array<{ id: string; name: string }> };
};

type ShopifyProduct = {
  id: string;
  title: string;
  status: string;
  published: boolean;
  publishedOnOnlineStore: boolean;
  skus: string[];
};

type ShopifyProductsResponse = {
  products: {
    nodes: Array<{
      id: string;
      title: string;
      status: string;
      publishedOnPublication: boolean;
      publishedOnOnlineStore: boolean;
      variants: { nodes: Array<{ sku: string | null }> };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export type SyncAction =
  | "ready"
  | "unpublish"
  | "publish"
  | "missing_in_shopify"
  | "missing_in_amt";

export type SyncRow = {
  key: string;
  assetNumber: string;
  assetStatus: string | null;
  manufacturer: string | null;
  model: string | null;
  size: string | null;
  shopifyProductId: string | null;
  shopifyProductTitle: string | null;
  shopifyProductStatus: string | null;
  shopifyPublished: boolean | null;
  action: SyncAction;
  reason: string;
};

export type SyncSummary = {
  amtTotal: number;
  amtAvailable: number;
  amtBooked: number;
  shopifyProducts: number;
  matched: number;
  readyToSell: number;
  needsUnpublish: number;
  needsPublish: number;
  missingInShopify: number;
  missingInAmt: number;
};

export type LowStockProduct = {
  key: string;
  brand: string;
  model: string;
  shopifySize: string;
  displaySection: "size" | "vents";
  amtSize: string;
  fuel: string;
  physicalStockCount: number;
  assetNumbers: string[];
};

export type SyncOverview = {
  checkedAt: string;
  shopName: string;
  shopDomain: string;
  publicationName: string;
  summary: SyncSummary;
  rows: SyncRow[];
  refurbishmentWebsiteGaps: RefurbishmentWebsiteGap[];
};

export type RefurbishmentWebsiteGap = {
  key: string;
  manufacturer: string;
  model: string;
  size: string;
  fuel: string;
  missingAssetNumbers: string[];
  hiddenAssetNumbers: string[];
};

export type SyncActionResult = {
  key: string;
  action: "unpublished" | "published" | "skipped" | "failed";
  message: string;
};

function getShopifyConfig() {
  const rawDomain = process.env["SHOPIFY_STORE_DOMAIN"]?.trim() ?? "";
  const shopDomain = rawDomain
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  const clientId = process.env["SHOPIFY_CLIENT_ID"]?.trim();
  const clientSecret = process.env["SHOPIFY_CLIENT_SECRET"]?.trim();

  if (!shopDomain || !clientId || !clientSecret) {
    throw new Error(
      "Shopify is not configured. Add SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET to Replit Secrets.",
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
    throw new Error("SHOPIFY_STORE_DOMAIN must be a valid myshopify.com domain.");
  }

  return { shopDomain, clientId, clientSecret };
}

async function requestShopifyAccessToken() {
  const { shopDomain, clientId, clientSecret } = getShopifyConfig();
  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`Shopify authentication failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as TokenResponse;
  if (!payload.access_token) {
    throw new Error("Shopify authentication returned no access token.");
  }

  const expiresInSeconds = payload.expires_in ?? 86_400;
  cachedAccessToken = {
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(expiresInSeconds - 300, 60) * 1000,
  };
  return cachedAccessToken.value;
}

async function getShopifyAccessToken(forceRefresh = false) {
  if (!forceRefresh && cachedAccessToken && cachedAccessToken.expiresAt > Date.now()) {
    return cachedAccessToken.value;
  }
  if (forceRefresh) cachedAccessToken = null;
  if (!accessTokenRequest) {
    accessTokenRequest = requestShopifyAccessToken().finally(() => {
      accessTokenRequest = null;
    });
  }
  return accessTokenRequest;
}

async function shopifyGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
  retryAuth = true,
): Promise<T> {
  const { shopDomain } = getShopifyConfig();
  const accessToken = await getShopifyAccessToken();
  const response = await fetch(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (retryAuth && (response.status === 401 || response.status === 403)) {
    await getShopifyAccessToken(true);
    return shopifyGraphql<T>(query, variables, false);
  }

  const payload = (await response.json()) as GraphqlResponse<T>;
  if (!response.ok || payload.errors?.length) {
    const message =
      payload.errors?.map((error) => error.message).filter(Boolean).join("; ") ||
      `Shopify request failed with status ${response.status}`;
    throw new Error(message);
  }
  if (!payload.data) {
    throw new Error("Shopify returned an empty response");
  }
  return payload.data;
}

async function getShopContext() {
  return shopifyGraphql<ShopContext>(`#graphql
    query SyncShopContext {
      shop { name myshopifyDomain }
      publications(first: 20) { nodes { id name } }
    }
  `);
}

function choosePublication(publications: Array<{ id: string; name: string }>) {
  return (
    publications.find((publication) =>
      publication.name.toLowerCase().includes("replit"),
    ) ??
    publications.find((publication) =>
      publication.name.toLowerCase().includes("online store"),
    ) ??
    publications[0] ??
    null
  );
}

async function getProducts(publicationId: string, onlineStorePublicationId: string) {
  const products: ShopifyProduct[] = [];
  let cursor: string | null = null;

  do {
    const data: ShopifyProductsResponse = await shopifyGraphql<ShopifyProductsResponse>(
      `#graphql
        query SyncProducts($after: String, $publicationId: ID!, $onlineStorePublicationId: ID!) {
          products(first: 250, after: $after) {
            nodes {
              id
              title
              status
              publishedOnPublication(publicationId: $publicationId)
              publishedOnOnlineStore: publishedOnPublication(publicationId: $onlineStorePublicationId)
              variants(first: 100) { nodes { sku } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      { after: cursor, publicationId, onlineStorePublicationId },
    );

    products.push(
      ...data.products.nodes.map((product) => ({
        id: product.id,
        title: product.title,
        status: product.status,
        published: product.publishedOnPublication,
        publishedOnOnlineStore: product.publishedOnOnlineStore,
        skus: product.variants.nodes
          .map((variant) => variant.sku?.trim())
          .filter((sku): sku is string => Boolean(sku)),
      })),
    );
    cursor = data.products.pageInfo.hasNextPage
      ? data.products.pageInfo.endCursor
      : null;
  } while (cursor);

  return products;
}

const RATIONAL_MODELS = ["CM", "CMP", "SCC", "SCC w.cc", "SCC WE"] as const;
const VENT_AMT_MODEL_VARIANTS = [
  "AOS Vent",
  "Combi Duo Vent",
  "iCombi Ultravent",
  "iCombi Vent",
  "SCC UltraVent",
  "SCC Ultravent Combi Duo",
  "SCC WE UltraVent",
  "SCC WE UltraVent Duo",
  "SCC WE UltraVent Duo Plus",
  "SCC WE UltraVent Plus",
  "SCC WE Vent",
  "SCCWE Ultravent",
  "Ultra Vent - iCombi",
  "Ultravent",
  "Ultravent Plus",
  "Ultravent Plus Duo",
  "Vent",
] as const;
const RATIONAL_SIZES = [
  { shopifySize: "6 x 1/1", amtSize: "61" },
  { shopifySize: "10 x 1/1", amtSize: "101" },
  { shopifySize: "20 x 1/1", amtSize: "201" },
  { shopifySize: "40 grid", amtSize: "202" },
] as const;
const RATIONAL_FUELS = ["E", "G"] as const;

const CONTROL_ROOM_IGNORED_ASSET_NUMBERS = new Set(["4112", "4113"]);
const CONTROL_ROOM_CATERCOMBI_ACCESSORY_ASSET_NUMBERS = new Set(["X367"]);

function normalized(value: string | null | undefined) {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isAvailable(asset: Asset) {
  const status = normalized(asset.status);
  if (status === "available") return true;
  if (status !== "reserved") return false;

  const manufacturer = normalized(asset.manufacturer);
  const model = normalized(asset.model);
  const isRationalCombiOven =
    manufacturer === "rational" &&
    RATIONAL_MODELS.some((candidate) => normalized(candidate) === model);
  const isVent = VENT_AMT_MODEL_VARIANTS.some(
    (candidate) => normalized(candidate) === model,
  );

  return isRationalCombiOven || isVent;
}

function availableStatusLabel(asset: Asset) {
  return normalized(asset.status) === "reserved"
    ? "Reserved in AMT (treated as Available)"
    : "Available in AMT";
}

const PHYSICAL_STOCK_STATUSES = new Set([
  "available",
  "priority",
  "cleaning",
  "on the bay",
  "refurbishment",
  "reserved",
]);
const MAX_LOW_STOCK_ASSETS_PER_VARIANT = 2;

function isPhysicalStock(asset: Asset) {
  return PHYSICAL_STOCK_STATUSES.has(normalized(asset.status));
}

function isCatercombiAccessory(asset: Asset) {
  return (
    CONTROL_ROOM_CATERCOMBI_ACCESSORY_ASSET_NUMBERS.has(asset.assetNumber.trim().toUpperCase()) ||
    /^catercombi accessor(?:y|ies)$/.test(normalized(asset.manufacturer))
  );
}

function isShopifyVisible(product: ShopifyProduct) {
  return product.published && normalized(product.status) === "active";
}

function isShopifyWebsiteVisible(product: ShopifyProduct) {
  return product.publishedOnOnlineStore && normalized(product.status) === "active";
}

function getControlRoomAssets(assets: Asset[]) {
  return assets.filter(
    (asset) => !CONTROL_ROOM_IGNORED_ASSET_NUMBERS.has(asset.assetNumber.trim()),
  );
}

function normalizedFuel(value: string | null | undefined) {
  const fuel = normalized(value);
  if (fuel === "e" || fuel.startsWith("electric")) return "E";
  if (fuel === "g" || fuel.startsWith("gas")) return "G";
  return fuel.toUpperCase();
}

function excludedFromMissingShopify(asset: Asset) {
  const manufacturer = normalized(asset.manufacturer);
  const model = normalized(asset.model);
  return (
    isCatercombiAccessory(asset) ||
    manufacturer === "accessory" ||
    manufacturer === "accessories" ||
    /(?:^|\W)ultra[\s-]*vents?(?:$|\W)/i.test(`${manufacturer} ${model}`)
  );
}

export function buildLowStockProducts(assets: Asset[]): LowStockProduct[] {
  const controlRoomAssets = getControlRoomAssets(assets);
  const mappings: Array<{
    brand: string;
    model: string;
    shopifySize: string;
    displaySection: LowStockProduct["displaySection"];
    amtSize: string;
    fuel: string;
  }> = RATIONAL_MODELS.flatMap((model) =>
    RATIONAL_SIZES.flatMap(({ shopifySize, amtSize }) =>
      RATIONAL_FUELS.map((fuel) => ({
        brand: "RATIONAL",
        model,
        shopifySize,
        displaySection: "size",
        amtSize,
        fuel,
      })),
    ),
  );
  mappings.push({
    brand: "RATIONAL",
    model: "SCC WE",
    shopifySize: "XS",
    displaySection: "size",
    amtSize: "XS",
    fuel: "E",
  });

  const ventModelByNormalized = new Map(
    VENT_AMT_MODEL_VARIANTS.map((model) => [normalized(model), model]),
  );
  const ventVariantMappings = new Map<string, (typeof mappings)[number]>();
  for (const asset of controlRoomAssets) {
    const model = ventModelByNormalized.get(normalized(asset.model));
    const brand = asset.manufacturer.trim();
    if (!model || !brand) continue;

    const amtSize = asset.size.trim();
    const fuel = normalizedFuel(asset.fuel);
    const key = JSON.stringify([normalized(brand), model, amtSize, fuel]);
    if (!ventVariantMappings.has(key)) {
      ventVariantMappings.set(key, {
        brand,
        model,
        shopifySize: "XS",
        displaySection: "vents",
        amtSize,
        fuel,
      });
    }
  }
  mappings.push(...ventVariantMappings.values());

  return mappings
    .map((mapping) => {
      const matchingAssets = controlRoomAssets.filter(
        (asset) =>
          normalized(asset.manufacturer) === normalized(mapping.brand) &&
          normalized(asset.model) === normalized(mapping.model) &&
          normalized(asset.size) === normalized(mapping.amtSize) &&
          normalizedFuel(asset.fuel) === mapping.fuel,
      );
      const physicalAssets = matchingAssets.filter(isPhysicalStock);

      return {
        key: [
          mapping.brand,
          mapping.model,
          mapping.shopifySize,
          mapping.displaySection,
          mapping.amtSize,
          mapping.fuel,
        ].join(":"),
        ...mapping,
        physicalStockCount: physicalAssets.length,
        assetNumbers: physicalAssets.map((asset) => asset.assetNumber).sort(),
        amtAssetCount: matchingAssets.length,
      };
    })
    .filter((product) => product.physicalStockCount <= MAX_LOW_STOCK_ASSETS_PER_VARIANT && product.amtAssetCount > 0)
    .map(({ amtAssetCount: _amtAssetCount, ...product }) => product)
    .sort(
      (a, b) =>
        a.model.localeCompare(b.model) ||
        a.shopifySize.localeCompare(b.shopifySize, undefined, { numeric: true }) ||
        a.amtSize.localeCompare(b.amtSize, undefined, { numeric: true }) ||
        a.fuel.localeCompare(b.fuel),
    );
}

function buildRows(assets: Asset[], products: ShopifyProduct[]): SyncRow[] {
  const productsBySku = new Map<string, ShopifyProduct>();
  for (const product of products) {
    for (const sku of product.skus) {
      productsBySku.set(sku.toLowerCase(), product);
    }
  }

  const matchedProductIds = new Set<string>();
  const rows: SyncRow[] = [];

  for (const asset of assets) {
    const product = productsBySku.get(asset.assetNumber.trim().toLowerCase());
    if (!product && !isAvailable(asset)) continue;

    if (!product) {
      if (excludedFromMissingShopify(asset)) continue;
      rows.push({
        key: `amt:${asset.id}`,
        assetNumber: asset.assetNumber,
        assetStatus: asset.status,
        manufacturer: asset.manufacturer,
        model: asset.model,
        size: asset.size,
        shopifyProductId: null,
        shopifyProductTitle: null,
        shopifyProductStatus: null,
        shopifyPublished: null,
        action: "missing_in_shopify",
        reason: `${availableStatusLabel(asset)} but no Shopify product uses this asset number as its SKU.`,
      });
      continue;
    }

    matchedProductIds.add(product.id);
    if (isCatercombiAccessory(asset)) continue;
    const available = isAvailable(asset);
    const shopifyVisible = isShopifyVisible(product);
    const action = available
      ? shopifyVisible
        ? "ready"
        : "publish"
      : shopifyVisible
        ? "unpublish"
        : "ready";
    const availabilityLabel = availableStatusLabel(asset);
    const reason = available
      ? shopifyVisible
        ? `${availabilityLabel} and published on Shopify.`
        : `${availabilityLabel} but not currently published on Shopify.`
      : shopifyVisible
        ? `AMT status is ${asset.status}; Shopify product should be hidden.`
        : `AMT status is ${asset.status}; Shopify product is already hidden.`;

    rows.push({
      key: `match:${asset.id}:${product.id}`,
      assetNumber: asset.assetNumber,
      assetStatus: asset.status,
      manufacturer: asset.manufacturer,
      model: asset.model,
      size: asset.size,
      shopifyProductId: product.id,
      shopifyProductTitle: product.title,
      shopifyProductStatus: product.status,
        shopifyPublished: shopifyVisible,
      action,
      reason,
    });
  }

  for (const product of products) {
    if (matchedProductIds.has(product.id)) continue;
    if (
      product.skus.length > 0 &&
      product.skus.every((sku) =>
        CONTROL_ROOM_IGNORED_ASSET_NUMBERS.has(sku.trim()),
      )
    ) {
      continue;
    }
    rows.push({
      key: `shopify:${product.id}`,
      assetNumber: product.skus[0] ?? "No SKU",
      assetStatus: null,
      manufacturer: null,
      model: null,
      size: null,
      shopifyProductId: product.id,
      shopifyProductTitle: product.title,
      shopifyProductStatus: product.status,
      shopifyPublished: isShopifyVisible(product),
      action: "missing_in_amt",
      reason: "Shopify product has no matching AMT asset number.",
    });
  }

  return rows.sort((a, b) => {
    const order: Record<SyncAction, number> = {
      unpublish: 0,
      publish: 1,
      missing_in_shopify: 2,
      missing_in_amt: 3,
      ready: 4,
    };
    return order[a.action] - order[b.action] || a.assetNumber.localeCompare(b.assetNumber);
  });
}

export function buildRefurbishmentWebsiteGaps(
  assets: Asset[],
  products: ShopifyProduct[],
): RefurbishmentWebsiteGap[] {
  const productsBySku = new Map<string, ShopifyProduct>();
  for (const product of products) {
    for (const sku of product.skus) {
      productsBySku.set(sku.toLowerCase(), product);
    }
  }

  const controlRoomAssets = getControlRoomAssets(assets);
  const getModelVariant = (asset: Asset) => {
    const manufacturer = asset.manufacturer.trim();
    const model = asset.model.trim();
    const size = asset.size.trim();
    const fuel = asset.fuel.trim();
    const identity = [
      manufacturer ? normalized(manufacturer) : `unknown-manufacturer-${asset.id}`,
      model ? normalized(model) : `unknown-model-${asset.id}`,
      size ? normalized(size) : `unknown-size-${asset.id}`,
      fuel ? normalized(fuel) : `unknown-fuel-${asset.id}`,
    ];

    return {
      key: JSON.stringify(identity),
      manufacturer: manufacturer || "Manufacturer not recorded",
      model: model || "Model details incomplete",
      size: size || "Size not recorded",
      fuel: fuel || "Fuel not recorded",
    };
  };
  const visibleModelVariants = new Set<string>();
  for (const asset of controlRoomAssets) {
    if (
      normalized(asset.manufacturer) !== "rational" ||
      excludedFromMissingShopify(asset)
    ) {
      continue;
    }
    const product = productsBySku.get(asset.assetNumber.trim().toLowerCase());
    if (product && isShopifyWebsiteVisible(product)) {
      visibleModelVariants.add(getModelVariant(asset).key);
    }
  }

  const gaps = new Map<string, RefurbishmentWebsiteGap>();
  for (const asset of controlRoomAssets) {
    if (
      normalized(asset.manufacturer) !== "rational" ||
      normalized(asset.status) !== "refurbishment" ||
      excludedFromMissingShopify(asset)
    ) {
      continue;
    }

    const modelVariant = getModelVariant(asset);
    if (visibleModelVariants.has(modelVariant.key)) continue;

    const product = productsBySku.get(asset.assetNumber.trim().toLowerCase());
    const gap = gaps.get(modelVariant.key) ?? {
      ...modelVariant,
      missingAssetNumbers: [],
      hiddenAssetNumbers: [],
    };

    if (product) {
      gap.hiddenAssetNumbers.push(asset.assetNumber);
    } else {
      gap.missingAssetNumbers.push(asset.assetNumber);
    }
    gaps.set(modelVariant.key, gap);
  }

  return Array.from(gaps.values())
    .map((gap) => ({
      ...gap,
      missingAssetNumbers: gap.missingAssetNumbers.sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      ),
      hiddenAssetNumbers: gap.hiddenAssetNumbers.sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      ),
    }))
    .sort(
      (a, b) =>
        a.manufacturer.localeCompare(b.manufacturer) ||
        a.model.localeCompare(b.model) ||
        a.size.localeCompare(b.size, undefined, { numeric: true }) ||
        a.fuel.localeCompare(b.fuel),
    );
}

function summarize(assets: Asset[], products: ShopifyProduct[], rows: SyncRow[]): SyncSummary {
  return {
    amtTotal: assets.length,
    amtAvailable: assets.filter(isAvailable).length,
    amtBooked: assets.filter((asset) => asset.status.trim().toLowerCase() === "booked").length,
    shopifyProducts: products.length,
    matched: rows.filter((row) => row.shopifyProductId && row.action !== "missing_in_amt").length,
    readyToSell: rows.filter((row) => row.action === "ready" && isAvailable({ status: row.assetStatus ?? "" } as Asset)).length,
    needsUnpublish: rows.filter((row) => row.action === "unpublish").length,
    needsPublish: rows.filter((row) => row.action === "publish").length,
    missingInShopify: rows.filter((row) => row.action === "missing_in_shopify").length,
    missingInAmt: rows.filter((row) => row.action === "missing_in_amt").length,
  };
}

async function loadComparison(assets: Asset[]) {
  const controlRoomAssets = getControlRoomAssets(assets);
  const context = await getShopContext();
  const { shopDomain } = getShopifyConfig();
  if (context.shop.myshopifyDomain.toLowerCase() !== shopDomain) {
    throw new Error(
      `Shopify credentials returned ${context.shop.myshopifyDomain}, not the configured ${shopDomain}.`,
    );
  }
  const publication = choosePublication(context.publications.nodes);
  if (!publication) {
    throw new Error("Shopify has no storefront publication available for syncing.");
  }

  const onlineStorePublication =
    context.publications.nodes.find(
      (candidate) => candidate.name.trim().toLowerCase() === "online store",
    ) ?? publication;
  const products = await getProducts(publication.id, onlineStorePublication.id);
  const rows = buildRows(controlRoomAssets, products);
  return {
    context,
    publication,
    products,
    rows,
    summary: summarize(controlRoomAssets, products, rows),
  };
}

export async function getSyncOverview(assets: Asset[]): Promise<SyncOverview> {
  const { context, publication, products, rows, summary } = await loadComparison(assets);
  return {
    checkedAt: new Date().toISOString(),
    shopName: context.shop.name,
    shopDomain: context.shop.myshopifyDomain,
    publicationName: publication.name,
    summary,
    rows,
    refurbishmentWebsiteGaps: buildRefurbishmentWebsiteGaps(assets, products),
  };
}

async function setPublication(productId: string, publicationId: string, publish: boolean) {
  const mutation = publish
    ? `#graphql
      mutation PublishProduct($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          userErrors { field message }
        }
      }
    `
    : `#graphql
      mutation UnpublishProduct($id: ID!, $input: [PublicationInput!]!) {
        publishableUnpublish(id: $id, input: $input) {
          userErrors { field message }
        }
      }
    `;
  const data = await shopifyGraphql<{
    publishablePublish?: { userErrors: Array<{ message: string }> };
    publishableUnpublish?: { userErrors: Array<{ message: string }> };
  }>(mutation, { id: productId, input: [{ publicationId }] });
  const errors =
    data.publishablePublish?.userErrors ?? data.publishableUnpublish?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
}

export async function runSync(assets: Asset[]) {
  const comparison = await loadComparison(assets);
  const actions: SyncActionResult[] = [];

  for (const row of comparison.rows) {
    if (!row.shopifyProductId || !["publish", "unpublish"].includes(row.action)) {
      actions.push({
        key: row.key,
        action: "skipped",
        message: row.reason,
      });
      continue;
    }

    try {
      await setPublication(
        row.shopifyProductId,
        comparison.publication.id,
        row.action === "publish",
      );
      actions.push({
        key: row.key,
        action: row.action === "publish" ? "published" : "unpublished",
        message:
          row.action === "publish"
            ? "Published because AMT marks the asset Available."
            : `Unpublished because AMT marks the asset ${row.assetStatus}.`,
      });
    } catch (error) {
      actions.push({
        key: row.key,
        action: "failed",
        message: error instanceof Error ? error.message : "Shopify update failed.",
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    summary: comparison.summary,
    actions,
  };
}