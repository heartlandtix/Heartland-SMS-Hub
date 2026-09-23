require("dotenv").config();

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------
// Global safety net.
//
// Added after a real incident: serialport-gsm's own internal response
// parser threw an unguarded error (a regex match came back null, then
// got indexed anyway) while handling a normal, expected reply from one
// SIM - and because that throw happened deep inside the library's own
// event-driven code, not inside a try/catch we control, it crashed the
// ENTIRE Node process. That took down receiving on all 8 ports at
// once, not just whatever triggered it.
//
// This is the real fix for THAT category of risk: no matter what
// throws, from where, Node logs it and keeps running instead of
// exiting. This is a genuine tradeoff, not a free lunch - continuing
// after a truly unexpected error means the process could theoretically
// be left in a slightly inconsistent state. But for this system, the
// alternative (one bad response from one SIM silently killing
// everyone's receiving until someone notices and restarts it by hand)
// is clearly worse.
process.on("uncaughtException", (error) => {
  logError("UNCAUGHT EXCEPTION (Node kept running instead of crashing):", error && error.stack ? error.stack : error);
});

const app = express();
const PORT = 3000;
const SMS_READER_URL = "http://127.0.0.1:8080";
const DB_PATH = "C:\\HeartlandData\\sms.db";
const POLL_INTERVAL_MS = 1000;

// Parses the shared display format ("9/18/2026 9:57:25 AM") back into
// a real, comparable moment in time - used ONLY for sorting the
// combined message list below, never for display (the original string
// is always what's actually shown). Returns 0 (sorts to the very
// bottom) for anything that doesn't match, rather than crashing on an
// unexpected format from a source we don't fully control.
function parseDisplayTimestamp(value) {
  const match = /^(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)\s*(AM|PM)$/i.exec((value || "").trim());
  if (!match) return 0;

  let [, month, day, year, hour, minute, second, ampm] = match;
  hour = parseInt(hour, 10);
  if (ampm.toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (ampm.toUpperCase() === "AM" && hour === 12) hour = 0;

  const date = new Date(
    parseInt(year, 10),
    parseInt(month, 10) - 1,
    parseInt(day, 10),
    hour,
    parseInt(minute, 10),
    parseInt(second, 10)
  );

  return isNaN(date.getTime()) ? 0 : date.getTime();
}

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

function comparisonKey(phone, text) {
  return `${normalizePhone(phone)}|${normalizeText(text)}`;
}

app.get("/api/messages", async (req, res) => {
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

  const combined = [...liveMessages, ...onlyInDatabase].sort(
    (a, b) => parseDisplayTimestamp(b.timestamp) - parseDisplayTimestamp(a.timestamp)
  );

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
const EMAIL_RETRY_DELAY_MS = 10000;

function sendMessageEmail(message, attempt = 1) {
  if (!mailTransporter) {
    return;
  }

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

        if (message.id > highestConfirmedEmailedId) {
          highestConfirmedEmailedId = message.id;
          persistLastSeenMessageId(message.id);
        }
      }
    }
  );
}

let highestConfirmedEmailedId = 0;
let lastSeenMessageId = null;

const LAST_EMAILED_ID_FILE = "C:\\HeartlandData\\last-emailed-message-id.txt";

function persistLastSeenMessageId(id) {
  fs.writeFile(LAST_EMAILED_ID_FILE, String(id), () => {});
}

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    logError(`Email watcher: could not open database at ${DB_PATH}:`, err.message);
    return;
  }

  log(`Email watcher: watching database at ${DB_PATH}`);

  fs.readFile(LAST_EMAILED_ID_FILE, "utf8", (readErr, persistedValue) => {
    const persisted = readErr ? NaN : parseInt(persistedValue, 10);

    if (!isNaN(persisted)) {
      lastSeenMessageId = persisted;
      highestConfirmedEmailedId = persisted;
      log(`Email watcher: resuming from persisted message id ${lastSeenMessageId}`);
      return;
    }

    db.get("SELECT MAX(id) AS maxId FROM messages", (err, row) => {
      if (err) {
        logError("Email watcher: could not read starting message id:", err.message);
        return;
      }

      lastSeenMessageId = row && row.maxId ? row.maxId : 0;
      highestConfirmedEmailedId = lastSeenMessageId;
      log(`Email watcher: starting after message id ${lastSeenMessageId}`);
      persistLastSeenMessageId(lastSeenMessageId);
    });
  });
});

const BULK_BATCH_THRESHOLD = 15;

function checkForNewMessages() {
  if (lastSeenMessageId === null) {
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

      if (rows.length === 0) {
        return;
      }

      if (rows.length > BULK_BATCH_THRESHOLD) {
        const lastRow = rows[rows.length - 1];
        log(
          `Email watcher: ${rows.length} new messages appeared at once - ` +
          `treating this as a one-time backlog catch-up rather than ` +
          `emailing each one individually, to avoid triggering Gmail's ` +
          `own rate limiting. Silently caught up through message id ` +
          `${lastRow.id}. Anything new from now on will email normally.`
        );

        lastSeenMessageId = lastRow.id;
        highestConfirmedEmailedId = lastRow.id;
        persistLastSeenMessageId(lastRow.id);
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

const READER_HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const READER_HEALTH_CHECK_TIMEOUT_MS = 5000;
const MAX_HEALTH_RETRY_ATTEMPTS = 5;
const HEALTH_RETRY_DELAY_MS = 30 * 1000;
const deviceId = os.hostname();
let readerIsDown = false;

const MAX_HEALTH_EMAIL_ATTEMPTS = 6;
const HEALTH_EMAIL_RETRY_DELAY_MS = 60 * 1000;

function sendReaderHealthEmail(recovered, attempt = 1) {
  if (!mailTransporter) {
    return;
  }

  const subject = recovered
    ? `Heartland SMS Hub - ${deviceId} is back online`
    : `Heartland SMS Hub - ${deviceId} is NOT responding`;

  const body = recovered
    ? `The SMS reader program on ${deviceId} is responding again as of ` +
      `${new Date().toLocaleString()}.`
    : `${deviceId} has not passed a health check as of ` +
      `${new Date().toLocaleString()}, even after ${MAX_HEALTH_RETRY_ATTEMPTS} ` +
      `automatic recovery attempts. This could mean the reader program ` +
      `itself is stuck, or that this machine has lost internet ` +
      `connectivity entirely - either way, it likely needs manual ` +
      `attention (Chrome Remote Desktop, if reachable, or in person).`;

  mailTransporter.sendMail(
    { from: emailFrom, to: emailTo, subject, text: body },
    (error) => {
      if (error) {
        if (attempt < MAX_HEALTH_EMAIL_ATTEMPTS) {
          logError(
            `Reader health alert attempt ${attempt} of ${MAX_HEALTH_EMAIL_ATTEMPTS} ` +
            `failed (${error.message}) - retrying in ` +
            `${HEALTH_EMAIL_RETRY_DELAY_MS / 1000}s...`
          );
          setTimeout(
            () => sendReaderHealthEmail(recovered, attempt + 1),
            HEALTH_EMAIL_RETRY_DELAY_MS
          );
        } else {
          logError(
            `Reader health alert permanently FAILED after ` +
            `${MAX_HEALTH_EMAIL_ATTEMPTS} attempts:`,
            error.message
          );
        }
      } else {
        log(`Reader health alert email sent (${recovered ? "recovered" : "down"}).`);
      }
    }
  );
}

const { exec } = require("child_process");

function hasInternetConnectivity() {
  return new Promise((resolve) => {
    exec("ping -n 1 -w 3000 8.8.8.8", (err1) => {
      if (!err1) {
        resolve(true);
        return;
      }
      exec("ping -n 1 -w 3000 1.1.1.1", (err2) => {
        resolve(!err2);
      });
    });
  });
}

async function isReaderHealthy() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), READER_HEALTH_CHECK_TIMEOUT_MS);
    const response = await fetch(`${SMS_READER_URL}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch (error) {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function triggerWwanRestart() {
  return new Promise((resolve) => {
    fs.writeFile("C:\\HeartlandData\\wwan-restart-source.txt", "Node health check", () => {
      exec('schtasks /run /tn "Heartland Restart WWAN Service"', (execErr) => {
        if (execErr) {
          logError("Health check: could not trigger WWAN service restart:", execErr.message);
        } else {
          log("Health check: triggered an automatic WWAN service restart.");
        }
        resolve();
      });
    });
  });
}

const HEALTH_RESTART_COUNT_FILE = "C:\\HeartlandData\\health-check-restart-count.txt";
const MAX_HEALTH_AUTO_RESTARTS = 3;

function readHealthRestartCount() {
  return new Promise((resolve) => {
    fs.readFile(HEALTH_RESTART_COUNT_FILE, "utf8", (err, data) => {
      const count = err ? 0 : parseInt(data, 10);
      resolve(isNaN(count) ? 0 : count);
    });
  });
}

function writeHealthRestartCount(count) {
  fs.writeFile(HEALTH_RESTART_COUNT_FILE, String(count), () => {});
}

async function checkReaderHealth() {
  const readerOk = await isReaderHealthy();
  const internetOk = await hasInternetConnectivity();

  if (readerOk && internetOk) {
    if (readerIsDown) {
      readerIsDown = false;
      log("Health check: back online.");
      sendReaderHealthEmail(true);
    }
    writeHealthRestartCount(0);
    return;
  }

  logError(
    `Health check: problem detected (reader ${readerOk ? "ok" : "NOT responding"}, ` +
    `internet ${internetOk ? "ok" : "NOT reachable"}). Beginning recovery attempts...`
  );

  for (let attempt = 1; attempt <= MAX_HEALTH_RETRY_ATTEMPTS; attempt++) {
    await triggerWwanRestart();
    await delay(HEALTH_RETRY_DELAY_MS);

    const recheckReaderOk = await isReaderHealthy();
    const recheckInternetOk = await hasInternetConnectivity();

    if (recheckReaderOk && recheckInternetOk) {
      log(`Health check: recovered after attempt ${attempt} of ${MAX_HEALTH_RETRY_ATTEMPTS}.`);
      if (readerIsDown) {
        readerIsDown = false;
        sendReaderHealthEmail(true);
      }
      writeHealthRestartCount(0);
      return;
    }

    log(`Health check: still not healthy after attempt ${attempt} of ${MAX_HEALTH_RETRY_ATTEMPTS}.`);
  }

  if (!readerIsDown) {
    readerIsDown = true;
    logError(`Health check: still down after ${MAX_HEALTH_RETRY_ATTEMPTS} recovery attempts.`);
    sendReaderHealthEmail(false);
  }

  const restartCount = await readHealthRestartCount();

  if (restartCount < MAX_HEALTH_AUTO_RESTARTS) {
    const newCount = restartCount + 1;
    writeHealthRestartCount(newCount);
    logError(
      `Health check: attempting a full restart as a last resort ` +
      `(attempt ${newCount} of ${MAX_HEALTH_AUTO_RESTARTS} allowed)...`
    );
    exec(
      `shutdown /r /t 60 /c "Heartland: recovering from a health check failure"`,
      (execErr) => {
        if (execErr) {
          logError("Health check: could not trigger a restart:", execErr.message);
        }
      }
    );
  } else {
    logError(
      `Health check: already attempted ${MAX_HEALTH_AUTO_RESTARTS} automatic ` +
      `restarts without success - not trying again automatically. This ` +
      `machine needs manual attention.`
    );
  }
}

setInterval(checkReaderHealth, READER_HEALTH_CHECK_INTERVAL_MS);

const SKYLIGHT_INBOX_PATH = path.join(
  process.env.APPDATA || "",
  "Sierra Wireless",
  "Skylight",
  "RWInbox.xml"
);
const SKYLIGHT_CHECK_INTERVAL_MS = 1000;
const SKYLIGHT_FIRST_RUN_MARKER = "C:\\HeartlandData\\skylight-crosscheck-initialized.txt";
let skylightIsFirstRun = !fs.existsSync(SKYLIGHT_FIRST_RUN_MARKER);

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

function normalizePhone(address) {
  const digits = (address || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

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

function insertSkylightMessage(message) {
  const messageKey = `SKYLIGHT|${deviceId}|${message.from}|${message.timestampRaw}|${message.text}`;
  const isoTimestamp = formatDisplayTimestamp(message.timestamp || new Date());

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
      return;
    }

    let skylightMessages;
    try {
      skylightMessages = parseSkylightInbox(xmlContent);
    } catch (parseErr) {
      logError("Skylight cross-check: could not parse RWInbox.xml:", parseErr.message);
      return;
    }

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

      if (wasFirstRun) {
        skylightIsFirstRun = false;

        db.get("SELECT MAX(id) AS maxId FROM messages", (maxErr, row) => {
          if (!maxErr && row && row.maxId) {
            lastSeenMessageId = row.maxId;
            highestConfirmedEmailedId = row.maxId;
            persistLastSeenMessageId(row.maxId);
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

setInterval(runSkylightCrossCheck, SKYLIGHT_CHECK_INTERVAL_MS);

const serialportgsm = require("serialport-gsm");

const PORT_NAMES_FILE = path.join(__dirname, "port-names.json");

function getPortLabel(comPort) {
  try {
    const raw = fs.readFileSync(PORT_NAMES_FILE, "utf8");
    const names = JSON.parse(raw);
    if (names[comPort] && names[comPort].trim()) {
      return names[comPort].trim();
    }
  } catch (err) {
  }
  return comPort;
}

const SIM_NAMES_FILE = path.join(__dirname, "sim-names.json");
const portImsis = {};

function getSimLabel(comPort) {
  const imsi = portImsis[comPort];
  if (!imsi) return null;

  try {
    const raw = fs.readFileSync(SIM_NAMES_FILE, "utf8");
    const names = JSON.parse(raw);
    if (names[imsi] && names[imsi].trim()) {
      return names[imsi].trim();
    }
  } catch (err) {
  }
  return null;
}

function extractImsi(rawResponse) {
  const text = typeof rawResponse === "string" ? rawResponse : JSON.stringify(rawResponse || "");
  const match = /\b(\d{14,15})\b/.exec(text);
  return match ? match[1] : null;
}

function loadConfiguredPorts() {
  try {
    const raw = fs.readFileSync(PORT_NAMES_FILE, "utf8");
    const names = JSON.parse(raw);
    return Object.keys(names);
  } catch (err) {
    return [];
  }
}

const MODEM_PORTS = loadConfiguredPorts();

const modemInstances = {};

function formatDisplayTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  let hours = date.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;

  return (
    `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ` +
    `${hours}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${ampm}`
  );
}

function normalizeModemTimestamp(scts) {
  const parsed = scts ? new Date(scts) : null;
  return formatDisplayTimestamp(parsed && !isNaN(parsed.getTime()) ? parsed : new Date());
}

function insertDirectPollerMessage(comPort, from, text, timestampIso) {
  const deviceIdForPort = getSimLabel(comPort) || getPortLabel(comPort);
  const messageKey = `DIRECTPOLL|${comPort}|${timestampIso}|${normalizeText(text)}`;

  const insertSql = `
    INSERT OR IGNORE INTO messages
      (device_id, modem_index, message_type, status, address,
       timestamp_original, encoding, text, error, multipart,
       concat_reference, concat_part, concat_total, raw_pdu, message_key)
    VALUES (?, 0, 'SMS-DELIVER', 1, ?, ?, 'DIRECT-AT-POLL', ?, '', 0, 0, 0, 0, '', ?)
  `;

  return new Promise((resolve) => {
    writableDb.run(
      insertSql,
      [deviceIdForPort, from, timestampIso, text, messageKey],
      function callback(err) {
        if (err) {
          logError(`Direct poller (${comPort}): insert failed:`, err.message);
          resolve();
          return;
        }
        if (this.changes > 0) {
          log(`Direct poller (${comPort}): new message from ${from} - it will be emailed shortly.`);
        }
        resolve();
      }
    );
  });
}

function startModemOnPort(comPort, pollOffsetMs) {
  const modem = serialportgsm.Modem();

  const options = {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    rtscts: false,
    xon: false,
    xoff: false,
    xany: false,
    autoDeleteOnReceive: true,
    enableConcatenation: true,
    incomingCallIndication: false,
    incomingSMSIndication: true,
    pin: "",
    cnmiCommand: "AT+CNMI=2,1,0,2,1"
  };

  modem.open(comPort, options, (err) => {
    if (err) {
      logError(`Direct poller (${comPort}): could not open port:`, err.message || err);
    }
  });

  modem.on("open", () => {
    modem.initializeModem((result) => {
      if (result && result.status === "success") {
        log(`Direct poller (${comPort}): modem initialized, listening for new messages.`);

        // Real fix for a real incident tonight: COM11 went completely
        // silent for over an hour, with the poll loop itself working
        // perfectly the whole time (proven by repeated clean "success,
        // empty" results) - the actual cause turned out to be message
        // storage set to "ME" (modem's own internal memory) instead of
        // "SM" (the SIM card), which getSimInbox never looks at. A
        // one-time manual fix through PuTTY worked immediately, but
        // reverted back to "ME" after the very next restart - strongly
        // suggesting initializeModem resets this to whatever the
        // modem's own hardware default is, every single time. Setting
        // it explicitly here, every time a port initializes, is the
        // real fix - not a one-time manual command that a future
        // restart can silently undo again.
        modem.executeCommand('AT+CPMS="SM","SM","SM"', (cpmsResult) => {
          if (cpmsResult && cpmsResult.status === "success") {
            log(`Direct poller (${comPort}): confirmed using SIM storage for messages.`);
          } else {
            logError(`Direct poller (${comPort}): could not set SIM storage - raw response: ${JSON.stringify(cpmsResult)}`);
          }
        });

        modem.executeCommand("AT+CIMI", (cimiResult) => {
          const imsi = extractImsi(cimiResult);
          if (imsi) {
            portImsis[comPort] = imsi;
            log(`Direct poller (${comPort}): SIM IMSI is ${imsi}.`);
          } else {
            log(`Direct poller (${comPort}): could not read this SIM's IMSI - raw response: ${JSON.stringify(cimiResult)}`);
          }
        });
      } else {
        logError(`Direct poller (${comPort}): could not initialize modem:`, JSON.stringify(result));
      }
    });
  });

  modem.on("onNewMessage", (data) => {
    log(`Direct poller (${comPort}): raw onNewMessage payload: ${JSON.stringify(data)}`);

    try {
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        const from = (entry.sender || entry.from || "").trim();
        const text = entry.message || entry.text || "";
        const timestampIso = normalizeModemTimestamp(entry.dateTimeSent || entry.time || entry.date);

        if (!text) continue;

        insertDirectPollerMessage(comPort, from, text, timestampIso);
      }
    } catch (parseErr) {
      logError(`Direct poller (${comPort}): could not parse new-message event:`, parseErr.message);
    }
  });

  modem.on("error", (err) => {
    logError(`Direct poller (${comPort}): error:`, err.message || err);
  });

  const POLL_INTERVAL_MS = 3000;

  const VERBOSE_DEBUG_PORTS = ["COM11"];

  setTimeout(() => {
    setInterval(async () => {
      modem.getSimInbox(async (result) => {
      if (VERBOSE_DEBUG_PORTS.includes(comPort)) {
        log(`Direct poller (${comPort}) [DEBUG]: poll completed, raw result: ${JSON.stringify(result)}`);
      }

      if (!result) return;

      const messages = Array.isArray(result) ? result : (result.data || []);
      if (!Array.isArray(messages) || messages.length === 0) return;

      log(`Direct poller (${comPort}): raw getSimInbox result: ${JSON.stringify(result)}`);

      await Promise.all(
        messages.map(async (entry) => {
          try {
            const from = (entry.sender || entry.from || entry.number || "").trim();
            const text = entry.message || entry.text || entry.sms || "";
            const timestampIso = normalizeModemTimestamp(entry.dateTimeSent);

            if (!text) return;

            await insertDirectPollerMessage(comPort, from, text, timestampIso);

            modem.deleteMessage(entry, (deleteResult) => {
              if (!deleteResult || deleteResult.status !== "success") {
                logError(`Direct poller (${comPort}): could not delete message from SIM after saving it:`, JSON.stringify(deleteResult));
              }
            });
          } catch (parseErr) {
            logError(`Direct poller (${comPort}): could not parse a SIM inbox entry:`, parseErr.message);
          }
        })
      );
    });
    }, POLL_INTERVAL_MS);
  }, pollOffsetMs);

  modemInstances[comPort] = modem;
}

if (MODEM_PORTS.length === 0) {
  log("Direct poller: no port-names.json found on this machine - direct polling is off here.");
} else {
  log(`Direct poller: starting on ${MODEM_PORTS.length} configured port(s): ${MODEM_PORTS.join(", ")}`);

  const staggerStepMs = Math.floor(3000 / Math.max(MODEM_PORTS.length, 1));

  MODEM_PORTS.forEach((comPort, index) => {
    startModemOnPort(comPort, index * staggerStepMs);
  });
}
