#include "HttpServer.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#pragma comment(lib, "ws2_32.lib")

namespace
{
constexpr SOCKET InvalidSocket = INVALID_SOCKET;

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

bool ReadWholeFile(const std::wstring& path, std::string& body)
{
    std::ifstream input(ToUtf8(path), std::ios::binary);
    if (!input) return false;

    std::ostringstream stream;
    stream << input.rdbuf();
    body = stream.str();
    return true;
}

void SendAll(SOCKET socket, const std::string& data)
{
    size_t sentTotal = 0;
    while (sentTotal < data.size())
    {
        int sent = send(
            socket,
            data.data() + sentTotal,
            static_cast<int>(data.size() - sentTotal),
            0);

        if (sent == SOCKET_ERROR || sent == 0) return;
        sentTotal += static_cast<size_t>(sent);
    }
}

std::string MakeResponse(
    int statusCode,
    const char* statusText,
    const char* contentType,
    const std::string& body)
{
    std::ostringstream response;
    response << "HTTP/1.1 " << statusCode << ' ' << statusText << "\r\n";
    response << "Content-Type: " << contentType << "\r\n";
    response << "Content-Length: " << body.size() << "\r\n";
    response << "Cache-Control: no-store, no-cache, must-revalidate\r\n";
    response << "Pragma: no-cache\r\n";
    response << "Connection: close\r\n\r\n";
    response << body;
    return response.str();
}
}

HttpServer::HttpServer() = default;

HttpServer::~HttpServer()
{
    Stop();
}

bool HttpServer::Start(unsigned short port, const std::wstring& htmlFilePath)
{
    if (running_) return true;

    WSADATA data{};
    int startupResult = WSAStartup(MAKEWORD(2, 2), &data);
    if (startupResult != 0)
    {
        std::wcerr << L"Web server: WSAStartup failed: " << startupResult << L"\n";
        return false;
    }

    SOCKET listenSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listenSocket == InvalidSocket)
    {
        std::wcerr << L"Web server: socket creation failed: " << WSAGetLastError() << L"\n";
        WSACleanup();
        return false;
    }

    BOOL reuseAddress = TRUE;
    setsockopt(
        listenSocket,
        SOL_SOCKET,
        SO_REUSEADDR,
        reinterpret_cast<const char*>(&reuseAddress),
        sizeof(reuseAddress));

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons(port);

    if (bind(
            listenSocket,
            reinterpret_cast<const sockaddr*>(&address),
            sizeof(address)) == SOCKET_ERROR)
    {
        std::wcerr << L"Web server: bind failed on port " << port
                   << L": " << WSAGetLastError() << L"\n";
        closesocket(listenSocket);
        WSACleanup();
        return false;
    }

    if (listen(listenSocket, SOMAXCONN) == SOCKET_ERROR)
    {
        std::wcerr << L"Web server: listen failed: " << WSAGetLastError() << L"\n";
        closesocket(listenSocket);
        WSACleanup();
        return false;
    }

    port_ = port;
    htmlFilePath_ = htmlFilePath;
    listenSocketValue_ = static_cast<unsigned long long>(listenSocket);
    running_ = true;
    worker_ = std::thread(&HttpServer::Run, this);
    return true;
}

void HttpServer::Stop()
{
    if (!running_.exchange(false)) return;

    SOCKET listenSocket = static_cast<SOCKET>(listenSocketValue_);
    if (listenSocket != InvalidSocket)
    {
        shutdown(listenSocket, SD_BOTH);
        closesocket(listenSocket);
        listenSocketValue_ = static_cast<unsigned long long>(InvalidSocket);
    }

    if (worker_.joinable()) worker_.join();
    WSACleanup();
}

bool HttpServer::IsRunning() const
{
    return running_;
}

void HttpServer::Run()
{
    SOCKET listenSocket = static_cast<SOCKET>(listenSocketValue_);

    while (running_)
    {
        sockaddr_in clientAddress{};
        int clientAddressLength = sizeof(clientAddress);

        SOCKET clientSocket = accept(
            listenSocket,
            reinterpret_cast<sockaddr*>(&clientAddress),
            &clientAddressLength);

        if (clientSocket == InvalidSocket)
        {
            if (running_)
            {
                std::wcerr << L"Web server: accept failed: " << WSAGetLastError() << L"\n";
            }
            break;
        }

        HandleClient(static_cast<unsigned long long>(clientSocket));
    }
}

void HttpServer::HandleClient(unsigned long long clientSocketValue)
{
    SOCKET clientSocket = static_cast<SOCKET>(clientSocketValue);

    char buffer[8192]{};
    int received = recv(clientSocket, buffer, static_cast<int>(sizeof(buffer) - 1), 0);
    if (received <= 0)
    {
        closesocket(clientSocket);
        return;
    }

    std::string request(buffer, static_cast<size_t>(received));
    std::istringstream requestStream(request);
    std::string method;
    std::string path;
    std::string version;
    requestStream >> method >> path >> version;

    std::string response;

    if (method != "GET")
    {
        response = MakeResponse(405, "Method Not Allowed", "text/plain; charset=utf-8", "GET only\n");
    }
    else if (path == "/health")
    {
        response = MakeResponse(200, "OK", "text/plain; charset=utf-8", "Heartland SMS Hub is running.\n");
    }
    else if (path == "/" || path == "/index.html")
    {
        std::string body;
        if (ReadWholeFile(htmlFilePath_, body))
        {
            response = MakeResponse(200, "OK", "text/html; charset=utf-8", body);
        }
        else
        {
            response = MakeResponse(
                503,
                "Service Unavailable",
                "text/plain; charset=utf-8",
                "The inbox file is not available yet. Refresh in a few seconds.\n");
        }
    }
    else
    {
        response = MakeResponse(404, "Not Found", "text/plain; charset=utf-8", "Not found\n");
    }

    SendAll(clientSocket, response);
    shutdown(clientSocket, SD_BOTH);
    closesocket(clientSocket);
}
