#include "InboxWriter.h"

#include <shellapi.h>
#include <windows.h>

#include <algorithm>
#include <fstream>
#include <iomanip>
#include <map>
#include <sstream>
#include <tuple>

#pragma comment(lib, "shell32.lib")

std::wstring DesktopOutputStem()
{
    wchar_t userProfile[MAX_PATH]{};
    DWORD size = MAX_PATH;

    if (!GetEnvironmentVariableW(L"USERPROFILE", userProfile, size))
    {
        return L"Heartland-SMS-Decoded";
    }

    SYSTEMTIME st{};
    GetLocalTime(&st);

    wchar_t filename[128];
    swprintf_s(
        filename,
        L"Heartland-SMS-Decoded-%04d%02d%02d-%02d%02d%02d",
        st.wYear,
        st.wMonth,
        st.wDay,
        st.wHour,
        st.wMinute,
        st.wSecond);

    return std::wstring(userProfile) + L"\\Desktop\\" + filename;
}

std::string ToUtf8(const std::wstring& value)
{
    if (value.empty()) return {};

    int required = WideCharToMultiByte(
        CP_UTF8,
        0,
        value.data(),
        static_cast<int>(value.size()),
        nullptr,
        0,
        nullptr,
        nullptr);

    if (required <= 0) return {};

    std::string output(static_cast<size_t>(required), '\0');

    WideCharToMultiByte(
        CP_UTF8,
        0,
        value.data(),
        static_cast<int>(value.size()),
        output.data(),
        required,
        nullptr,
        nullptr);

    return output;
}

std::string CsvField(const std::wstring& value)
{
    std::string utf8 = ToUtf8(value);
    bool quote = utf8.find_first_of(",\"\r\n") != std::string::npos;

    size_t position = 0;
    while ((position = utf8.find('"', position)) != std::string::npos)
    {
        utf8.insert(position, 1, '"');
        position += 2;
    }

    return quote ? "\"" + utf8 + "\"" : utf8;
}

std::wstring DisplayAddress(const DecodedSms& decoded)
{
    return !decoded.sender.empty() ? decoded.sender : decoded.recipient;
}


std::string JsonEscape(const std::wstring& value)
{
    std::string utf8 = ToUtf8(value);
    std::ostringstream escaped;

    for (unsigned char ch : utf8)
    {
        switch (ch)
        {
        case '"':  escaped << "\\\""; break;
        case '\\': escaped << "\\\\"; break;
        case '\b': escaped << "\\b"; break;
        case '\f': escaped << "\\f"; break;
        case '\n': escaped << "\\n"; break;
        case '\r': escaped << "\\r"; break;
        case '\t': escaped << "\\t"; break;
        default:
            if (ch < 0x20)
            {
                escaped << "\\u"
                        << std::hex << std::setw(4) << std::setfill('0')
                        << static_cast<int>(ch)
                        << std::dec << std::setfill(' ');
            }
            else
            {
                escaped << static_cast<char>(ch);
            }
        }
    }

    return escaped.str();
}

void WriteDecodedFiles(
    const std::vector<SmsEventSink::RawMessage>& messages,
    const std::wstring& outputStem)
{
    std::ofstream text(ToUtf8(outputStem + L".txt"), std::ios::binary);
    std::ofstream csv(ToUtf8(outputStem + L".csv"), std::ios::binary);
    std::ofstream html(ToUtf8(outputStem + L".html"), std::ios::binary);

    // UTF-8 BOM makes Excel and Notepad detect Unicode reliably.
    text.write("\xEF\xBB\xBF", 3);
    csv.write("\xEF\xBB\xBF", 3);

    text << "Heartland SMS Reader - decoded output\n";
    text << "Messages returned: " << messages.size() << "\n\n";

    csv << "ModemIndex,Status,Type,Address,Timestamp,Encoding,"
           "MultipartReference,Part,Total,Text,DecodeError,RawPdu\n";

    struct MultipartKey
    {
        std::wstring address;
        int reference;
        int total;

        bool operator<(const MultipartKey& other) const
        {
            return std::tie(address, reference, total) <
                   std::tie(other.address, other.reference, other.total);
        }
    };

    std::map<MultipartKey, std::map<int, std::wstring>> multipartParts;
    std::ostringstream json;
    json << "[";

    bool firstJson = true;

    for (const auto& message : messages)
    {
        DecodedSms decoded = PduDecoder::Decode(message.pdu);
        std::wstring address = DisplayAddress(decoded);

        text << "Index: " << message.index << "\n";
        text << "Store status enum: " << message.status << "\n";
        text << "Type: " << ToUtf8(decoded.messageType) << "\n";
        text << "Address: " << ToUtf8(address) << "\n";
        text << "Timestamp: " << ToUtf8(decoded.timestamp) << "\n";
        text << "Encoding: " << ToUtf8(decoded.encoding) << "\n";

        if (decoded.isMultipart)
        {
            text << "Multipart: part " << decoded.concatPart
                 << " of " << decoded.concatTotal
                 << ", reference " << decoded.concatReference << "\n";

            multipartParts[
                {address, decoded.concatReference, decoded.concatTotal}
            ][decoded.concatPart] = decoded.text;
        }

        if (decoded.success)
        {
            text << "Text:\n" << ToUtf8(decoded.text) << "\n";
        }
        else
        {
            text << "Decode error: " << ToUtf8(decoded.error) << "\n";
        }

        text << "Raw PDU: " << ToUtf8(message.pdu) << "\n";
        text << "------------------------------------------------------------\n";

        csv << message.index << ','
            << message.status << ','
            << CsvField(decoded.messageType) << ','
            << CsvField(address) << ','
            << CsvField(decoded.timestamp) << ','
            << CsvField(decoded.encoding) << ',';

        if (decoded.isMultipart)
        {
            csv << decoded.concatReference << ','
                << decoded.concatPart << ','
                << decoded.concatTotal << ',';
        }
        else
        {
            csv << ",,,";
        }

        csv << CsvField(decoded.text) << ','
            << CsvField(decoded.error) << ','
            << CsvField(message.pdu) << '\n';

        if (!firstJson) json << ",";
        firstJson = false;

        json << "{"
             << "\"index\":" << message.index << ","
             << "\"status\":" << message.status << ","
             << "\"type\":\"" << JsonEscape(decoded.messageType) << "\","
             << "\"address\":\"" << JsonEscape(address) << "\","
             << "\"timestamp\":\"" << JsonEscape(decoded.timestamp) << "\","
             << "\"encoding\":\"" << JsonEscape(decoded.encoding) << "\","
             << "\"text\":\"" << JsonEscape(decoded.text) << "\","
             << "\"error\":\"" << JsonEscape(decoded.error) << "\","
             << "\"multipart\":" << (decoded.isMultipart ? "true" : "false") << ","
             << "\"reference\":" << decoded.concatReference << ","
             << "\"part\":" << decoded.concatPart << ","
             << "\"total\":" << decoded.concatTotal
             << "}";
    }

    json << "]";

    if (!multipartParts.empty())
    {
        text << "\n\nCOMBINED MULTIPART MESSAGES\n";
        text << "============================================================\n";

        for (const auto& [key, parts] : multipartParts)
        {
            text << "Address: " << ToUtf8(key.address) << "\n";
            text << "Reference: " << key.reference << "\n";
            text << "Expected parts: " << key.total << "\n";
            text << "Parts found: " << parts.size() << "\n";
            text << "Combined text:\n";

            for (int part = 1; part <= key.total; ++part)
            {
                auto found = parts.find(part);
                if (found != parts.end())
                {
                    text << ToUtf8(found->second);
                }
                else
                {
                    text << "[MISSING PART " << part << "]";
                }
            }

            text << "\n------------------------------------------------------------\n";
        }
    }

    html << R"HTML(<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Heartland SMS Inbox</title>
<style>
:root{font-family:Segoe UI,Arial,sans-serif;color:#172033;background:#eef2f7}
*{box-sizing:border-box}
body{margin:0}
header{background:#152238;color:#fff;padding:18px 24px;display:flex;align-items:center;gap:16px;justify-content:space-between}
header h1{font-size:21px;margin:0}
header .count{opacity:.8}
.toolbar{padding:14px 18px;background:#fff;border-bottom:1px solid #d8dee8;display:flex;gap:10px;flex-wrap:wrap}
input,select,button{font:inherit;border:1px solid #b8c1cf;border-radius:7px;padding:9px 11px;background:#fff}
input{min-width:300px;flex:1}
button{cursor:pointer}
.layout{display:grid;grid-template-columns:minmax(500px,1.15fr) minmax(340px,.85fr);height:calc(100vh - 160px)}
.list{overflow:auto;border-right:1px solid #d8dee8;background:#fff}
.row{display:grid;grid-template-columns:155px 150px 1fr 120px;gap:12px;padding:12px 16px;border-bottom:1px solid #edf0f5;cursor:pointer;align-items:start}
.row:hover,.row.active{background:#edf5ff}
.date,.address,.meta{font-size:12px;color:#5e697a}
.preview{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{display:inline-block;border-radius:999px;padding:3px 8px;font-size:11px;background:#e7edf6}
.badge.in{background:#dff4e8;color:#17633c}
.badge.out{background:#ece8ff;color:#4a3594}
.detail{padding:22px;overflow:auto}
.detail h2{font-size:19px;margin:0 0 5px}
.detail .sub{color:#657083;margin-bottom:18px}
.message{white-space:pre-wrap;font-size:16px;line-height:1.5;background:#fff;border:1px solid #d8dee8;border-radius:10px;padding:18px}
.extract{margin-top:16px;background:#fff;border:1px solid #d8dee8;border-radius:10px;padding:14px}
.extract h3{font-size:14px;margin:0 0 10px}
.token{display:inline-block;padding:5px 9px;margin:3px;border-radius:6px;background:#f1f5fa;font-family:Consolas,monospace}
.empty{padding:30px;color:#687386}
.statusbar{padding:8px 18px;background:#e8f3eb;color:#245c35;border-bottom:1px solid #c9dfcf;font-size:13px;display:flex;gap:18px;flex-wrap:wrap}
a{color:#1459a6}
@media(max-width:900px){.layout{display:block;height:auto}.list{max-height:55vh;border-right:0}.detail{min-height:45vh}.row{grid-template-columns:120px 120px 1fr}.row .meta{display:none}}
</style>
</head>
<body>
<header>
  <h1>Heartland SMS Inbox</h1>
  <div class="count" id="count"></div>
</header>
<div class="toolbar">
  <input id="search" placeholder="Search sender, message, URL, or code">
  <select id="direction">
    <option value="all">All messages</option>
    <option value="SMS-DELIVER">Incoming</option>
    <option value="SMS-SUBMIT">Outgoing</option>
  </select>
  <select id="sort">
    <option value="newest">Newest first</option>
    <option value="oldest">Oldest first</option>
    <option value="index">Modem index</option>
  </select>
  <button id="codesOnly">Codes only: Off</button>
</div>
<div class="statusbar">
  <span><strong>Connected</strong></span>
  <span id="statusMessages"></span>
  <span id="statusClock"></span>
  <span>Refresh: every 5 seconds</span>
</div>
<div class="layout">
  <div class="list" id="list"></div>
  <div class="detail" id="detail"><div class="empty">Select a message.</div></div>
</div>
<script>
const rawMessages=
)HTML";

    html << json.str();

    html << R"HTML(;
function combineMultipart(items){
  const groups=new Map(), singles=[];
  for(const m of items){
    if(!m.multipart){singles.push({...m,partsFound:1});continue}
    const key=[m.type,m.address,m.reference,m.total,m.timestamp].join("|");
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(m);
  }
  for(const parts of groups.values()){
    parts.sort((a,b)=>a.part-b.part);
    const base={...parts[0]};
    base.index=Math.min(...parts.map(x=>x.index));
    base.text=parts.map((x,i)=>x.part===i+1?x.text:`[MISSING PART ${i+1}]`).join("");
    base.partsFound=parts.length;
    base.multipart=true;
    singles.push(base);
  }
  return singles;
}
const messages=combineMultipart(rawMessages);
const list=document.getElementById("list");
const detail=document.getElementById("detail");
const search=document.getElementById("search");
const direction=document.getElementById("direction");
const sort=document.getElementById("sort");
const count=document.getElementById("count");
const codesOnly=document.getElementById("codesOnly");
const statusMessages=document.getElementById("statusMessages");
const statusClock=document.getElementById("statusClock");
let selected=null, codeFilter=false;

function urls(text){return [...new Set((text.match(/https?:\/\/[^\s<>"']+/gi)||[]))]}
function codes(text){
 const found=[];
 const keyed=/(?:code|password|passcode|pin|presale|unlock|verification|verify|otp)[\s:=-]*([A-Z0-9][A-Z0-9_-]{3,20})/gi;
 let m; while((m=keyed.exec(text))) found.push(m[1]);
 const numeric=text.match(/\b\d{4,8}\b/g)||[];
 for(const n of numeric) found.push(n);
 return [...new Set(found)].filter(x=>!/^20\d{2}$/.test(x));
}
function safe(s){const d=document.createElement("div");d.textContent=s||"";return d.innerHTML}
function filtered(){
 const q=search.value.trim().toLowerCase();
 let data=messages.filter(m=>{
   if(direction.value!=="all"&&m.type!==direction.value)return false;
   const hay=[m.address,m.timestamp,m.text,m.encoding].join(" ").toLowerCase();
   if(q&&!hay.includes(q))return false;
   if(codeFilter&&codes(m.text).length===0)return false;
   return true;
 });
 if(sort.value==="newest") data.sort((a,b)=>(b.timestamp||"").localeCompare(a.timestamp||"")||b.index-a.index);
 if(sort.value==="oldest") data.sort((a,b)=>(a.timestamp||"").localeCompare(b.timestamp||"")||a.index-b.index);
 if(sort.value==="index") data.sort((a,b)=>a.index-b.index);
 return data;
}
function render(){
 const data=filtered();
 count.textContent=`${data.length} shown · ${messages.length} logical messages`;
 list.innerHTML="";
 if(!data.length){list.innerHTML='<div class="empty">No matching messages.</div>';return}
 for(const m of data){
   const row=document.createElement("div");
   row.className="row"+(selected===m?" active":"");
   const dir=m.type==="SMS-DELIVER"?"Incoming":"Outgoing";
   const code=codes(m.text)[0]||"";
   row.innerHTML=`<div class="date">${safe(m.timestamp||"No timestamp")}<br><span class="badge ${dir==="Incoming"?"in":"out"}">${dir}</span></div>
   <div class="address">${safe(m.address||"Unknown")}</div>
   <div class="preview">${safe(m.text||m.error||"(no text)")}</div>
   <div class="meta">${code?`Code: ${safe(code)}`:""}${m.multipart?`<br>${m.partsFound}/${m.total} parts`:""}</div>`;
   row.onclick=()=>{selected=m;showDetail(m);render()};
   list.appendChild(row);
 }
 if(!selected&&data.length){selected=data[0];showDetail(selected)}
}
function showDetail(m){
 const us=urls(m.text), cs=codes(m.text);
 const linkHtml=us.length?us.map(u=>`<div><a href="${safe(u)}" target="_blank">${safe(u)}</a></div>`):"<div>None detected</div>";
 const codeHtml=cs.length?cs.map(c=>`<span class="token">${safe(c)}</span>`).join(""):"None detected";
 detail.innerHTML=`<h2>${safe(m.address||"Unknown")}</h2>
 <div class="sub">${safe(m.timestamp||"No timestamp")} · ${m.type==="SMS-DELIVER"?"Incoming":"Outgoing"} · ${safe(m.encoding)} · Index ${m.index}${m.multipart?` · ${m.partsFound}/${m.total} parts`:""}</div>
 <div class="message">${safe(m.text||m.error||"(no text)")}</div>
 <div class="extract"><h3>Detected codes</h3>${codeHtml}</div>
 <div class="extract"><h3>Detected links</h3>${linkHtml}</div>`;
}
search.oninput=render;
direction.onchange=()=>{selected=null;render()};
sort.onchange=render;
codesOnly.onclick=()=>{codeFilter=!codeFilter;codesOnly.textContent=`Codes only: ${codeFilter?"On":"Off"}`;selected=null;render()};
function updateStatus(){
 statusMessages.textContent=`Messages: ${messages.length}`;
 statusClock.textContent=`Page checked: ${new Date().toLocaleTimeString()}`;
}
render();
updateStatus();
setInterval(updateStatus,1000);
setTimeout(()=>location.reload(),5000);
</script>
</body>
</html>)HTML";





    }

std::wstring WriteOutputsAndLaunch(
    const std::vector<SmsEventSink::RawMessage>& messages)
{
    std::wstring outputStem = DesktopOutputStem();
    WriteDecodedFiles(messages, outputStem);

    ShellExecuteW(
        nullptr,
        L"open",
        (outputStem + L".html").c_str(),
        nullptr,
        nullptr,
        SW_SHOWNORMAL);

    return outputStem;
}
