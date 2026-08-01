#pragma once

#include <atomic>
#include <string>
#include <thread>

class HttpServer
{
public:
    HttpServer();
    ~HttpServer();

    HttpServer(const HttpServer&) = delete;
    HttpServer& operator=(const HttpServer&) = delete;

    bool Start(unsigned short port, const std::wstring& htmlFilePath);
    void Stop();
    bool IsRunning() const;

private:
    void Run();
    void HandleClient(unsigned long long clientSocketValue);

    std::atomic<bool> running_{ false };
    std::thread worker_;
    unsigned short port_{ 0 };
    std::wstring htmlFilePath_;
    unsigned long long listenSocketValue_{ ~0ULL };
};
