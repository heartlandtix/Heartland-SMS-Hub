#pragma once

#include <windows.h>
#include <atlbase.h>
#include <atlcom.h>
#pragma warning(disable: 4995)
#include <mbnapi.h>

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <string>
#include <vector>

class SmsEventSink final : public IMbnSmsEvents
{
public:
    SmsEventSink() : refCount_(1) {}

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override
    {
        if (!ppv) return E_POINTER;
        *ppv = nullptr;

        if (riid == IID_IUnknown || riid == __uuidof(IMbnSmsEvents))
        {
            *ppv = static_cast<IMbnSmsEvents*>(this);
            AddRef();
            return S_OK;
        }

        return E_NOINTERFACE;
    }

    STDMETHODIMP_(ULONG) AddRef() override
    {
        return ++refCount_;
    }

    STDMETHODIMP_(ULONG) Release() override
    {
        ULONG value = --refCount_;
        if (value == 0) delete this;
        return value;
    }

    STDMETHODIMP OnSmsConfigurationChange(IMbnSms*) override
    {
        return S_OK;
    }

    STDMETHODIMP OnSetSmsConfigurationComplete(
        IMbnSms*, ULONG, HRESULT) override
    {
        return S_OK;
    }

    STDMETHODIMP OnSmsStatusChange(IMbnSms* sms) override
    {
        UNREFERENCED_PARAMETER(sms);
        return S_OK;
    }

    STDMETHODIMP OnSmsSendComplete(
        IMbnSms*, ULONG, HRESULT) override
    {
        return S_OK;
    }

    STDMETHODIMP OnSmsReadComplete(
        IMbnSms*,
        MBN_SMS_FORMAT smsFormat,
        SAFEARRAY* readMsgs,
        VARIANT_BOOL moreMsgs,
        ULONG requestID,
        HRESULT status) override
    {
        UNREFERENCED_PARAMETER(requestID);
        std::lock_guard<std::mutex> lock(mutex_);

        if (FAILED(status))
        {
            finalStatus_ = status;
            complete_ = true;
            cv_.notify_all();
            return S_OK;
        }

        if (smsFormat != MBN_SMS_FORMAT_PDU || !readMsgs)
        {
            finalStatus_ = E_UNEXPECTED;
            complete_ = true;
            cv_.notify_all();
            return S_OK;
        }

        LONG lower = 0;
        LONG upper = -1;

        if (SUCCEEDED(SafeArrayGetLBound(readMsgs, 1, &lower)) &&
            SUCCEEDED(SafeArrayGetUBound(readMsgs, 1, &upper)))
        {
            for (LONG i = lower; i <= upper; ++i)
            {
                IUnknown* raw = nullptr;
                if (FAILED(SafeArrayGetElement(readMsgs, &i, &raw)) || !raw)
                {
                    continue;
                }

                CComPtr<IUnknown> holder;
                holder.Attach(raw);

                CComPtr<IMbnSmsReadMsgPdu> message;
                if (FAILED(holder->QueryInterface(
                        __uuidof(IMbnSmsReadMsgPdu),
                        reinterpret_cast<void**>(&message))))
                {
                    continue;
                }

                ULONG index = 0;
                MBN_MSG_STATUS messageStatus{};
                CComBSTR pdu;

                message->get_Index(&index);
                message->get_Status(&messageStatus);
                message->get_PduData(&pdu);

                messages_.push_back({
                    index,
                    static_cast<int>(messageStatus),
                    pdu ? std::wstring(pdu, pdu.Length()) : L""
                });
            }
        }

        if (moreMsgs == VARIANT_FALSE)
        {
            finalStatus_ = S_OK;
            complete_ = true;
            cv_.notify_all();
        }

        return S_OK;
    }

    STDMETHODIMP OnSmsDeleteComplete(
        IMbnSms*, ULONG, HRESULT) override
    {
        return S_OK;
    }

    STDMETHODIMP OnSmsNewClass0Message(
        IMbnSms*, MBN_SMS_FORMAT, SAFEARRAY*) override
    {
        return S_OK;
    }

    struct RawMessage
    {
        ULONG index;
        int status;
        std::wstring pdu;
    };

    bool Wait(DWORD milliseconds)
    {
        std::unique_lock<std::mutex> lock(mutex_);
        return cv_.wait_for(
            lock,
            std::chrono::milliseconds(milliseconds),
            [&] { return complete_; });
    }

    HRESULT FinalStatus() const
    {
        return finalStatus_;
    }

    std::vector<RawMessage> Messages()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return messages_;
    }

private:
    std::atomic<ULONG> refCount_;
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    bool complete_ = false;
    HRESULT finalStatus_ = E_PENDING;
    std::vector<RawMessage> messages_;
};

std::wstring HresultText(HRESULT hr);
