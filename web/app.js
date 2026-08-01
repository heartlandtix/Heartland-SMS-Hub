const list = document.getElementById("list");
const detail = document.getElementById("detail");
const search = document.getElementById("search");
const direction = document.getElementById("direction");
const sort = document.getElementById("sort");
const count = document.getElementById("count");
const status = document.getElementById("status");
const codesOnly = document.getElementById("codesOnly");

let rawMessages = [];
let messages = [];
let selectedKey = null;
let codeFilter = false;
let inboxVersion = null;

function safe(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

function messageKey(message) {
  return [
    message.type,
    message.address,
    message.timestamp,
    message.index,
    message.reference,
    message.part
  ].join("|");
}

function urls(text = "") {
  return [...new Set(text.match(/https?:\/\/[^\s<>"']+/gi) || [])];
}

function codes(text = "") {
  const found = [];
  const keyed =
    /(?:code|password|passcode|pin|presale|unlock|verification|verify|otp)[\s:=-]*([A-Z0-9][A-Z0-9_-]{3,20})/gi;

  let match;
  while ((match = keyed.exec(text))) {
    found.push(match[1]);
  }

  for (const number of text.match(/\b\d{4,8}\b/g) || []) {
    found.push(number);
  }

  return [...new Set(found)].filter(value => !/^20\d{2}$/.test(value));
}

function combineMultipart(items) {
  const groups = new Map();
  const singles = [];

  for (const message of items) {
    if (!message.multipart) {
      singles.push({ ...message, partsFound: 1 });
      continue;
    }

    const key = [
      message.type,
      message.address,
      message.reference,
      message.total
    ].join("|");

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(message);
  }

  for (const parts of groups.values()) {
    parts.sort((a, b) => a.part - b.part);

    const base = { ...parts[0] };
    const byPart = new Map(parts.map(part => [part.part, part]));

    base.index = Math.min(...parts.map(part => part.index));
    base.timestamp =
      parts.map(part => part.timestamp).filter(Boolean).sort().at(-1) || "";
    base.text = "";

    for (let partNumber = 1; partNumber <= base.total; partNumber++) {
      const part = byPart.get(partNumber);
      base.text += part ? part.text : `[MISSING PART ${partNumber}]`;
    }

    base.partsFound = parts.length;
    base.multipart = true;
    singles.push(base);
  }

  return singles;
}

function filteredMessages() {
  const query = search.value.trim().toLowerCase();

  const filtered = messages.filter(message => {
    if (direction.value !== "all" && message.type !== direction.value) {
      return false;
    }

    const haystack = [
      message.address,
      message.timestamp,
      message.text,
      message.encoding
    ]
      .join(" ")
      .toLowerCase();

    if (query && !haystack.includes(query)) {
      return false;
    }

    if (codeFilter && codes(message.text).length === 0) {
      return false;
    }

    return true;
  });

  if (sort.value === "newest") {
    filtered.sort(
      (a, b) =>
        (b.timestamp || "").localeCompare(a.timestamp || "") ||
        b.index - a.index
    );
  } else if (sort.value === "oldest") {
    filtered.sort(
      (a, b) =>
        (a.timestamp || "").localeCompare(b.timestamp || "") ||
        a.index - b.index
    );
  } else {
    filtered.sort((a, b) => a.index - b.index);
  }

  return filtered;
}

function copyText(value, button) {
  navigator.clipboard.writeText(value).then(() => {
    const original = button.textContent;
    button.textContent = "Copied";
    button.classList.add("copied");

    setTimeout(() => {
      button.textContent = original;
      button.classList.remove("copied");
    }, 1200);
  });
}

function verificationCenterHtml(detectedCodes) {
  if (!detectedCodes.length) {
    return "";
  }

  if (detectedCodes.length === 1) {
    const code = detectedCodes[0];

    return `
      <section class="verification-center">
        <div class="verification-label">Verification Code</div>
        <div class="verification-code">${safe(code)}</div>
        <button class="verification-copy" type="button" data-copy="${safe(code)}">
          COPY CODE
        </button>
      </section>
    `;
  }

  return `
    <section class="verification-center">
      <div class="verification-label">Verification Codes</div>
      <div class="verification-list">
        ${detectedCodes
          .map(
            code => `
              <div class="verification-item">
                <div class="verification-code verification-code-small">${safe(code)}</div>
                <button class="verification-copy verification-copy-small" type="button" data-copy="${safe(code)}">
                  COPY
                </button>
              </div>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function showDetail(message) {
  const detectedUrls = urls(message.text);
  const detectedCodes = codes(message.text);

  const verificationHtml = verificationCenterHtml(detectedCodes);

  const codeHtml = detectedCodes.length
    ? detectedCodes
        .map(
          code =>
            `<span class="token">${safe(code)}<button class="copy" data-copy="${safe(code)}">Copy</button></span>`
        )
        .join("")
    : "None detected";

  const linksHtml = detectedUrls.length
    ? detectedUrls
        .map(
          url =>
            `<div><a href="${safe(url)}" target="_blank" rel="noopener noreferrer">${safe(url)}</a></div>`
        )
        .join("")
    : "<div>None detected</div>";

  detail.innerHTML = `
    <h2>${safe(message.address || "Unknown")}</h2>
    <div class="sub">
      ${safe(message.timestamp || "No timestamp")}
      · ${message.type === "SMS-DELIVER" ? "Incoming" : "Outgoing"}
      · ${safe(message.encoding || "Unknown encoding")}
      · Index ${message.index}
      ${message.multipart ? ` · ${message.partsFound}/${message.total} parts` : ""}
    </div>
    ${verificationHtml}
    <div class="message">${safe(message.text || message.error || "(no text)")}</div>
    <div class="extract"><h3>Detected codes</h3>${codeHtml}</div>
    <div class="extract"><h3>Detected links</h3>${linksHtml}</div>
  `;

  detail.querySelectorAll("[data-copy]").forEach(button => {
    button.addEventListener("click", () => {
      copyText(button.dataset.copy, button);
    });
  });
}

function render() {
  const data = filteredMessages();

  count.textContent = `${data.length} shown · ${messages.length} logical messages · ${rawMessages.length} stored parts`;
  list.innerHTML = "";

  if (!data.length) {
    list.innerHTML = '<div class="empty">No matching messages.</div>';
    detail.innerHTML = '<div class="empty">No message selected.</div>';
    return;
  }

  let selected = data.find(message => messageKey(message) === selectedKey);

  if (!selected) {
    selected = data[0];
    selectedKey = messageKey(selected);
  }

  for (const message of data) {
    const row = document.createElement("div");
    const key = messageKey(message);
    const incoming = message.type === "SMS-DELIVER";
    const firstCode = codes(message.text)[0] || "";

    row.className = `row${key === selectedKey ? " active" : ""}`;
    row.innerHTML = `
      <div class="date">
        ${safe(message.timestamp || "No timestamp")}<br>
        <span class="badge ${incoming ? "in" : "out"}">
          ${incoming ? "Incoming" : "Outgoing"}
        </span>
      </div>
      <div class="address">${safe(message.address || "Unknown")}</div>
      <div class="preview">${safe(message.text || message.error || "(no text)")}</div>
      <div class="meta">
        ${firstCode ? `Code: ${safe(firstCode)}` : ""}
        ${message.multipart ? `<br>${message.partsFound}/${message.total} parts` : ""}
      </div>
    `;

    row.addEventListener("click", () => {
      selectedKey = key;
      showDetail(message);
      render();
    });

    list.appendChild(row);
  }

  showDetail(selected);
}

async function loadInbox() {
  try {
    status.textContent = "Loading…";

    const response = await fetch("http://localhost:3000/api/messages", { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data || !Array.isArray(data.messages)) {
      throw new Error("The server returned an unexpected message format.");
    }

    rawMessages = data.messages;
    messages = combineMultipart(rawMessages);

    status.textContent = "Connected";
    render();
    return true;
  } catch (error) {
    status.textContent = "Disconnected";
    list.innerHTML = `<div class="error">Could not load inbox: ${safe(error.message)}</div>`;
    count.textContent = "Inbox unavailable";
    return false;
  }
}

async function checkForInboxUpdate() {
  try {
    const response = await fetch("http://localhost:3000/api/version", { cache: "no-store" });

    if (!response.ok) {
      return;
    }

    const version = (await response.text()).trim();

    if (inboxVersion === null) {
      inboxVersion = version;
      return;
    }

    if (version && version !== inboxVersion) {
      inboxVersion = version;
      await loadInbox();
    }
  } catch {
    status.textContent = "Reconnecting…";
  }
}

search.addEventListener("input", render);

direction.addEventListener("change", () => {
  selectedKey = null;
  render();
});

sort.addEventListener("change", render);

codesOnly.addEventListener("click", () => {
  codeFilter = !codeFilter;
  codesOnly.textContent = `Codes only: ${codeFilter ? "On" : "Off"}`;
  codesOnly.classList.toggle("active", codeFilter);
  selectedKey = null;
  render();
});

async function startUp() {
  // Keep retrying the initial load until it actually succeeds. Without
  // this, if the backend isn't ready yet the instant the page loads
  // (very common right after starting the servers), the page would
  // show "Disconnected" forever and never automatically recover.
  let connected = await loadInbox();

  while (!connected) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    connected = await loadInbox();
  }

  await checkForInboxUpdate();
  setInterval(checkForInboxUpdate, 1500);
}

startUp();
