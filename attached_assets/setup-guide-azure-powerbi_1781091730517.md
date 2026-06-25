# Setup Guide: Azure AD App for the Warehouse Wallboard

One app registration powers both the Microsoft Lists (Graph) and Power BI connections. You'll need someone with **Microsoft 365 admin rights** for steps 3 and 4 — everything else you can do yourself.

---

## 1. Create the app registration (~5 min)

1. Go to **entra.microsoft.com** → Identity → Applications → **App registrations** → **New registration**
2. Name: `CaterCombi Warehouse Wallboard`
3. Supported account types: **Accounts in this organizational directory only**
4. Redirect URI: leave blank → **Register**
5. From the Overview page, copy:
   - **Application (client) ID** → this is `CLIENT_ID`
   - **Directory (tenant) ID** → this is `TENANT_ID`

## 2. Create a client secret

1. In the app: **Certificates & secrets** → **New client secret**
2. Description: `wallboard`, expiry: 24 months
3. Copy the secret **Value** immediately (it's only shown once) → this is `CLIENT_SECRET`

## 3. Grant the Graph permission (admin needed)

1. In the app: **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions**
2. Search and tick **Sites.Read.All** → Add
3. An admin clicks **Grant admin consent for [your org]** — the status should turn to a green tick

> Tighter option: use `Sites.Selected` instead and grant the app access to only the one SharePoint site. More secure, but needs an extra Graph call by the admin to assign the site. `Sites.Read.All` is read-only across SharePoint and is fine for most setups.

## 4. Allow the app into Power BI (admin needed)

1. In **entra.microsoft.com**: create a **security group** (e.g. `PowerBI-API-Apps`) and add the app `CaterCombi Warehouse Wallboard` as a member
2. In **app.powerbi.com**: ⚙ Settings → **Admin portal** → **Tenant settings** → Developer settings → **Service principals can use Fabric APIs** → Enable → apply to **Specific security groups** → add `PowerBI-API-Apps`
3. Open the **workspace** that contains the engineer dashboard → **Manage access** → **Add people or groups** → add the app → role: **Viewer** (Viewer is enough for executeQueries as long as the app has Build permission on the dataset — if the query fails with 401, bump to **Member**)

## 5. Get the SharePoint site & list IDs

Easiest way — Graph Explorer (developer.microsoft.com/graph/graph-explorer), signed in with your work account:

1. Get the site ID:
   ```
   GET https://graph.microsoft.com/v1.0/sites/{yourtenant}.sharepoint.com:/sites/{SiteName}
   ```
   Copy the `id` field (a long comma-separated string) → `GRAPH_SITE_ID`
2. Get the list ID:
   ```
   GET https://graph.microsoft.com/v1.0/sites/{GRAPH_SITE_ID}/lists
   ```
   Find your asset List by `displayName`, copy its `id` → `GRAPH_LIST_ID`
3. While you're there, check the **internal column names**:
   ```
   GET https://graph.microsoft.com/v1.0/sites/{GRAPH_SITE_ID}/lists/{GRAPH_LIST_ID}/columns
   ```
   Look at the `name` field (not `displayName`) for Status, Shipping Date and Serial Number → these go into `COL_STATUS`, `COL_SHIPPING_DATE`, `COL_SERIAL`. Spaces in display names usually become `_x0020_` internally.

## 6. Get the Power BI workspace & dataset IDs

Open the dataset in app.powerbi.com — the URL looks like:
```
https://app.powerbi.com/groups/{PBI_WORKSPACE_ID}/datasets/{PBI_DATASET_ID}/...
```
Copy both GUIDs. Also note the **exact name of the measure** for the engineer daily average (open the report → hover the visual, or check the semantic model) → `PBI_MEASURE_NAME`.

## 7. Plug everything into Replit

In your Replit project: **Tools → Secrets**, add each variable from the prompt's env list. Never paste the client secret into the code or chat with Replit's AI — Secrets only.

---

## Quick test checklist

- `/api/health` returns OK for both Graph and Power BI
- Book a test pallet for today in Microsoft Lists → appears on the board within 60s
- Set an item to Priority → appears in the middle column
- The engineer average matches the figure in your Power BI report

## Common gotchas

- **403 from Graph** → admin consent not granted, or wrong site ID
- **400 "field not indexed"** → the List column isn't indexed; the prompt includes a fallback, but you can also index the Status column in List settings → Indexed columns
- **401 from executeQueries** → app not added to the workspace, or tenant setting (step 4.2) not enabled, or the security group is missing the app
- **executeQueries returns an error about the measure** → measure name mismatch; it's case-sensitive-ish and must exist in that exact dataset
- **Numbers a day out** → timezone; the build is told to use Europe/London but verify after BST/GMT changes
