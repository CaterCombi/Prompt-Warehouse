import jwt from "jsonwebtoken";

function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

const JWT_SECRET = requiredSecret("SESSION_SECRET");
const managerPassword = requiredSecret("MANAGER_PASSWORD");
const adminPassword = requiredSecret("ADMIN_PASSWORD");
// Changing passwords must also reject sessions issued under the old fallback credentials.
const SESSION_VERSION = 2;

const USERS: Record<string, { password: string; displayName: string }> = {
  manager: {
    password: managerPassword,
    displayName: "Warehouse Manager",
  },
  admin: {
    password: adminPassword,
    displayName: "Administrator",
  },
};

export interface TokenPayload {
  id: string;
  username: string;
  displayName: string;
}

export function verifyCredentials(username: string, password: string): TokenPayload | null {
  const user = USERS[username.toLowerCase()];
  if (!user || user.password !== password) return null;
  return {
    id: username.toLowerCase(),
    username: username.toLowerCase(),
    displayName: user.displayName,
  };
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign({ ...payload, sessionVersion: SESSION_VERSION }, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (
      typeof decoded === "string" ||
      decoded.sessionVersion !== SESSION_VERSION ||
      typeof decoded.id !== "string" ||
      typeof decoded.username !== "string" ||
      typeof decoded.displayName !== "string"
    ) return null;
    return { id: decoded.id, username: decoded.username, displayName: decoded.displayName };
  } catch {
    return null;
  }
}
