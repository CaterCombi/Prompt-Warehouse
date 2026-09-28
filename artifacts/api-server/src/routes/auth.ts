import { Router } from "express";
import { verifyCredentials, signToken } from "../lib/auth.js";
import { requireAuth } from "../middlewares/requireAuth.js";

const router = Router();

router.post("/auth/login", (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  const user = verifyCredentials(username, password);
  if (!user) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const token = signToken(user);
  res.json({ token, user });
});

router.get("/auth/me", requireAuth, (req, res) => {
  const user = (req as typeof req & { user: { id: string; username: string; displayName: string } }).user;
  res.json(user);
});

export default router;
