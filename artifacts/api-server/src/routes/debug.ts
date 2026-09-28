import { Router } from "express";

const router = Router();

const TENANT_ID = process.env["AZURE_TENANT_ID"] ?? "";
const CLIENT_ID = process.env["AZURE_CLIENT_ID"] ?? "";
const CLIENT_SECRET = process.env["AZURE_CLIENT_SECRET"] ?? "";
const SITE_NAME = process.env["SHAREPOINT_SITE_ID"] ?? "";
const LIST_NAME = process.env["SHAREPOINT_LIST_ID"] ?? "";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function getToken(): Promise<string> {
  const resp = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }).toString(),
  });
  const d = (await resp.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!d.access_token) throw new Error(`Token error: ${d.error} — ${d.error_description}`);
  return d.access_token;
}

async function g(token: string, path: string): Promise<unknown> {
  const r = await fetch(`${GRAPH_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.json();
}

router.get("/debug/sharepoint", async (_req, res): Promise<void> => {
  try {
    const token = await getToken();
    const root = (await g(token, "/sites/root")) as { siteCollection?: { hostname?: string }; id?: string };
    const hostname = root.siteCollection?.hostname ?? "UNKNOWN";

    const site = (await g(token, `/sites/${hostname}:/sites/${encodeURIComponent(SITE_NAME)}`)) as { id?: string; displayName?: string; error?: { message?: string } };
     if (!site.id) {
       res.json({ step: "site_lookup", error: site.error?.message, hostname, SITE_NAME });
       return;
     }

    const lists = (await g(token, `/sites/${site.id}/lists?$top=50&$select=id,name,displayName`)) as { value?: Array<{ id: string; name: string; displayName?: string }> };

    const listEncoded = encodeURIComponent(LIST_NAME);
    const items = (await g(token, `/sites/${site.id}/lists/${listEncoded}/items?expand=fields&$top=5`)) as { value?: unknown[]; error?: { message?: string } };

    res.json({
      ok: true,
      hostname,
      siteId: site.id,
      siteName: site.displayName,
      allLists: lists.value?.map((l) => ({ id: l.id, name: l.name, displayName: l.displayName })),
      listItemsPreview: items.value ?? { error: items.error?.message },
    });
   } catch (err: unknown) {
     res.status(500).json({ error: String(err) });
   }
});

export default router;
