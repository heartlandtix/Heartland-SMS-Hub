# Heartland SMS Hub

Heartland SMS Hub reads SMS messages from a Windows Mobile Broadband modem, decodes them, continuously monitors for new messages, and serves the searchable inbox to web browsers on the local network.

## Build

1. Extract the project completely.
2. Open `HeartlandSmsReader.slnx` in Visual Studio.
3. Choose **Build > Rebuild Solution**.
4. Choose **Debug > Start Without Debugging**.

## Test on the Hub computer

Open:

- `http://localhost:8080/health` — should say the Hub is running.
- `http://localhost:8080/` — should show the SMS inbox.

## Allow other computers on the same private network

Run `ALLOW-PORT-8080-PRIVATE.bat` as Administrator. Then find the Hub computer IPv4 address by running `ipconfig`. On another computer, browse to:

`http://HUB-IP-ADDRESS:8080/`

Example: `http://192.168.1.50:8080/`

Do not forward port 8080 through the router or expose it to the public Internet. Authentication is not implemented yet.

## How the web server works

The executable listens on all local IPv4 interfaces at TCP port 8080. It rereads the generated inbox HTML from disk for every browser request, so new messages become visible after the page's five-second refresh.

## Stop

Click the console window and press `Q`.
