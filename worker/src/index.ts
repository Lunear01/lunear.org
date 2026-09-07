import { Hono } from "hono";
import type { AuthVariables } from "./auth/session";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { lobbyRoutes } from "./routes/lobby";
import { tableRoutes } from "./routes/tables";

export { GameTableDO } from "./durable-objects/game-table";
export { LobbyDO } from "./durable-objects/lobby";
export { LiarsBarTableDO } from "./durable-objects/liarsbar-table";
export { PokerTableDO } from "./durable-objects/poker-table";

// Env comes from the generated worker-configuration.d.ts (run `npm run types -w worker` after touching wrangler.jsonc).
const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/tables", tableRoutes);
app.route("/api/lobby", lobbyRoutes);

export default app;
