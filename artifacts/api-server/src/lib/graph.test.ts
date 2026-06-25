import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("./auth", () => ({
  getGraphToken: vi.fn().mockResolvedValue("mock-token"),
}));

vi.mock("./logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { getShippingToday, getPriorityOvens } from "./graph";

// ---------------------------------------------------------------------------
// Mirror the column names that graph.ts captures at module load time.
// graph.ts reads these once via process.env at import; tests must use the
// same names when building mock field objects so mapItem() finds the values.
// ---------------------------------------------------------------------------
const COL_STATUS = process.env["COL_STATUS"] ?? "Status";
const COL_SHIPPING_DATE = process.env["COL_SHIPPING_DATE"] ?? "ShippingDate";
const COL_SERIAL = process.env["COL_SERIAL"] ?? "SerialNumber";

// ---------------------------------------------------------------------------
// Mirror the ukToday() logic so test timestamps always align with production.
// We cannot import ukToday() (it's not exported), so we replicate it here.
// ---------------------------------------------------------------------------
function getUKTodayWindow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);

  const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const londonNoonHour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "numeric",
      hour12: false,
    }).format(noonUTC)
  );
  const offsetHours = londonNoonHour - 12;
  const todayStart = new Date(Date.UTC(y, m - 1, d, -offsetHours, 0, 0));
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  return {
    // Ten hours into today — always within today's window
    todayMidTs: new Date(todayStart.getTime() + 10 * 60 * 60 * 1000).toISOString(),
    // One second before today's window starts
    yesterdayTs: new Date(todayStart.getTime() - 1000).toISOString(),
    // Exactly at tomorrow midnight — excluded by strict lt
    tomorrowTs: tomorrowStart.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Graph-style fields object using the real column names from env vars
 * so that mapItem() inside graph.ts correctly reads each field.
 */
function fields(overrides: {
  Title?: string;
  status?: string;
  shippingDate?: string | null;
  serial?: string | null;
  Manufacturer?: string;
  Model?: string;
  Size?: string;
  Fuel?: string;
  Urgency?: string;
} = {}): Record<string, unknown> {
  return {
    Title: overrides.Title ?? "Test Oven",
    [COL_STATUS]: overrides.status ?? "",
    [COL_SHIPPING_DATE]: overrides.shippingDate ?? null,
    [COL_SERIAL]: overrides.serial ?? null,
    ...(overrides.Manufacturer !== undefined ? { Manufacturer: overrides.Manufacturer } : {}),
    ...(overrides.Model !== undefined ? { "Manufacturer_x002e_": overrides.Model } : {}),
    ...(overrides.Size !== undefined ? { Size: overrides.Size } : {}),
    ...(overrides.Fuel !== undefined ? { Fuel: overrides.Fuel } : {}),
    ...(overrides.Urgency !== undefined ? { Urgency: overrides.Urgency } : {}),
  };
}

function listResponse(items: Record<string, unknown>[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ value: items.map((f) => ({ fields: f })) }),
    text: async () => "",
  } as unknown as Response;
}

function errorResponse(status: number) {
  return {
    ok: false,
    status,
    text: async () => `HTTP ${status}`,
    headers: { get: () => null },
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

// ---------------------------------------------------------------------------
// getShippingToday — filtered query URL assertions
// Verify the outgoing Graph request includes the required filter clauses.
// These tests catch regressions like removing the Booked filter or date window.
// ---------------------------------------------------------------------------
describe("getShippingToday — filtered query URL shape", () => {
  function captureUrl(): { mockFetch: ReturnType<typeof vi.fn>; capturedUrl: () => string | undefined } {
    let captured: string | undefined;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      captured = url;
      return listResponse([]);
    });
    vi.stubGlobal("fetch", mockFetch);
    return { mockFetch, capturedUrl: () => captured };
  }

  it("sends Status eq 'Booked' in the Graph filter query", async () => {
    const { capturedUrl } = captureUrl();

    await getShippingToday();

    expect(capturedUrl()).toContain("Status eq 'Booked'");
  });

  it("sends a ge (greater-than-or-equal) date clause for the start of today", async () => {
    const { capturedUrl } = captureUrl();

    await getShippingToday();

    expect(capturedUrl()).toMatch(/ge '[\d]{4}-[\d]{2}-[\d]{2}T[\d]{2}:[\d]{2}:[\d]{2}/);
  });

  it("sends a lt (less-than) date clause for the start of tomorrow", async () => {
    const { capturedUrl } = captureUrl();

    await getShippingToday();

    expect(capturedUrl()).toMatch(/lt '[\d]{4}-[\d]{2}-[\d]{2}T[\d]{2}:[\d]{2}:[\d]{2}/);
  });

  it("uses the correct shipping-date column name from env vars in the filter", async () => {
    const { capturedUrl } = captureUrl();

    await getShippingToday();

    expect(capturedUrl()).toContain(`fields/${COL_SHIPPING_DATE}`);
  });
});

// ---------------------------------------------------------------------------
// getShippingToday — filtered path (Graph returns 200 directly)
// ---------------------------------------------------------------------------
describe("getShippingToday — filtered path (200 OK from Graph)", () => {
  it("returns a Booked item with today's shipping date", async () => {
    const { todayMidTs } = getUKTodayWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        listResponse([fields({ Title: "Oven A", status: "Booked", shippingDate: todayMidTs })])
      )
    );

    const result = await getShippingToday();

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Oven A");
    expect(result[0].status).toBe("Booked");
  });

  it("returns an empty array when Graph returns no items", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(listResponse([])));

    const result = await getShippingToday();

    expect(result).toHaveLength(0);
  });

  it("maps serial, manufacturer, model, size, fuel, urgency fields", async () => {
    const { todayMidTs } = getUKTodayWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        listResponse([
          fields({
            status: "Booked",
            shippingDate: todayMidTs,
            serial: "SN-001",
            Manufacturer: "Acme",
            Model: "ModelX",
            Size: "Large",
            Fuel: "Gas",
            Urgency: "Urgent",
          }),
        ])
      )
    );

    const [item] = await getShippingToday();

    expect(item.serial).toBe("SN-001");
    expect(item.manufacturer).toBe("Acme");
    expect(item.model).toBe("ModelX");
    expect(item.size).toBe("Large");
    expect(item.fuel).toBe("Gas");
    expect(item.urgency).toBe("Urgent");
  });
});

// ---------------------------------------------------------------------------
// getShippingToday — fallback path (Graph returns 400, Node-side filtering)
// ---------------------------------------------------------------------------
describe("getShippingToday — fallback path (Graph returns 400, Node filters)", () => {
  function setupFallback(allItems: Record<string, unknown>[]) {
    // First call: filtered query → 400 triggers the filter_unsupported fallback.
    // Subsequent calls: full-list pagination fetch returns all items.
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(errorResponse(400))
        .mockResolvedValue(listResponse(allItems))
    );
  }

  it("includes a Booked item with today's shipping date", async () => {
    const { todayMidTs } = getUKTodayWindow();
    setupFallback([fields({ status: "Booked", shippingDate: todayMidTs })]);

    const result = await getShippingToday();

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("Booked");
  });

  it("excludes a non-Booked item even when shipping date is today", async () => {
    const { todayMidTs } = getUKTodayWindow();
    setupFallback([
      fields({ status: "Priority", shippingDate: todayMidTs }),
      fields({ status: "Pending", shippingDate: todayMidTs }),
    ]);

    const result = await getShippingToday();

    expect(result).toHaveLength(0);
  });

  it("excludes a Booked item with yesterday's shipping date", async () => {
    const { yesterdayTs } = getUKTodayWindow();
    setupFallback([fields({ status: "Booked", shippingDate: yesterdayTs })]);

    const result = await getShippingToday();

    expect(result).toHaveLength(0);
  });

  it("excludes a Booked item whose shipping date falls exactly at tomorrow's boundary", async () => {
    const { tomorrowTs } = getUKTodayWindow();
    setupFallback([fields({ status: "Booked", shippingDate: tomorrowTs })]);

    const result = await getShippingToday();

    expect(result).toHaveLength(0);
  });

  it("excludes a Booked item with no shipping date", async () => {
    setupFallback([fields({ status: "Booked", shippingDate: null })]);

    const result = await getShippingToday();

    expect(result).toHaveLength(0);
  });

  it("returns only today-and-Booked items from a mixed list", async () => {
    const { todayMidTs, yesterdayTs, tomorrowTs } = getUKTodayWindow();
    setupFallback([
      fields({ Title: "Include — booked today", status: "Booked", shippingDate: todayMidTs }),
      fields({ Title: "Exclude — Priority today", status: "Priority", shippingDate: todayMidTs }),
      fields({ Title: "Exclude — booked yesterday", status: "Booked", shippingDate: yesterdayTs }),
      fields({ Title: "Exclude — booked tomorrow", status: "Booked", shippingDate: tomorrowTs }),
      fields({ Title: "Exclude — booked no date", status: "Booked", shippingDate: null }),
    ]);

    const result = await getShippingToday();

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Include — booked today");
  });
});

// ---------------------------------------------------------------------------
// getPriorityOvens
// ---------------------------------------------------------------------------
describe("getPriorityOvens", () => {
  function setupAllItems(items: Record<string, unknown>[]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(listResponse(items)));
  }

  it("includes an item with Status = Priority", async () => {
    setupAllItems([fields({ status: "Priority" })]);

    const result = await getPriorityOvens();

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("Priority");
  });

  it("includes a Booked item with no serial number (null)", async () => {
    setupAllItems([fields({ status: "Booked", serial: null })]);

    const result = await getPriorityOvens();

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("Booked");
  });

  it("includes a Booked item whose serial is blank/whitespace (treated as missing)", async () => {
    setupAllItems([fields({ status: "Booked", serial: "   " })]);

    const result = await getPriorityOvens();

    expect(result).toHaveLength(1);
  });

  it("excludes a Booked item that has a real serial number", async () => {
    setupAllItems([fields({ status: "Booked", serial: "SN-123" })]);

    const result = await getPriorityOvens();

    expect(result).toHaveLength(0);
  });

  it("excludes items that are neither Priority nor Booked-without-serial", async () => {
    setupAllItems([
      fields({ status: "Completed" }),
      fields({ status: "Pending" }),
      fields({ status: "Booked", serial: "SN-999" }),
    ]);

    const result = await getPriorityOvens();

    expect(result).toHaveLength(0);
  });

  it("includes a Booked item with Urgency = 'Urgent'", async () => {
    setupAllItems([fields({ status: "Booked", Urgency: "Urgent" })]);

    const result = await getPriorityOvens();

    expect(result).toHaveLength(1);
  });

  it("includes a Priority item with Urgency = 'Urgent'", async () => {
    setupAllItems([fields({ status: "Priority", Urgency: "Urgent" })]);

    const result = await getPriorityOvens();

    expect(result).toHaveLength(1);
  });

  it("excludes a Completed item even when Urgency = 'Urgent' (status must be Booked or Priority)", async () => {
    setupAllItems([fields({ status: "Completed", Urgency: "Urgent" })]);

    const result = await getPriorityOvens();

    expect(result).toHaveLength(0);
  });

  it("matches Urgency case-insensitively for Booked items (e.g. 'URGENT', 'urgent')", async () => {
    setupAllItems([
      fields({ status: "Booked", Urgency: "URGENT" }),
      fields({ status: "Priority", Urgency: "urgent" }),
    ]);

    const result = await getPriorityOvens();

    expect(result).toHaveLength(2);
  });

  it("sorts: Booked+Urgent → Priority+Urgent → Priority → Booked-without-serial", async () => {
    setupAllItems([
      fields({ Title: "D — Booked no serial", status: "Booked", serial: null }),
      fields({ Title: "C — Priority plain", status: "Priority" }),
      fields({ Title: "B — Priority urgent", status: "Priority", Urgency: "Urgent" }),
      fields({ Title: "A — Booked urgent", status: "Booked", Urgency: "Urgent" }),
    ]);

    const result = await getPriorityOvens();

    expect(result).toHaveLength(4);
    expect(result[0].title).toBe("A — Booked urgent");
    expect(result[1].title).toBe("B — Priority urgent");
    expect(result[2].title).toBe("C — Priority plain");
    expect(result[3].title).toBe("D — Booked no serial");
  });

  it("returns empty array when no items match priority criteria", async () => {
    setupAllItems([
      fields({ status: "Completed" }),
      fields({ status: "Booked", serial: "SN-1" }),
    ]);

    const result = await getPriorityOvens();

    expect(result).toHaveLength(0);
  });
});
