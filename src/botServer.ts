import express from "express";
import { startUnifiedBot } from "./bot/alertBot.js";

const app = express();
const port = Number(process.env.PORT ?? 30000);

app.get("/health", (_req, res) => {
	res.json({ status: "ok", service: "telegram-bot" });
});

app.listen(port, () => {
	console.log(`[bot-server] health endpoint listening on port ${port}`);
});

startUnifiedBot();