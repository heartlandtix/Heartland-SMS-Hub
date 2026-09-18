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

function comparisonKey(phone, text) {
  return `${normalizePhone(phone)}|${normalizeText(text)}`;
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

// ---------------------------------------------------------------------
// Email alerts for new SMS messages.
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

        // Only now - genuinely confirmed sent, not just found - do we
        // durably persist this as "handled." The guard against moving
        // backward matters because retries can occasionally complete
        // out of order (a later message succeeding before an earlier
        // one that's still retrying) - we never want a late success to
        // un-persist progress a higher id already recorded.
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

// Durable record of the last message we actually confirmed emailing -
// used instead of just asking "what's currently the highest id in the
// database" at every startup. That approach has a real gap: if Node
// restarts more than once in quick succession (seen in the field on a
// couple of machines needing a second restart to fully come up), a
// message can get inserted by an earlier, short-lived instance, and
// then the NEXT instance's fresh "what's already there" check sees it
// as already old - even though nobody was ever actually emailed about
// it. Persisting this value ourselves, updated only when we genuinely
// send an email, closes that gap regardless of how many times Node
// restarts in a row.
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

    // No persisted value exists yet - this is genuinely the very
    // first time this machine has ever run, so fall back to "start
    // counting from whatever's already here" to avoid emailing an
    // entire pre-existing history on first install.
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

// If an unusually large number of new messages appear in a single
// check, that's a sign of some kind of one-time backlog catch-up
// (a fresh deployment finding hundreds of pre-existing messages, for
// example) rather than genuine real-time activity - normal traffic
// arrives one or two at a time, not hundreds at once. Emailing an
// entire large batch individually risks Gmail's own rate-limiting
// blocking the whole shared account for a while, affecting every
// machine's email delivery, not just this one. Past this threshold,
// the whole batch is silently caught up instead - saved to the
// database and visible in the web inbox, exactly like the dedicated
// Skylight first-run protection already does, just applied generally
// so it protects against any future source of a bulk backlog too.
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

// ---------------------------------------------------------------------
// Reader health check (self-report if the internet is fine but the
// SMS reader itself has stopped responding).
//
// Node checks the C++ reader's own local /health endpoint every 5
// minutes. If it's unreachable, Node sends ONE alert email (not
// repeated every 5 minutes while still down) - and since that email
// successfully sending proves this machine's internet connection is
// fine, it specifically means the READER program itself is the
// problem, not the network. A single "back online" email follows once
// it responds again.
// ---------------------------------------------------------------------

const READER_HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const READER_HEALTH_CHECK_TIMEOUT_MS = 5000;
const MAX_HEALTH_RETRY_ATTEMPTS = 5;
const HEALTH_RETRY_DELAY_MS = 30 * 1000; // 30 seconds between attempts
// IMPORTANT: os.hostname() often preserves a different capitalization
// than the C++ reader's own GetComputerNameW() call does (which
// commonly comes back all-uppercase). This is DELIBERATELY left as-is
// - it's not a bug, and should not be "fixed" to make the two match.
// In practice, this means a message's device name shows up in emails
// in a DIFFERENT case depending on which path caught it: uppercase
// (e.g. "RUSTY-WESTFIELD") means the C++ reader detected it live and
// normally; lowercase/mixed-case (e.g. "Rusty-Westfield") means it
// came through the Skylight cross-check safety net instead - i.e. the
// reader missed it live, and Skylight's own record caught it
// afterward. This is used as an at-a-glance signal for how a message
// actually arrived, and is genuinely useful, not cosmetic.
const deviceId = os.hostname();
let readerIsDown = false;

const MAX_HEALTH_EMAIL_ATTEMPTS = 6;
const HEALTH_EMAIL_RETRY_DELAY_MS = 60 * 1000; // 1 minute - a real network outage may take a few minutes to clear

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
        // A "down" alert is often being sent at the exact worst
        // moment - when internet may genuinely be part of the
        // problem - so a single failed attempt doesn't mean much.
        // Retry several times, spaced a minute apart, rather than
        // silently giving up on the one notification that matters
        // most.
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

// Checks real internet connectivity, not just whether the reader's own
// local page loads - a reader can be running perfectly fine locally
// while the machine has no actual internet connection at all, which a
// purely local check would never catch. Same technique already used
// in Check-Internet-Connectivity.bat (ping two reliable addresses;
// only fails if BOTH are unreachable, so one flaky server doesn't
// cause a false alarm).
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
    // A genuinely healthy check resets the restart counter, so a bad
    // day doesn't permanently use up future chances to recover.
    writeHealthRestartCount(0);
    return;
  }

  // Something's wrong - either the reader itself, or general internet
  // connectivity. Retry the lightweight fix several times, with a
  // pause between each, before finally giving up and alerting - a
  // single attempt wasn't always enough in the field.
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
    // Best-effort alert - if internet is genuinely the problem, this
    // may not actually arrive, which is exactly why the bounded
    // restart below exists as a fallback that doesn't depend on
    // email working at all.
    sendReaderHealthEmail(false);
  }

  // The lightweight fix genuinely wasn't enough. A full restart is a
  // real, if riskier, option: it's the one thing that's reliably
  // cleared this exact situation in the field, and it doesn't depend
  // on internet already working (unlike the email alert above). It's
  // deliberately bounded, not indefinite - a small number of chances,
  // tracked durably across restarts, so a problem a reboot genuinely
  // can't fix doesn't turn into an endless reboot loop.
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

// ---------------------------------------------------------------------
// Skylight cross-check (redundancy safety net).
// ---------------------------------------------------------------------

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
// ---------------------------------------------------------------------
// Direct modem poller (bypasses SMSCaster entirely for receiving).
//
// Tonight's testing showed SMSCaster's own engine is unreliable for
// hands-off receiving, and every attempt to control it invisibly from
// outside (a documented command-line flag, a posted keystroke, a
// simulated button click) either failed outright or turned out too
// fragile for a machine that needs to stay usable for other things.
//
// Rather than keep patching around software from 2007 that was never
// built to run unattended, this talks DIRECTLY to each modem's COM
// port using plain AT commands - the same fundamental technique the
// Dell fleet's own C++ reader already relies on successfully, just
// implemented here in Node using a purpose-built library instead of
// custom C++.
//
// Uses the "serialport-gsm" npm package, which additionally supports
// event-driven notification (the modem tells us the instant a message
// arrives, via AT+CNMI unsolicited codes) rather than us needing to
// poll on a timer at all - genuinely faster and lighter than polling.
//
// IMPORTANT OPERATIONAL NOTE: Windows only lets one program hold a
// COM port open at a time. SMSCaster currently has these ports open
// for its own (unreliable) receiving - it needs to release them
// (uncheck the ports in its own Phone panel, or leave it closed)
// before this code can open them itself. SMSCaster can still be used
// for outgoing sends later if wanted, just not while also trying to
// receive on the same ports at the same time.
//
// SAME multi-SIM device_id approach as the SMSCaster cross-check
// above: "<hostname>-<COM port>" keeps every SIM's messages
// distinguishable from each other and from every other machine.
// ---------------------------------------------------------------------

const serialportgsm = require("serialport-gsm");

// ---------------------------------------------------------------------
// Friendly port names AND which ports to actually poll on THIS
// machine - both driven by the same file, on purpose.
//
// port-names.json's own KEYS decide which COM ports this specific
// machine polls; its VALUES give each one a friendly display name.
// A machine with no port-names.json at all (every Dell, today) polls
// ZERO ports and does nothing whatsoever - rather than blindly trying
// to open a hardcoded list of COM numbers that may not exist on that
// machine, or worse, may already be legitimately in use by something
// else there. Creating port-names.json on a machine (and listing the
// ports that need names) IS the opt-in for this whole feature - no
// separate configuration needed.
//
// The name lookup itself is re-read fresh on every message (cheap,
// since it's a tiny file), so renaming a port takes effect
// immediately without a restart. The PORT LIST, on the other hand,
// is only read once at startup - adding a brand new port to poll
// still needs a restart, same as any other startup configuration.
// ---------------------------------------------------------------------

// port-names.json lives right alongside this file (same folder as
// .env), NOT in C:\HeartlandData - matching where other genuinely
// user-edited config already lives in this project. Using __dirname
// (rather than a hardcoded path) means this correctly finds the file
// no matter where the deployment folder itself was unzipped on any
// given machine, since the deployment workflow allows "unzip
// anywhere" rather than a single fixed location.
const PORT_NAMES_FILE = path.join(__dirname, "port-names.json");

function getPortLabel(comPort) {
  try {
    const raw = fs.readFileSync(PORT_NAMES_FILE, "utf8");
    const names = JSON.parse(raw);
    if (names[comPort] && names[comPort].trim()) {
      return names[comPort].trim();
    }
  } catch (err) {
    // Missing file, bad JSON, or this specific port not listed yet -
    // any of these just falls back to the raw port name below rather
    // than breaking anything.
  }
  return comPort;
}

function loadConfiguredPorts() {
  try {
    const raw = fs.readFileSync(PORT_NAMES_FILE, "utf8");
    const names = JSON.parse(raw);
    return Object.keys(names);
  } catch (err) {
    // No file (or unreadable/invalid one) means this machine has no
    // ports configured for direct polling at all - safe, silent
    // no-op, exactly like every other "not set up on this machine"
    // check elsewhere in this file.
    return [];
  }
}

const MODEM_PORTS = loadConfiguredPorts();

const modemInstances = {};

// Matches the C++ reader's own timestamp style exactly (e.g.
// "9/18/2026 9:57:25 AM") - used for EVERY message that goes through
// our own code (both the Skylight cross-check and the direct poller
// below), so the web inbox shows one consistent, human-readable
// format everywhere, regardless of which path actually caught a given
// message. The frontend itself doesn't reformat timestamps - it just
// displays whatever string is already stored - so matching the format
// at write time is what actually controls how this looks on screen.
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
  // serialport-gsm typically returns the SIM's own timestamp string
  // (format varies by modem) - falling back to "now" if it's missing
  // or unparseable is safer than crashing on an unexpected format.
  const parsed = scts ? new Date(scts) : null;
  return formatDisplayTimestamp(parsed && !isNaN(parsed.getTime()) ? parsed : new Date());
}

function insertDirectPollerMessage(comPort, from, text, timestampIso) {
  // Just the port's own label (e.g. "COM10", or later a real name
  // like "Steven") - deliberately NOT prefixed with this machine's
  // hostname. Unlike the Dell fleet, where hostname alone correctly
  // identifies who a message belongs to (one SIM per machine), a
  // modem-pool machine has many SIMs sharing one hostname - so the
  // meaningful identity here is the port/name, not the machine.
  const deviceIdForPort = getPortLabel(comPort);
  // Content-based key (not a SIM storage index, which gets reused
  // after deletion) - matches the same dedup philosophy already used
  // elsewhere (comparisonKey), just inlined here since timestamps
  // from a modem are precise enough to keep this safely unique.
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

function startModemOnPort(comPort) {
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
    // The modem deletes each message from SIM storage itself right
    // after handing it to us - same purpose as our own AT+CMGD would
    // serve, just handled by the library. This is what keeps SIM
    // storage from filling up and prevents the same message being
    // reported twice.
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
    // IMPORTANT: this library's callback doesn't follow the usual
    // Node "err is null on success" convention - it always passes a
    // single result object, success or failure, with its own status
    // field. Checking result.status is the real way to tell them
    // apart (confirmed by tonight's actual test output, where every
    // port's "error" callback data literally read status: 'success').
    modem.initializeModem((result) => {
      if (result && result.status === "success") {
        log(`Direct poller (${comPort}): modem initialized, listening for new messages.`);
      } else {
        logError(`Direct poller (${comPort}): could not initialize modem:`, JSON.stringify(result));
      }
    });
  });

  modem.on("onNewMessage", (data) => {
    // IMPORTANT: serialport-gsm's own docs don't spell out the exact
    // field names inside this event's data (unlike some of its other
    // events, which do show their shape explicitly) - so this is
    // logged in full, once per message, as a safety net. If the
    // guessed field names below (sender/message/time) turn out wrong
    // once this actually runs, this raw log line shows the real
    // shape immediately, rather than silently inserting blank/wrong
    // data with no way to tell why.
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

  // ACTIVE POLLING - the primary, reliable path.
  //
  // Tonight's first real test showed the event-based push notification
  // above (onNewMessage, driven by the modem's own unsolicited AT+CNMI
  // codes) never fired at all, even though the message genuinely
  // arrived - a real, observed limitation of this modem/library
  // combination, not something worth chasing further blind. Rather
  // than depend on that, this actively asks each modem "what's in your
  // inbox right now" on a short interval - a more basic technique,
  // closer to what the Dell fleet's own C++ reader already does
  // successfully, and one we can directly verify rather than hope
  // works.
  const POLL_INTERVAL_MS = 3000;

  setInterval(async () => {
    modem.getSimInbox(async (result) => {
      // Same defensive logging approach as onNewMessage above - the
      // library's docs don't spell out this result's exact shape
      // either, so the raw result is logged once per non-empty poll
      // as a safety net for correcting field-name guesses quickly.
      if (!result) return;

      const messages = Array.isArray(result) ? result : (result.data || []);
      if (!Array.isArray(messages) || messages.length === 0) return;

      log(`Direct poller (${comPort}): raw getSimInbox result: ${JSON.stringify(result)}`);

      // All inserted together (not one at a time) - a sequential loop
      // here left a real gap where the independent, once-a-second
      // email watcher could see an early message in this very batch
      // land in the database before the rest arrived, defeating its
      // own "15+ at once = silent catch-up, not individual emails"
      // protection. This is exactly what happened on tonight's actual
      // 16-message backlog - harmless this time (Kevin's own inbox,
      // no outside recipients), but the same fix already applied to
      // the SMSCaster code earlier belongs here too, for the same
      // reason.
      await Promise.all(
        messages.map(async (entry) => {
          try {
            const from = (entry.sender || entry.from || entry.number || "").trim();
            const text = entry.message || entry.text || entry.sms || "";
            const timestampIso = normalizeModemTimestamp(entry.dateTimeSent);

            if (!text) return;

            await insertDirectPollerMessage(comPort, from, text, timestampIso);

            // Clear it from the SIM right after saving it, so the
            // next poll doesn't see (and re-process) the same
            // message again.
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

  modemInstances[comPort] = modem;
}

if (MODEM_PORTS.length === 0) {
  log("Direct poller: no port-names.json found on this machine - direct polling is off here.");
} else {
  log(`Direct poller: starting on ${MODEM_PORTS.length} configured port(s): ${MODEM_PORTS.join(", ")}`);

  for (const comPort of MODEM_PORTS) {
    startModemOnPort(comPort);
  }
}
