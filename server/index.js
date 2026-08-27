require("dotenv").config();

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = 3000;
const SMS_READER_URL = "http://127.0.0.1:8080";
const DB_PATH = "C:\\HeartlandData\\sms.db";
const POLL_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------
// Every log line below goes through these instead of plain
// console.log/console.error, so node.log always shows exactly when
// something happened - not just that it happened. Matches the same
// day-of-week + date + time format used in the C++ reader's own log.
// ---------------------------------------------------------------------
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function timestampPrefix() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const day = DAY_NAMES[now.getDay()];
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `[${day} ${date} ${time}]`;
}

function log(...args) {
  console.log(timestampPrefix(), ...args);
}

function logError(...args) {
  console.error(timestampPrefix(), ...args);
}

app.use(cors());
app.use(express.json());

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    message: "Heartland SMS Server is running"
  });
});

// Loads every message currently in our own database, in the same
// shape the frontend already expects from the C++ program's /messages
// endpoint - lets us merge the two sources together below.
function loadOurDatabaseMessages() {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM messages ORDER BY id ASC", [], (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(
        rows.map((row) => ({
          index: row.modem_index,
          status: row.status,
          type: row.message_type,
          address: row.address,
          timestamp: row.timestamp_original,
          encoding: row.encoding,
          text: row.text,
          error: row.error || "",
          multipart: !!row.multipart,
          reference: row.concat_reference,
          part: row.concat_part,
          total: row.concat_total
        }))
      );
    });
  });
}

app.get("/api/messages", async (req, res) => {
  // The C++ program only ever shows whatever the modem currently has
  // in its own storage right now - it has no awareness of anything
  // saved into our database through a different path (like the
  // Skylight cross-check below), and the modem's own storage can also
  // silently drop older messages over time due to its own limited
  // capacity. Merging in our own permanent database means neither of
  // those gaps causes a message to go missing from the web inbox.
  let liveMessages = [];
  let liveFetchFailed = false;

  try {
    const response = await fetch(`${SMS_READER_URL}/messages`);
    if (response.ok) {
      const json = await response.json();
      liveMessages = Array.isArray(json.messages) ? json.messages : [];
    } else {
      liveFetchFailed = true;
    }
  } catch (error) {
    liveFetchFailed = true;
  }

  let dbMessages = [];
  try {
    dbMessages = await loadOurDatabaseMessages();
  } catch (error) {
    logError("Could not load messages from our own database:", error.message);
  }

  const liveKeys = new Set(
    liveMessages.map((m) => comparisonKey(m.address, m.text))
  );

  const onlyInDatabase = dbMessages.filter(
    (m) => !liveKeys.has(comparisonKey(m.address, m.text))
  );

  const combined = [...liveMessages, ...onlyInDatabase];

  if (liveFetchFailed && dbMessages.length === 0) {
    res.status(502).json({
      error: "Could not reach Heartland SMS Reader",
      details: "The live modem connection is unavailable and no database records could be loaded either."
    });
    return;
  }

  res.json({ messages: combined });
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
  log(`Heartland SMS Server listening on port ${PORT}`);
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

  log(
    `Email alerts enabled: authenticating as ${emailAuthUser}, ` +
    `sending as ${emailFrom}, to ${emailTo}`
  );
} else {
  log(
    "Email alerts disabled - missing EMAIL_AUTH_USER, EMAIL_FROM_ADDRESS, " +
    "EMAIL_APP_PASSWORD, or EMAIL_TO_ADDRESS in server/.env"
  );
}

const MAX_EMAIL_ATTEMPTS = 5;
const EMAIL_RETRY_DELAY_MS = 10000; // 10 seconds - gives network/DNS a moment to settle, e.g. right after a reboot

function sendMessageEmail(message, attempt = 1) {
  if (!mailTransporter) {
    return;
  }

  // "SMS-DELIVER" is a message this machine received; anything else
  // (e.g. "SMS-SUBMIT") is a message this machine sent out - same
  // distinction the web inbox already shows as an Incoming/Outgoing
  // badge.
  const isIncoming = message.message_type === "SMS-DELIVER";
  const direction = isIncoming ? "Received" : "Sent";
  const addressLabel = isIncoming ? "From" : "To";

  const subject = isIncoming
    ? `New SMS from ${message.address || "Unknown"}`
    : `Sent SMS to ${message.address || "Unknown"}`;

  const body =
    `Device: ${message.device_id || "Unknown"}\n` +
    `Direction: ${direction}\n` +
    `${addressLabel}: ${message.address || "Unknown"}\n` +
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
        // Transient network/DNS failures happen occasionally, especially
        // right after a reboot before the connection has fully settled
        // (seen in the field: "getaddrinfo ENOTFOUND smtp.gmail.com" on
        // a big batch of emails fired right at startup). Retry a few
        // times with a short wait before permanently giving up, rather
        // than silently losing the notification for something transient.
        if (attempt < MAX_EMAIL_ATTEMPTS) {
          log(
            `Email attempt ${attempt} of ${MAX_EMAIL_ATTEMPTS} failed for ` +
            `message id ${message.id} (${error.message}) - retrying in ` +
            `${EMAIL_RETRY_DELAY_MS / 1000}s...`
          );
          setTimeout(
            () => sendMessageEmail(message, attempt + 1),
            EMAIL_RETRY_DELAY_MS
          );
        } else {
          logError(
            `Email permanently FAILED for message id ${message.id} after ` +
            `${MAX_EMAIL_ATTEMPTS} attempts:`,
            error.message
          );
        }
      } else {
        log(`Email sent for message id ${message.id} (${info.response})`);
      }
    }
  );
}

let lastSeenMessageId = null;

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    logError(`Email watcher: could not open database at ${DB_PATH}:`, err.message);
    return;
  }

  log(`Email watcher: watching database at ${DB_PATH}`);

  // Start from whatever the highest existing row id is, so only
  // messages that arrive from now on get emailed - not the entire
  // pre-existing history.
  db.get("SELECT MAX(id) AS maxId FROM messages", (err, row) => {
    if (err) {
      logError("Email watcher: could not read starting message id:", err.message);
      return;
    }

    lastSeenMessageId = row && row.maxId ? row.maxId : 0;
    log(`Email watcher: starting after message id ${lastSeenMessageId}`);
  });
});

setInterval(runSkylightCrossCheck, SKYLIGHT_CHECK_INTERVAL_MS);

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
        logError("Email watcher: error checking for new messages:", err.message);
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

// ---------------------------------------------------------------------
// Skylight cross-check (redundancy safety net).
//
// Skylight keeps its own separate record of every SMS it sees, in a
// plain XML file. Occasionally Skylight reads AND deletes a brand new
// message off the SIM within roughly a second of it arriving - fast
// enough that our own reader sometimes never gets a chance to read it
// at all, even though Skylight itself has a copy the whole time.
//
// This periodically reads Skylight's own inbox file, compares it
// against what's already in OUR database, and for anything Skylight
// has that we're missing, inserts it directly into our own database -
// which then flows through the exact same "new row -> send email"
// mechanism above automatically, no separate email-sending code
// needed here at all.
// ---------------------------------------------------------------------

const SKYLIGHT_INBOX_PATH = path.join(
  process.env.APPDATA || "",
  "Sierra Wireless",
  "Skylight",
  "RWInbox.xml"
);
const SKYLIGHT_CHECK_INTERVAL_MS = 1000; // 1 second - both files/database confirmed tiny, so no real cost to checking this often

const deviceId = os.hostname();

// A second, separate, WRITABLE connection to the same database - kept
// apart from the read-only one above so this new feature can never
// accidentally affect the already-proven email-alert path.
const writableDb = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE, (err) => {
  if (err) {
    logError(`Skylight cross-check: could not open database for writing:`, err.message);
  } else {
    log(`Skylight cross-check: watching ${SKYLIGHT_INBOX_PATH}`);
  }
});

function xmlUnescape(value) {
  return (value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Reduces any phone number format to its last 10 digits, so
// "+15203908115", "15203908115", and "5203908115" all compare equal.
// Short codes (e.g. "38263") are left as-is since they're already short.
function normalizePhone(address) {
  const digits = (address || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

// Skylight timestamps look like "26/6/25 8:1:48:168" - YY/M/D H:M:S:MS,
// no leading zeros. Converts to a real Date object (or null if it
// doesn't parse, which just means we skip using it for anything).
function parseSkylightTimestamp(value) {
  const match = /^(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+):(\d+)$/.exec((value || "").trim());
  if (!match) return null;

  const [, yy, mm, dd, hh, min, ss, ms] = match.map(Number);
  return new Date(2000 + yy, mm - 1, dd, hh, min, ss, ms);
}

function parseSkylightInbox(xmlContent) {
  const rawEntries = [];
  const smsTagPattern = /<sms\s+([^>]*?)\/>/g;
  const attrPattern = /(\w+)="([^"]*)"/g;

  let tagMatch;
  while ((tagMatch = smsTagPattern.exec(xmlContent)) !== null) {
    const attrs = {};
    let attrMatch;
    attrPattern.lastIndex = 0;
    const attrString = tagMatch[1];
    while ((attrMatch = attrPattern.exec(attrString)) !== null) {
      attrs[attrMatch[1]] = xmlUnescape(attrMatch[2]);
    }
    rawEntries.push(attrs);
  }

  // Reassemble multi-part messages (fragmsg="true") into one logical
  // message, grouped by sender + reference number, ordered by fragment
  // number - same concept as how the web inbox combines multipart
  // texts already.
  const groups = new Map();

  for (const entry of rawEntries) {
    const isFragment = entry.fragmsg === "true";
    const groupKey = isFragment
      ? `${entry.from}|${entry.refnum}`
      : `single|${entry.from}|${entry.timestamp}|${entry.msg}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(entry);
  }

  const messages = [];

  for (const parts of groups.values()) {
    parts.sort((a, b) => Number(a.fragnum || 1) - Number(b.fragnum || 1));
    const first = parts[0];
    const combinedText = parts.map((p) => p.msg || "").join("");

    messages.push({
      from: first.from || "",
      to: first.to || "",
      timestampRaw: first.timestamp || "",
      timestamp: parseSkylightTimestamp(first.timestamp),
      text: combinedText
    });
  }

  return messages;
}

function comparisonKey(phone, text) {
  return `${normalizePhone(phone)}|${normalizeText(text)}`;
}

const SKYLIGHT_FIRST_RUN_MARKER = "C:\\HeartlandData\\skylight-crosscheck-initialized.txt";
let skylightIsFirstRun = !fs.existsSync(SKYLIGHT_FIRST_RUN_MARKER);

function insertSkylightMessage(message) {
  const messageKey = `SKYLIGHT|${deviceId}|${message.from}|${message.timestampRaw}|${message.text}`;
  const isoTimestamp = message.timestamp ? message.timestamp.toISOString() : message.timestampRaw;

  const insertSql = `
    INSERT OR IGNORE INTO messages
      (device_id, modem_index, message_type, status, address,
       timestamp_original, encoding, text, error, multipart,
       concat_reference, concat_part, concat_total, raw_pdu, message_key)
    VALUES (?, 0, 'SMS-DELIVER', 1, ?, ?, 'SKYLIGHT-RECOVERED', ?, '', 0, 0, 0, 0, '', ?)
  `;

  return new Promise((resolve) => {
    writableDb.run(
      insertSql,
      [deviceId, message.from, isoTimestamp, message.text, messageKey],
      function callback(err) {
        if (err) {
          logError("Skylight cross-check: insert failed:", err.message);
          resolve();
          return;
        }
        if (this.changes > 0 && !skylightIsFirstRun) {
          log(
            `Skylight cross-check: recovered a message Skylight had that we ` +
            `were missing (from ${message.from}) - it will be emailed shortly.`
          );
        }
        resolve();
      }
    );
  });
}

function runSkylightCrossCheck() {
  fs.readFile(SKYLIGHT_INBOX_PATH, "utf8", (readErr, xmlContent) => {
    if (readErr) {
      // Not treated as an error worth logging every minute - the file
      // may simply not exist on a machine without Skylight installed.
      return;
    }

    let skylightMessages;
    try {
      skylightMessages = parseSkylightInbox(xmlContent);
    } catch (parseErr) {
      logError("Skylight cross-check: could not parse RWInbox.xml:", parseErr.message);
      return;
    }

    // Load everything currently in our own database once per check,
    // and build a lookup set - simpler and plenty fast at this scale
    // rather than querying per-message.
    db.all("SELECT address, text FROM messages", [], async (err, ourRows) => {
      if (err) {
        logError("Skylight cross-check: could not read our own messages:", err.message);
        return;
      }

      const wasFirstRun = skylightIsFirstRun;

      const ourKeys = new Set(
        ourRows.map((row) => comparisonKey(row.address, row.text))
      );

      const inserts = [];
      for (const message of skylightMessages) {
        if (!message.text) continue;

        const key = comparisonKey(message.from, message.text);
        if (!ourKeys.has(key)) {
          inserts.push(insertSkylightMessage(message));
        }
      }

      if (inserts.length > 0) {
        await Promise.all(inserts);
      }

      // On the very first run ever on this machine, everything just
      // inserted above is historical backlog, not a genuinely new
      // message - it's still saved to the database (so the web inbox
      // stays complete), but we deliberately don't want a flood of
      // possibly hundreds of old texts emailed all at once the moment
      // this feature is first turned on across many machines. Moving
      // the email watcher's own starting point forward past this
      // batch means it's silently caught up, while anything genuinely
      // new from this point forward still emails normally.
      if (wasFirstRun) {
        skylightIsFirstRun = false;

        db.get("SELECT MAX(id) AS maxId FROM messages", (maxErr, row) => {
          if (!maxErr && row && row.maxId) {
            lastSeenMessageId = row.maxId;
            log(
              `Skylight cross-check: first run on this machine - silently ` +
              `caught up through message id ${row.maxId} without emailing ` +
              `the historical backlog. Anything new from now on will email normally.`
            );
          }

          fs.writeFile(SKYLIGHT_FIRST_RUN_MARKER, new Date().toISOString(), () => {});
        });
      }
    });
  });
}