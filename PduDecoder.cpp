#include "PduDecoder.h"
#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace
{
using Bytes = std::vector<std::uint8_t>;

int HexValue(wchar_t c)
{
    if (c >= L'0' && c <= L'9') return c - L'0';
    if (c >= L'a' && c <= L'f') return c - L'a' + 10;
    if (c >= L'A' && c <= L'F') return c - L'A' + 10;
    return -1;
}

Bytes HexToBytes(const std::wstring& input)
{
    std::wstring hex;
    for (wchar_t c : input)
        if (!iswspace(c)) hex.push_back(c);
    if (hex.size() % 2 != 0) throw std::runtime_error("PDU has an odd number of hexadecimal characters.");
    Bytes bytes;
    bytes.reserve(hex.size()/2);
    for (size_t i=0;i<hex.size();i+=2)
    {
        int hi=HexValue(hex[i]), lo=HexValue(hex[i+1]);
        if (hi<0||lo<0) throw std::runtime_error("PDU contains a non-hexadecimal character.");
        bytes.push_back(static_cast<std::uint8_t>((hi<<4)|lo));
    }
    return bytes;
}

std::wstring DecodeNumericAddress(const Bytes& b, size_t pos, int digits, std::uint8_t toa)
{
    std::wstring out;
    if ((toa & 0x70) == 0x10) out.push_back(L'+');
    int emitted=0;
    for (int i=0; emitted<digits; ++i)
    {
        std::uint8_t v=b.at(pos+i);
        int lo=v&0x0F, hi=(v>>4)&0x0F;
        if (lo<=9 && emitted++<digits) out.push_back(static_cast<wchar_t>(L'0'+lo));
        if (hi<=9 && emitted++<digits) out.push_back(static_cast<wchar_t>(L'0'+hi));
    }
    return out;
}

const std::array<wchar_t,128> Gsm7 = {
L'@',L'£',L'$',L'¥',L'è',L'é',L'ù',L'ì',L'ò',L'Ç',L'\n',L'Ø',L'ø',L'\r',L'Å',L'å',
L'Δ',L'_',L'Φ',L'Γ',L'Λ',L'Ω',L'Π',L'Ψ',L'Σ',L'Θ',L'Ξ',L'\0',L'Æ',L'æ',L'ß',L'É',
L' ',L'!',L'"',L'#',L'¤',L'%',L'&',L'\'',L'(',L')',L'*',L'+',L',',L'-',L'.',L'/',
L'0',L'1',L'2',L'3',L'4',L'5',L'6',L'7',L'8',L'9',L':',L';',L'<',L'=',L'>',L'?',
L'¡',L'A',L'B',L'C',L'D',L'E',L'F',L'G',L'H',L'I',L'J',L'K',L'L',L'M',L'N',L'O',
L'P',L'Q',L'R',L'S',L'T',L'U',L'V',L'W',L'X',L'Y',L'Z',L'Ä',L'Ö',L'Ñ',L'Ü',L'§',
L'¿',L'a',L'b',L'c',L'd',L'e',L'f',L'g',L'h',L'i',L'j',L'k',L'l',L'm',L'n',L'o',
L'p',L'q',L'r',L's',L't',L'u',L'v',L'w',L'x',L'y',L'z',L'ä',L'ö',L'ñ',L'ü',L'à'};

wchar_t Gsm7Extension(std::uint8_t c)
{
    switch(c){case 0x0A:return L'\f';case 0x14:return L'^';case 0x28:return L'{';case 0x29:return L'}';case 0x2F:return L'\\';case 0x3C:return L'[';case 0x3D:return L'~';case 0x3E:return L']';case 0x40:return L'|';case 0x65:return L'€';default:return L'�';}
}

std::wstring DecodeGsm7(const Bytes& data, size_t startBit, int septetCount)
{
    std::wstring out;
    bool escape=false;
    for(int i=0;i<septetCount;++i)
    {
        size_t bit=startBit+static_cast<size_t>(i)*7;
        size_t byteIndex=bit/8;
        int shift=static_cast<int>(bit%8);
        if(byteIndex>=data.size()) break;
        unsigned value=(data[byteIndex]>>shift)&0x7F;
        if(shift>1 && byteIndex+1<data.size()) value|=(data[byteIndex+1]<<(8-shift))&0x7F;
        auto s=static_cast<std::uint8_t>(value);
        if(escape){out.push_back(Gsm7Extension(s));escape=false;}
        else if(s==0x1B) escape=true;
        else out.push_back(Gsm7[s]);
    }
    if(escape) out.push_back(L'�');
    return out;
}

std::wstring DecodeUcs2(const Bytes& data, size_t pos, size_t count)
{
    std::wstring out;
    size_t end=std::min(data.size(),pos+count);
    for(size_t i=pos;i+1<end;i+=2)
    {
        std::uint16_t unit=(static_cast<std::uint16_t>(data[i])<<8)|data[i+1];
        out.push_back(static_cast<wchar_t>(unit));
    }
    return out;
}

std::wstring BytesToHex(const Bytes& data,size_t pos,size_t count)
{
    std::wostringstream s; s<<std::uppercase<<std::hex<<std::setfill(L'0');
    size_t end=std::min(data.size(),pos+count);
    for(size_t i=pos;i<end;++i) s<<std::setw(2)<<static_cast<int>(data[i]);
    return s.str();
}

int SwapDecimal(std::uint8_t b){return (b&0x0F)*10+((b>>4)&0x0F);}
std::wstring DecodeTimestamp(const Bytes& b,size_t pos)
{
    if(pos+7>b.size()) return L"";
    int yy=SwapDecimal(b[pos]), mon=SwapDecimal(b[pos+1]), day=SwapDecimal(b[pos+2]);
    int hour=SwapDecimal(b[pos+3]), minute=SwapDecimal(b[pos+4]), second=SwapDecimal(b[pos+5]);
    std::uint8_t tz=b[pos+6]; bool negative=(tz&0x08)!=0;
    int quarters=(tz&0x07)*10+((tz>>4)&0x0F); int mins=quarters*15;
    std::wostringstream s; s<<std::setfill(L'0')<<std::setw(4)<<(2000+yy)<<L'-'<<std::setw(2)<<mon<<L'-'<<std::setw(2)<<day<<L' '<<std::setw(2)<<hour<<L':'<<std::setw(2)<<minute<<L':'<<std::setw(2)<<second<<L' '<<(negative?L'-':L'+')<<std::setw(2)<<(mins/60)<<L':'<<std::setw(2)<<(mins%60);
    return s.str();
}

enum class Alphabet{Gsm7,EightBit,Ucs2,Unsupported};
Alphabet GetAlphabet(std::uint8_t dcs)
{
    if((dcs&0xC0)==0x00){switch((dcs>>2)&3){case 0:return Alphabet::Gsm7;case 1:return Alphabet::EightBit;case 2:return Alphabet::Ucs2;default:return Alphabet::Unsupported;}}
    if((dcs&0xF0)==0xF0) return (dcs&0x04)?Alphabet::EightBit:Alphabet::Gsm7;
    if((dcs&0xF0)==0xE0) return Alphabet::Ucs2;
    if((dcs&0xF0)==0xC0 || (dcs&0xF0)==0xD0) return Alphabet::Gsm7;
    return Alphabet::Unsupported;
}

void ParseUdh(const Bytes& data,size_t pos,size_t available,DecodedSms& result,size_t& headerOctets)
{
    headerOctets=0; if(available==0||pos>=data.size()) return;
    size_t udhl=data[pos]; headerOctets=udhl+1;
    if(headerOctets>available||pos+headerOctets>data.size()) throw std::runtime_error("User Data Header is truncated.");
    size_t p=pos+1,end=pos+headerOctets;
    while(p+2<=end){std::uint8_t iei=data[p++], len=data[p++];if(p+len>end) break;
        if(iei==0x00&&len==3){result.isMultipart=true;result.concatReference=data[p];result.concatTotal=data[p+1];result.concatPart=data[p+2];}
        else if(iei==0x08&&len==4){result.isMultipart=true;result.concatReference=(data[p]<<8)|data[p+1];result.concatTotal=data[p+2];result.concatPart=data[p+3];}
        p+=len;
    }
}

void DecodeUserData(const Bytes& bytes,size_t pos,int udl,std::uint8_t dcs,bool udhi,DecodedSms& result)
{
    Alphabet alphabet=GetAlphabet(dcs); size_t headerOctets=0;
    size_t available=bytes.size()>pos?bytes.size()-pos:0;
    if(udhi) ParseUdh(bytes,pos,available,result,headerOctets);
    if(alphabet==Alphabet::Gsm7)
    {
        result.encoding=L"GSM 7-bit";
        int headerSeptets=udhi?static_cast<int>((headerOctets*8+6)/7):0;
        int textSeptets=std::max(0,udl-headerSeptets);
        result.text=DecodeGsm7(bytes,pos*8+static_cast<size_t>(headerSeptets)*7,textSeptets);
    }
    else if(alphabet==Alphabet::Ucs2)
    {
        result.encoding=L"UCS-2";
        size_t count=static_cast<size_t>(std::max(0,udl));
        if(headerOctets>count) count=0; else count-=headerOctets;
        result.text=DecodeUcs2(bytes,pos+headerOctets,count);
    }
    else if(alphabet==Alphabet::EightBit)
    {
        result.encoding=L"8-bit data";
        size_t count=static_cast<size_t>(std::max(0,udl));
        if(headerOctets>count) count=0; else count-=headerOctets;
        result.text=L"[binary: "+BytesToHex(bytes,pos+headerOctets,count)+L"]";
    }
    else {result.encoding=L"Unsupported DCS";result.text=L"[undecoded user data]";}
}

DecodedSms DecodeDeliver(const Bytes& b,size_t pos,std::uint8_t first)
{
    DecodedSms r; r.messageType=L"SMS-DELIVER"; bool udhi=(first&0x40)!=0;
    int addrLen=b.at(pos++); std::uint8_t toa=b.at(pos++); size_t addrBytes=(addrLen+1)/2;
    if((toa&0x70)==0x50){r.sender=DecodeGsm7(b,pos*8,addrLen);addrBytes=(addrLen*7+7)/8;} else r.sender=DecodeNumericAddress(b,pos,addrLen,toa);
    pos += addrBytes; const std::uint8_t pid = b.at(pos++); (void)pid; std::uint8_t dcs = b.at(pos++); r.timestamp=DecodeTimestamp(b,pos); pos+=7; int udl=b.at(pos++);
    DecodeUserData(b,pos,udl,dcs,udhi,r); r.success=true; return r;
}

DecodedSms DecodeSubmit(const Bytes& b,size_t pos,std::uint8_t first)
{
    DecodedSms r; r.messageType=L"SMS-SUBMIT"; bool udhi=(first&0x40)!=0; pos++; // TP-MR
    int addrLen=b.at(pos++); std::uint8_t toa=b.at(pos++); size_t addrBytes=(addrLen+1)/2;
    r.recipient=DecodeNumericAddress(b,pos,addrLen,toa); pos += addrBytes; const std::uint8_t pid = b.at(pos++); (void)pid; std::uint8_t dcs = b.at(pos++);
    int vpf=(first>>3)&3; if(vpf==2) pos+=1; else if(vpf==1||vpf==3) pos+=7;
    int udl=b.at(pos++); DecodeUserData(b,pos,udl,dcs,udhi,r); r.success=true; return r;
}
}

DecodedSms PduDecoder::Decode(const std::wstring& hexPdu)
{
    try
    {
        Bytes b=HexToBytes(hexPdu); if(b.empty()) throw std::runtime_error("PDU is empty.");
        size_t pos=0; std::uint8_t scaLen=b.at(pos++); if(pos+scaLen>b.size()) throw std::runtime_error("SMSC address is truncated."); pos+=scaLen;
        std::uint8_t first=b.at(pos++); int mti=first&3;
        if(mti==0) return DecodeDeliver(b,pos,first);
        if(mti==1) return DecodeSubmit(b,pos,first);
        DecodedSms r; r.messageType=(mti==2?L"SMS-STATUS-REPORT":L"Reserved TPDU"); r.error=L"This TPDU type does not contain a normal text message decoder yet."; return r;
    }
    catch(const std::exception& ex)
    {
        DecodedSms r; r.error=std::wstring(ex.what(),ex.what()+std::char_traits<char>::length(ex.what())); return r;
    }
}
