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
    exec('schtasks /run /tn "Heartland Restart WWAN Service"', (execErr) => {
      if (execErr) {
        logError("Health check: could not trigger WWAN service restart:", execErr.message);
      } else {
        log("Health check: triggered an automatic WWAN service restart.");
      }
      resolve();
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
