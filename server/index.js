require("dotenv").config();

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = 3000;
const SMS_READER_URL = "http://127.0.0.1:8080";
const DB_PATH = "C:\\HeartlandData\\sms.db";
const POLL_INTERVAL_MS = 5000;

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

// ---------------------------------------------------------------------
// Email alerts for new SMS messages.
//
// This watches the SQLite database directly (the same file the C++
// reader writes to) and sends one email per new message row. It is
// completely independent of the proxy endpoints above - if email
// sending is unconfigured or fails, the web inbox keeps working
// exactly as before.
// ---------------------------------------------------------------------

const emailAuthUser = (process.env.EMAIL_AUTH_USER || "").trim();
const emailFrom = (process.env.EMAIL_FROM_ADDRESS || "").trim();
const emailAppPassword = (process.env.EMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const emailTo = (process.env.EMAIL_TO_ADDRESS || "").trim();

let mailTransporter = null;

if (emailAuthUser && emailFrom && emailAppPassword && emailTo) {
  mailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: emailAuthUser,
      pass: emailAppPassword
    }
  });

  console.log(
    `Email alerts enabled: authenticating as ${emailAuthUser}, ` +
    `sending as ${emailFrom}, to ${emailTo}`
  );
} else {
  console.log(
    "Email alerts disabled - missing EMAIL_AUTH_USER, EMAIL_FROM_ADDRESS, " +
    "EMAIL_APP_PASSWORD, or EMAIL_TO_ADDRESS in server/.env"
  );
}

function sendMessageEmail(message) {
  if (!mailTransporter) {
    return;
  }

  const subject = `New SMS from ${message.address || "Unknown"}`;
  const body =
    `Device: ${message.device_id || "Unknown"}\n` +
    `From: ${message.address || "Unknown"}\n` +
    `Time: ${message.timestamp_original || "Unknown"}\n\n` +
    `${message.text || message.error || "(no text)"}\n`;

  mailTransporter.sendMail(
    {
      from: emailFrom,
      to: emailTo,
      subject,
      text: body
    },
    (error, info) => {
      if (error) {
        console.error(`Email FAILED for message id ${message.id}:`, error.message);
      } else {
        console.log(`Email sent for message id ${message.id} (${info.response})`);
      }
    }
  );
}

let lastSeenMessageId = null;

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error(`Email watcher: could not open database at ${DB_PATH}:`, err.message);
    return;
  }

  console.log(`Email watcher: watching database at ${DB_PATH}`);

  // Start from whatever the highest existing row id is, so only
  // messages that arrive from now on get emailed - not the entire
  // pre-existing history.
  db.get("SELECT MAX(id) AS maxId FROM messages", (err, row) => {
    if (err) {
      console.error("Email watcher: could not read starting message id:", err.message);
      return;
    }

    lastSeenMessageId = row && row.maxId ? row.maxId : 0;
    console.log(`Email watcher: starting after message id ${lastSeenMessageId}`);
  });
});

function checkForNewMessages() {
  if (lastSeenMessageId === null) {
    // Still starting up - database not ready yet.
    return;
  }

  db.all(
    "SELECT * FROM messages WHERE id > ? ORDER BY id ASC",
    [lastSeenMessageId],
    (err, rows) => {
      if (err) {
        console.error("Email watcher: error checking for new messages:", err.message);
        return;
      }

      for (const row of rows) {
        lastSeenMessageId = row.id;
        sendMessageEmail(row);
      }
    }
  );
}

setInterval(checkForNewMessages, POLL_INTERVAL_MS);
