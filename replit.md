# CaterCombi Warehouse Wallboard

A full-screen, TV-optimised dashboard that displays live operational data for the warehouse team — pallets shipping today, priority ovens, and engineer daily average. Runs permanently on a wall-mounted screen with no login or interaction required.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/wallboard run dev` — run the wallboard frontend
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 (`artifacts/api-server`)
- Frontend: React + Vite (`artifacts/wallboard`)
- Auth: `@azure/msal-node` — client credentials flow, one Azure AD app for both Graph + Power BI
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/api-client-react/src/generated/` — generated React Query hooks (do not hand-edit)
- `lib/api-zod/src/generated/` — generated Zod schemas used by the server
- `artifacts/api-server/src/lib/auth.ts` — MSAL token acquisition (Graph + Power BI)
- `artifacts/api-server/src/lib/graph.ts` — Microsoft Graph calls (shipping today, priority ovens)
- `artifacts/api-server/src/lib/powerbi.ts` — Power BI executeQueries (engineer daily avg, 15min cache)
- `artifacts/api-server/src/routes/dashboard.ts` — GET /api/dashboard
- `artifacts/api-server/src/routes/upstreamHealth.ts` — GET /api/health
- `artifacts/wallboard/src/` — React wallboard UI

## Required Secrets (set in Replit Secrets / Tools → Secrets)

```
TENANT_ID           Azure AD tenant ID
CLIENT_ID           Azure AD app client ID
CLIENT_SECRET       Azure AD app client secret
GRAPH_SITE_ID       SharePoint site ID
GRAPH_LIST_ID       SharePoint list ID
PBI_WORKSPACE_ID    Power BI workspace (group) ID
PBI_DATASET_ID      Power BI dataset ID
PBI_MEASURE_NAME    Exact DAX measure name (e.g. "Engineer Daily Average")
COL_STATUS          Internal List column name for status (default: Status)
COL_SHIPPING_DATE   Internal List column name for shipping date (default: ShippingDate)
COL_SERIAL          Internal List column name for serial number (default: SerialNumber)
```

See `attached_assets/setup-guide-azure-powerbi_*.md` for step-by-step Azure AD setup instructions.

## Architecture decisions

- Single Azure AD app registration covers both Microsoft Graph and Power BI scopes — simpler credential management.
- Graph data is cached 30 seconds server-side (protects against multiple wallboard screens hammering the API). Power BI value cached 15 minutes (only changes on dataset refresh).
- Dashboard route never returns an error response — returns last known good data on failure so the wallboard never shows a blank screen.
- Graph filter query is tried first with `HonorNonIndexedQueriesWarningMayFailRandomly` header; if it returns 400, falls back to fetching all items and filtering in Node.
- All "today" logic uses `Europe/London` timezone to handle BST/GMT transitions correctly.

## Product

- **Shipping Today**: items from Microsoft Lists where Status = "Booked" and Shipping Date = today (UK time). Shows asset title + serial number.
- **Priority Ovens**: items where Status = "Priority" OR (Status = "Booked" AND no serial number). Amber/orange accent to signal urgency.
- **Engineer Daily Average**: single number from Power BI DAX measure. Refreshed every 15 minutes.
- Frontend polls `/api/dashboard` every 60 seconds. Numbers animate on change. Cursor hides after 5s inactivity. Press `R` to force immediate refresh.

## Gotchas

- Column names in Microsoft Lists often differ from display names — always set `COL_STATUS`, `COL_SHIPPING_DATE`, `COL_SERIAL` env vars to match internal names (check via Graph Explorer).
- `PBI_MEASURE_NAME` is case-sensitive — must match the exact measure name in the Power BI semantic model.
- If Graph returns 403: admin consent not granted. If Power BI returns 401: app not added to workspace or tenant setting not enabled. See setup guide.
- After BST/GMT change, verify today's date boundary logic still works correctly (should be fine — using `toLocaleString` with `Europe/London`).

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Pointers

- See `attached_assets/setup-guide-azure-powerbi_*.md` for the full Azure AD + Power BI setup walkthrough.
- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
