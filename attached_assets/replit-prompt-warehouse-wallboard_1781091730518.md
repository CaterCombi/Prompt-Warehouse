# Replit AI Prompt: CaterCombi Warehouse Wallboard

Build a full-screen "wallboard" dashboard web app for the warehouse team at CaterCombi, a UK-based specialist in refurbished commercial combi ovens. The app will run permanently on a large wall-mounted screen — no login, no mouse interaction needed. It displays live operational data pulled from Microsoft Lists (via Microsoft Graph API) and one figure from Power BI (via the Power BI REST API).

**Stack:** Node.js + Express backend, vanilla JS (or lightweight React) frontend. The backend handles all API authentication — no credentials ever reach the browser.

---

## Backend

### Authentication
Use `@azure/msal-node` with the **client credentials flow** (a single Azure AD app registration covers both APIs). Acquire two separate tokens:

- Microsoft Graph scope: `https://graph.microsoft.com/.default`
- Power BI scope: `https://analysis.windows.net/powerbi/api/.default`

Read all credentials and IDs from environment variables (Replit Secrets):

```
TENANT_ID=
CLIENT_ID=
CLIENT_SECRET=
GRAPH_SITE_ID=          # SharePoint site hosting the Microsoft List
GRAPH_LIST_ID=          # the asset management List
PBI_WORKSPACE_ID=       # Power BI workspace (group) ID
PBI_DATASET_ID=         # dataset containing the engineer average measure
PBI_MEASURE_NAME=Engineer Daily Average   # placeholder — replace with real measure name
COL_STATUS=Status               # internal column name in the List — replace if different
COL_SHIPPING_DATE=ShippingDate  # internal column name — replace if different
COL_SERIAL=SerialNumber         # internal column name — replace if different
```

Cache MSAL tokens and reuse until near expiry.

### API endpoint
Expose a single endpoint `GET /api/dashboard` returning JSON:

```json
{
  "shippingToday": [ { "title": "...", "status": "Booked", "shippingDate": "...", "serial": "..." } ],
  "priorityOvens": [ { "title": "...", "status": "...", "serial": null } ],
  "engineerDailyAverage": 4.2,
  "lastUpdated": "ISO timestamp",
  "powerBiLastFetched": "ISO timestamp"
}
```

### Section 1 — Pallets / Assets Shipping Today (Microsoft Graph)
Query the List items where **Status = "Booked" AND Shipping Date = today** (today in UK time, Europe/London — be careful with date-only comparison vs ISO datetimes; filter on the date portion).

Use:
```
GET https://graph.microsoft.com/v1.0/sites/{GRAPH_SITE_ID}/lists/{GRAPH_LIST_ID}/items?expand=fields&$filter=fields/{COL_STATUS} eq 'Booked' and fields/{COL_SHIPPING_DATE} ge '{todayT00:00:00Z}' and fields/{COL_SHIPPING_DATE} lt '{tomorrowT00:00:00Z}'
```
Include the header `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly` in case the filtered columns are not indexed. If the filter fails (400 error), fall back to fetching all items with `expand=fields` and filtering in Node — page through with `@odata.nextLink` if necessary.

### Section 2 — Priority Ovens (Microsoft Graph)
Items where **(Status = "Booked" AND Serial Number is empty) OR Status = "Priority"**.

Graph's `$filter` support for OR-across-fields and null checks on list columns is unreliable, so for this section fetch items and apply the logic in Node:
- `status === 'Priority'`, OR
- `status === 'Booked'` AND (`serial` is null, undefined, or empty/whitespace string)

### Section 3 — Engineer Daily Average (Power BI REST API)
Call the executeQueries endpoint:

```
POST https://api.powerbi.com/v1.0/myorg/groups/{PBI_WORKSPACE_ID}/datasets/{PBI_DATASET_ID}/executeQueries
```
Body:
```json
{
  "queries": [
    { "query": "EVALUATE ROW(\"avg\", [Engineer Daily Average])" }
  ],
  "serializerSettings": { "includeNulls": true }
}
```
(Substitute the measure name from `PBI_MEASURE_NAME` into the DAX string.) Parse the single value from `results[0].tables[0].rows[0]`. Round to 1 decimal place.

### Polling & caching strategy
- The frontend polls `/api/dashboard` every **60 seconds**.
- The backend queries Microsoft Graph fresh on each poll (or with a 30s in-memory cache to protect against multiple screens).
- The backend caches the **Power BI value for 15 minutes** — it only changes on dataset refresh, so don't hammer the API.
- If any upstream call fails, **return the last known good data** with the old `lastUpdated` timestamp rather than an error — the wallboard must never show a blank screen. Log errors server-side.

---

## Frontend — Wallboard Design

Design for a large TV viewed from across a warehouse. Everything must be readable from 10 metres.

**Brand:** CaterCombi — primary blue `#04659b`, dark background `#0d1117`, white/near-white text, font **DM Sans** (Google Fonts), bold weights.

**Layout:** full viewport, no scrolling, three sections:

1. **Left column (~40% width): "SHIPPING TODAY"** — a huge count badge at the top (e.g. "7") and a list of asset titles below. Each row shows the asset name/title and serial number in large type (min ~28px). If more rows than fit on screen, auto-cycle/scroll through them every 8 seconds with a smooth transition.
2. **Middle column (~40%): "PRIORITY OVENS"** — same pattern. Use an amber/orange accent (`#e8833a` or similar) for this section header and count badge to signal urgency. Rows with Status = "Priority" get a small flag/badge.
3. **Right column (~20%): "ENGINEER DAILY AVERAGE"** — one enormous number (think 120px+), centred vertically, with a label underneath: "ovens fixed / engineer / day". Blue accent.

**Header bar:** CaterCombi name/logo placeholder on the left, a large live clock (HH:MM, Europe/London) and today's date on the right.

**Footer / status strip:** small "Last updated HH:MM:SS" text. If data is older than 3 minutes (polling has been failing), show a subtle amber "⚠ Live data delayed" indicator — never an error wall.

**Behaviour:**
- Auto-refresh data every 60s via `fetch` — no page reloads, smooth DOM updates only (no flicker).
- Numbers animate (count up/down) when they change.
- Empty states: if a section has zero items, show a calm "Nothing scheduled" / "No priority ovens 🎉" message in muted text — not an error.
- Dark theme only. No interactive controls visible. Cursor auto-hides after 5 seconds of inactivity.
- Add a hidden keyboard shortcut `R` to force an immediate refresh (useful when testing).

**Performance:** loads instantly, no heavy animation libraries, works smoothly on a basic media-player PC or Raspberry Pi browser in kiosk mode.

---

## Important build notes

- Never expose `CLIENT_SECRET` or any token to the frontend — all upstream calls go through the Express backend.
- Microsoft Lists internal column names often differ from display names (e.g. a column displayed as "Shipping Date" may internally be `ShippingDate` or `Shipping_x0020_Date`). The column names are configurable via env vars for this reason — do not hardcode them elsewhere.
- Handle Graph API throttling (429) with a single retry honouring the `Retry-After` header.
- Timezone: all "today" logic in **Europe/London**, not UTC.
- Provide a `/api/health` endpoint returning status of both upstream connections, for troubleshooting.
