import express from "express";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "runner" });
});

app.listen(PORT, () => {
  console.log(`[runner] listening on :${PORT}`);
});
