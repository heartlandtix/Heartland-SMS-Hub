const express = require("express");
const cors = require("cors");

const app = express();
const PORT = 3000;
const SMS_READER_URL = "http://127.0.0.1:8080";

app.use(cors());
app.use(express.json());

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    message: "Heartland SMS Server is running"
  });
});

app.get("/api/messages", async (req, res) => {
  try {
    const response = await fetch(`${SMS_READER_URL}/messages`);

    if (!response.ok) {
      throw new Error(`SMS reader returned HTTP ${response.status}`);
    }

    const json = await response.json();
    res.json(json);
  } catch (error) {
    res.status(502).json({
      error: "Could not reach Heartland SMS Reader",
      details: error.message
    });
  }
});

app.get("/api/version", async (req, res) => {
  try {
    const response = await fetch(`${SMS_READER_URL}/version`);

    if (!response.ok) {
      throw new Error(`SMS reader returned HTTP ${response.status}`);
    }

    const version = await response.text();
    res.type("text/plain").send(version.trim());
  } catch (error) {
    res.status(502).type("text/plain").send("");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Heartland SMS Server listening on port ${PORT}`);
});
