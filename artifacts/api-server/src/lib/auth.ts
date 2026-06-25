import * as msal from "@azure/msal-node";
import { logger } from "./logger";

const tenantId = process.env["TENANT_ID"];
const clientId = process.env["CLIENT_ID"];
const clientSecret = process.env["CLIENT_SECRET"];

let graphApp: msal.ConfidentialClientApplication | null = null;
let powerBiApp: msal.ConfidentialClientApplication | null = null;

function getGraphApp(): msal.ConfidentialClientApplication {
  if (!graphApp) {
    if (!tenantId || !clientId || !clientSecret) {
      throw new Error("Missing Azure AD credentials: TENANT_ID, CLIENT_ID, CLIENT_SECRET");
    }
    graphApp = new msal.ConfidentialClientApplication({
      auth: {
        clientId,
        clientSecret,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
      system: {
        loggerOptions: {
          loggerCallback: (level, message) => {
            if (level === msal.LogLevel.Error) {
              logger.error({ message }, "MSAL Graph error");
            }
          },
          piiLoggingEnabled: false,
          logLevel: msal.LogLevel.Error,
        },
      },
    });
  }
  return graphApp;
}

function getPowerBiApp(): msal.ConfidentialClientApplication {
  if (!powerBiApp) {
    if (!tenantId || !clientId || !clientSecret) {
      throw new Error("Missing Azure AD credentials: TENANT_ID, CLIENT_ID, CLIENT_SECRET");
    }
    powerBiApp = new msal.ConfidentialClientApplication({
      auth: {
        clientId,
        clientSecret,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
      system: {
        loggerOptions: {
          loggerCallback: (level, message) => {
            if (level === msal.LogLevel.Error) {
              logger.error({ message }, "MSAL Power BI error");
            }
          },
          piiLoggingEnabled: false,
          logLevel: msal.LogLevel.Error,
        },
      },
    });
  }
  return powerBiApp;
}

export async function getGraphToken(): Promise<string> {
  const result = await getGraphApp().acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });
  if (!result?.accessToken) throw new Error("Failed to acquire Graph token");
  return result.accessToken;
}

export async function getPowerBiToken(): Promise<string> {
  const result = await getPowerBiApp().acquireTokenByClientCredential({
    scopes: ["https://analysis.windows.net/powerbi/api/.default"],
  });
  if (!result?.accessToken) throw new Error("Failed to acquire Power BI token");
  return result.accessToken;
}

export function isAzureConfigured(): boolean {
  return !!(tenantId && clientId && clientSecret);
}
