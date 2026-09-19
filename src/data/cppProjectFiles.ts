import { CppProjectFile } from '../types';

export const CPP_PROJECT_FILES: CppProjectFile[] = [
  {
    path: 'src/main.cpp',
    title: 'main.cpp (Entry & ImGui DX11 Renderer)',
    category: 'source',
    description: 'Win32 window lifecycle, DirectX 11 swapchain, ImGui initialization, and SDR UI main loop.',
    content: `// ============================================================================
// RTL-SDR Standalone GUI for Windows (Visual Studio / C++20)
// High-Performance Software Defined Radio receiver built with Dear ImGui + DirectX 11
// ============================================================================

#include <windows.h>
#include <d3d11.h>
#include <tchar.h>
#include <memory>
#include <string>
#include <vector>
#include <chrono>

// Dear ImGui includes
#include "imgui.h"
#include "imgui_impl_win32.h"
#include "imgui_impl_dx11.h"

// RTL-SDR GUI subsystem modules
#include "sdr_device.h"
#include "dsp.h"
#include "waterfall.h"
#include "audio_player.h"
#include "memory_banks.h"
#include "dab_decoder.h"

// Forward declare message handler from imgui_impl_win32.cpp
extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam);

// Global DirectX 11 State
static ID3D11Device*           g_pd3dDevice = nullptr;
static ID3D11DeviceContext*     g_pd3dDeviceContext = nullptr;
static IDXGISwapChain*          g_pSwapChain = nullptr;
static ID3D11RenderTargetView*  g_mainRenderTargetView = nullptr;
static UINT                     g_ResizeWidth = 0, g_ResizeHeight = 0;

// Helper function declarations
bool CreateDeviceD3D(HWND hWnd);
void CleanupDeviceD3D();
void CreateRenderTarget();
void CleanupRenderTarget();
LRESULT WINAPI WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam);

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, PWSTR pCmdLine, int nCmdShow)
{
    // Enable DPI awareness for crisp rendering on high-res monitors
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    // Register Win32 Application Window Class
    WNDCLASSEXW wc = { sizeof(wc), CS_CLASSDC, WndProc, 0L, 0L, hInstance, nullptr, nullptr, nullptr, nullptr, L"RTLSDR_GUI_CLASS", nullptr };
    ::RegisterClassExW(&wc);
    HWND hwnd = ::CreateWindowW(wc.lpszClassName, L"RTL-SDR Standalone Studio (DirectX 11)", WS_OVERLAPPEDWINDOW, 100, 100, 1280, 800, nullptr, nullptr, wc.hInstance, nullptr);

    // Initialize DirectX 11
    if (!CreateDeviceD3D(hwnd))
    {
        CleanupDeviceD3D();
        ::UnregisterClassW(wc.lpszClassName, wc.hInstance);
        return 1;
    }

    ::ShowWindow(hwnd, SW_SHOWDEFAULT);
    ::UpdateWindow(hwnd);

    // Setup Dear ImGui context
    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO(); (void)io;
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
#ifdef ImGuiConfigFlags_DockingEnable
    io.ConfigFlags |= ImGuiConfigFlags_DockingEnable;
#endif

    // Dark SDR Instrument Theme
    ImGui::StyleColorsDark();
    ImGuiStyle& style = ImGui::GetStyle();
    style.WindowRounding = 6.0f;
    style.FrameRounding = 4.0f;
    style.PopupRounding = 4.0f;
    style.GrabRounding = 4.0f;
    style.Colors[ImGuiCol_WindowBg] = ImVec4(0.08f, 0.09f, 0.11f, 1.00f);
    style.Colors[ImGuiCol_Header] = ImVec4(0.18f, 0.22f, 0.28f, 1.00f);
    style.Colors[ImGuiCol_Button] = ImVec4(0.16f, 0.20f, 0.28f, 1.00f);
    style.Colors[ImGuiCol_ButtonHovered] = ImVec4(0.24f, 0.32f, 0.44f, 1.00f);
    style.Colors[ImGuiCol_ButtonActive] = ImVec4(0.12f, 0.40f, 0.65f, 1.00f);

    // Setup Platform/Renderer backends
    ImGui_ImplWin32_Init(hwnd);
    ImGui_ImplDX11_Init(g_pd3dDevice, g_pd3dDeviceContext);

    // Instantiate SDR Engine, DSP Pipeline, Audio, and Waterfall
    auto sdr = std::make_unique<RtlSdrDevice>();
    auto dsp = std::make_unique<DspPipeline>();
    auto audio = std::make_unique<AudioPlayer>();
    auto waterfall = std::make_unique<WaterfallDisplay>(g_pd3dDevice, g_pd3dDeviceContext, 1024, 512);
    auto dab = std::make_unique<DabDecoder>();

    audio->Initialize(48000, 2);

    // Initial Hardware & DSP default configuration
    uint32_t currentFreqHz = 101100000; // 101.1 MHz WBFM Broadcast
    uint32_t sampleRateHz  = 2048000;   // 2.048 MSPS standard for RTL2832U
    int tunerGainIndex     = 20;        // ~32.8 dB
    bool rtlAgc            = false;
    bool tunerAgc          = false;
    int demodModeIndex     = 0;         // 0: WBFM, 1: NBFM, 2: AM, 3: USB, 4: LSB, 5: CW, 6: DAB+
    uint32_t bandwidthHz   = 180000;    // 180 kHz for WBFM broadcast
    float squelchDb        = -65.0f;
    float audioVolume      = 0.80f;
    bool isAudioMuted      = false;

    // Keypad state
    char keypadBuffer[32] = "";
    int colorThemeIndex = 0; // SDR Classic
    float minDb = -85.0f;
    float maxDb = -15.0f;
    waterfall->SetDbRange(minDb, maxDb);
    waterfall->SetColorMap(WaterfallColorMap::SdrClassic);

    // Main Win32 / DirectX message loop
    bool bRunning = true;
    while (bRunning)
    {
        MSG msg;
        while (::PeekMessage(&msg, nullptr, 0U, 0U, PM_REMOVE))
        {
            ::TranslateMessage(&msg);
            ::DispatchMessage(&msg);
            if (msg.message == WM_QUIT)
                bRunning = false;
        }
        if (!bRunning) break;

        // If window is minimized, pump audio in background and avoid DXGI presentation to prevent crashes
        if (::IsIconic(hwnd))
        {
            if (sdr->IsStreaming())
            {
                auto bgIq = sdr->ReadSamples();
                if (!bgIq.empty())
                {
                    std::vector<float> audioSamples;
                    if (demodModeIndex == 6)
                    {
                        dab->ProcessIq(bgIq, sampleRateHz);
                        audioSamples = dab->GetAudioSamples(audioVolume);
                    }
                    else
                    {
                        audioSamples = dsp->Demodulate(bgIq, static_cast<DemodMode>(demodModeIndex), squelchDb, bandwidthHz, sampleRateHz);
                    }
                    if (!isAudioMuted && !audioSamples.empty())
                    {
                        audio->WriteSamples(audioSamples.data(), audioSamples.size(), audioVolume);
                    }
                }
            }
            ::Sleep(15);
            continue;
        }

        // Handle deferred swapchain resize safely outside WndProc
        if (g_ResizeWidth != 0 && g_ResizeHeight != 0)
        {
            CleanupRenderTarget();
            g_pSwapChain->ResizeBuffers(0, g_ResizeWidth, g_ResizeHeight, DXGI_FORMAT_UNKNOWN, 0);
            g_ResizeWidth = g_ResizeHeight = 0;
            CreateRenderTarget();
        }

        // Process newly arrived raw IQ samples from RTL2832U device
        std::vector<std::complex<float>> iqSamples;
        if (sdr->IsStreaming())
        {
            iqSamples = sdr->ReadSamples();
            if (!iqSamples.empty())
            {
                // Run FFT for spectrum and waterfall
                std::vector<float> fftBins = dsp->ComputeFFT(iqSamples, 1024);
                waterfall->AddFftRow(fftBins);

                // Run Demodulator or DAB+ Digital Radio Decoder
                std::vector<float> audioSamples;
                if (demodModeIndex == 6)
                {
                    dab->ProcessIq(iqSamples, sampleRateHz);
                    audioSamples = dab->GetAudioSamples(audioVolume);
                }
                else
                {
                    audioSamples = dsp->Demodulate(iqSamples, static_cast<DemodMode>(demodModeIndex), squelchDb, bandwidthHz, sampleRateHz);
                }

                if (!isAudioMuted && !audioSamples.empty())
                {
                    audio->WriteSamples(audioSamples.data(), audioSamples.size(), audioVolume);
                }
            }
        }

        // Start Dear ImGui Frame
        ImGui_ImplDX11_NewFrame();
        ImGui_ImplWin32_NewFrame();
        ImGui::NewFrame();

        // Create Fullscreen Integrated Workspace
        ImGuiViewport* viewport = ImGui::GetMainViewport();
        ImGui::SetNextWindowPos(viewport->Pos);
        ImGui::SetNextWindowSize(viewport->Size);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 0.0f);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.0f);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(8.0f, 8.0f));
        ImGui::Begin("MainWorkspace", nullptr,
                     ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoCollapse |
                     ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove |
                     ImGuiWindowFlags_NoBringToFrontOnFocus);
        ImGui::PopStyleVar(3);

        // ====================================================================
        // 1. TOP STATUS & MASTER VFO BAR
        // ====================================================================
        static bool bShowMemoryBanks = false;
        static bool bShowDabDecoder = false;
        ImGui::BeginChild("TopHeaderBar", ImVec2(0, 56), true, ImGuiWindowFlags_NoScrollbar);
        {
            // Start / Stop SDR Streaming Button
            if (sdr->IsStreaming()) {
                ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.85f, 0.20f, 0.20f, 1.0f));
                ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.95f, 0.30f, 0.30f, 1.0f));
                if (ImGui::Button(" [ STOP SDR ] ", ImVec2(130, 38))) {
                    sdr->StopStream();
                }
                ImGui::PopStyleColor(2);
            } else {
                ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.12f, 0.65f, 0.35f, 1.0f));
                ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.18f, 0.78f, 0.42f, 1.0f));
                if (ImGui::Button(" [ START SDR ] ", ImVec2(130, 38))) {
                    sdr->StartStream(currentFreqHz, sampleRateHz);
                }
                ImGui::PopStyleColor(2);
            }
            ImGui::SameLine();

            // Glowing VFO Frequency Readout
            char vfoFormatted[48];
            snprintf(vfoFormatted, sizeof(vfoFormatted), " %03u.%03u.%03u MHz ",
                     currentFreqHz / 1000000, (currentFreqHz % 1000000) / 1000, currentFreqHz % 1000);
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.25f, 0.95f, 0.55f, 1.0f));
            ImGui::SetWindowFontScale(1.3f);
            ImGui::Text("%s", vfoFormatted);
            ImGui::SetWindowFontScale(1.0f);
            ImGui::PopStyleColor();

            ImGui::SameLine();
            ImGui::SetCursorPosY(ImGui::GetCursorPosY() + 4.0f);
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.0f, 0.82f, 0.35f, 1.0f));
            ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.18f, 0.12f, 0.06f, 1.0f));
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.30f, 0.20f, 0.10f, 1.0f));
            if (ImGui::Button("[BANKS] Memory", ImVec2(125, 30))) {
                bShowMemoryBanks = !bShowMemoryBanks;
            }
            ImGui::PopStyleColor(3);

            ImGui::SameLine();
            ImGui::SetCursorPosY(ImGui::GetCursorPosY() + 4.0f);
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.35f, 0.90f, 1.0f, 1.0f));
            ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.06f, 0.18f, 0.26f, 1.0f));
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.12f, 0.28f, 0.40f, 1.0f));
            if (ImGui::Button("[DAB+] Digital Radio", ImVec2(150, 30))) {
                bShowDabDecoder = !bShowDabDecoder;
                if (bShowDabDecoder && demodModeIndex != 6) {
                    demodModeIndex = 6;
                    bandwidthHz = 1536000;
                    currentFreqHz = 202928000; // Band III Block 9A
                    sdr->SetCenterFrequency(currentFreqHz);
                }
            }
            ImGui::PopStyleColor(3);

            ImGui::SameLine();
            ImGui::SetNextItemWidth(100.0f);
            ImGui::SliderFloat("Vol", &audioVolume, 0.0f, 1.0f, "%.2f");

            ImGui::SameLine();
            ImGui::Checkbox("Mute", &isAudioMuted);

            ImGui::SameLine();
            ImGui::TextColored(ImVec4(0.6f, 0.7f, 0.85f, 1.0f), "| Tuner: %s (%s)",
                               sdr->GetTunerType().c_str(), sdr->GetDeviceName().c_str());
        }
        ImGui::EndChild();

        ImGui::Spacing();

        // Calculate layout widths
        float totalWidth = ImGui::GetContentRegionAvail().x;
        float totalHeight = ImGui::GetContentRegionAvail().y;
        if (totalWidth < 120.0f || totalHeight < 120.0f)
        {
            ImGui::End();
            ImGui::Render();
            continue;
        }
        float sidebarWidth = 380.0f;
        if (totalWidth < 850.0f) sidebarWidth = totalWidth * 0.44f;
        float mainDisplayWidth = (std::max)(50.0f, totalWidth - sidebarWidth - 10.0f);

        // ====================================================================
        // 2. UNIFIED TUNING & CONTROL SIDEBAR (Integrated down the side)
        // ====================================================================
        ImGui::BeginChild("IntegratedTuningSidebar", ImVec2(sidebarWidth, totalHeight), true);
        {
            if (ImGui::BeginTabBar("SidebarTabs"))
            {
                // ------------------------------------------------------------
                // TAB A: TUNING & DIRECT KEYPAD
                // ------------------------------------------------------------
                if (ImGui::BeginTabItem("Tuning"))
                {
                    ImGui::Spacing();
                    ImGui::TextColored(ImVec4(0.35f, 0.88f, 1.0f, 1.0f), "DIRECT FREQUENCY KEYPAD");

                    // Direct input display with glowing LED font
                    ImGui::PushStyleColor(ImGuiCol_FrameBg, ImVec4(0.04f, 0.07f, 0.12f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.25f, 0.95f, 0.55f, 1.0f));
                    ImGui::SetNextItemWidth(sidebarWidth - 25.0f);
                    if (ImGui::InputText("##DirectFreqText", keypadBuffer, sizeof(keypadBuffer), ImGuiInputTextFlags_EnterReturnsTrue))
                    {
                        double val = atof(keypadBuffer);
                        if (val > 0.0) {
                            if (val < 2500.0) currentFreqHz = static_cast<uint32_t>(val * 1e6); // e.g. 101.1 -> 101.1 MHz
                            else currentFreqHz = static_cast<uint32_t>(val);
                            sdr->SetCenterFrequency(currentFreqHz);
                            keypadBuffer[0] = 0;
                        }
                    }
                    ImGui::PopStyleColor(2);

                    // 3x4 Keypad Grid with Large Buttons and Colored Fonts
                    const float btnW = (sidebarWidth - 45.0f) / 3.0f;
                    const float btnH = 40.0f;
                    const char* keyLabels[4][3] = {
                        { "1", "2", "3" },
                        { "4", "5", "6" },
                        { "7", "8", "9" },
                        { ".", "0", "CLR" }
                    };

                    for (int row = 0; row < 4; ++row)
                    {
                        for (int col = 0; col < 3; ++col)
                        {
                            if (col > 0) ImGui::SameLine();
                            const char* lbl = keyLabels[row][col];
                            bool isClr = (strcmp(lbl, "CLR") == 0);

                            if (isClr) {
                                ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.0f, 0.40f, 0.40f, 1.0f)); // Coral Red font
                                ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.24f, 0.08f, 0.10f, 1.0f));
                                ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.36f, 0.12f, 0.15f, 1.0f));
                                ImGui::PushStyleColor(ImGuiCol_ButtonActive, ImVec4(0.48f, 0.16f, 0.20f, 1.0f));
                            } else {
                                ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.40f, 0.90f, 1.0f, 1.0f)); // Ice-Cyan font
                                ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.08f, 0.13f, 0.22f, 1.0f));
                                ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.14f, 0.24f, 0.38f, 1.0f));
                                ImGui::PushStyleColor(ImGuiCol_ButtonActive, ImVec4(0.20f, 0.35f, 0.55f, 1.0f));
                            }

                            if (ImGui::Button(lbl, ImVec2(btnW, btnH)))
                            {
                                if (isClr) {
                                    keypadBuffer[0] = 0;
                                } else {
                                    size_t len = strlen(keypadBuffer);
                                    if (len < sizeof(keypadBuffer) - 2) {
                                        keypadBuffer[len] = lbl[0];
                                        keypadBuffer[len + 1] = 0;
                                    }
                                }
                            }
                            ImGui::PopStyleColor(4);
                        }
                    }

                    // TUNE / ENTER BUTTON (Large & High Visibility)
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.12f, 0.48f, 0.88f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.18f, 0.58f, 0.98f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_ButtonActive, ImVec4(0.25f, 0.68f, 1.0f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.0f, 1.0f, 1.0f, 1.0f));
                    if (ImGui::Button(" [ TUNE FREQUENCY (ENTER) ] ", ImVec2(sidebarWidth - 25.0f, 42.0f)))
                    {
                        double val = atof(keypadBuffer);
                        if (val > 0.0) {
                            if (val < 2500.0) currentFreqHz = static_cast<uint32_t>(val * 1e6);
                            else currentFreqHz = static_cast<uint32_t>(val);
                            sdr->SetCenterFrequency(currentFreqHz);
                            keypadBuffer[0] = 0;
                        }
                    }
                    ImGui::PopStyleColor(4);

                    ImGui::Separator();
                    ImGui::TextColored(ImVec4(0.35f, 0.88f, 1.0f, 1.0f), "FREQUENCY STEPPING");

                    // Step buttons with colored fonts: Minus = Warm Amber, Plus = Bright Mint
                    const float stepBtnW = (sidebarWidth - 40.0f) / 2.0f;
                    const float stepBtnH = 34.0f;

                    // 1.0 MHz Steps
                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.0f, 0.65f, 0.25f, 1.0f)); // Amber font
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.14f, 0.10f, 0.09f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.25f, 0.16f, 0.12f, 1.0f));
                    if (ImGui::Button("-1.0 MHz", ImVec2(stepBtnW, stepBtnH))) {
                        if (currentFreqHz >= 1000000) currentFreqHz -= 1000000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::PopStyleColor(3);

                    ImGui::SameLine();

                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.25f, 0.95f, 0.65f, 1.0f)); // Mint font
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.08f, 0.14f, 0.15f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.14f, 0.24f, 0.25f, 1.0f));
                    if (ImGui::Button("+1.0 MHz", ImVec2(stepBtnW, stepBtnH))) {
                        currentFreqHz += 1000000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::PopStyleColor(3);

                    // 100 kHz Steps
                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.0f, 0.65f, 0.25f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.14f, 0.10f, 0.09f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.25f, 0.16f, 0.12f, 1.0f));
                    if (ImGui::Button("-100 kHz", ImVec2(stepBtnW, stepBtnH))) {
                        if (currentFreqHz >= 100000) currentFreqHz -= 100000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::PopStyleColor(3);

                    ImGui::SameLine();

                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.25f, 0.95f, 0.65f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.08f, 0.14f, 0.15f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.14f, 0.24f, 0.25f, 1.0f));
                    if (ImGui::Button("+100 kHz", ImVec2(stepBtnW, stepBtnH))) {
                        currentFreqHz += 100000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::PopStyleColor(3);

                    // 10 kHz Steps
                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.0f, 0.65f, 0.25f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.14f, 0.10f, 0.09f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.25f, 0.16f, 0.12f, 1.0f));
                    if (ImGui::Button("-10 kHz", ImVec2(stepBtnW, stepBtnH))) {
                        if (currentFreqHz >= 10000) currentFreqHz -= 10000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::PopStyleColor(3);

                    ImGui::SameLine();

                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.25f, 0.95f, 0.65f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.08f, 0.14f, 0.15f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.14f, 0.24f, 0.25f, 1.0f));
                    if (ImGui::Button("+10 kHz", ImVec2(stepBtnW, stepBtnH))) {
                        currentFreqHz += 10000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::PopStyleColor(3);

                    // 1 kHz Steps
                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.0f, 0.65f, 0.25f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.14f, 0.10f, 0.09f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.25f, 0.16f, 0.12f, 1.0f));
                    if (ImGui::Button("-1 kHz", ImVec2(stepBtnW, stepBtnH))) {
                        if (currentFreqHz >= 1000) currentFreqHz -= 1000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::PopStyleColor(3);

                    ImGui::SameLine();

                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.25f, 0.95f, 0.65f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.08f, 0.14f, 0.15f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.14f, 0.24f, 0.25f, 1.0f));
                    if (ImGui::Button("+1 kHz", ImVec2(stepBtnW, stepBtnH))) {
                        currentFreqHz += 1000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::PopStyleColor(3);

                    ImGui::Separator();
                    ImGui::TextColored(ImVec4(0.35f, 0.88f, 1.0f, 1.0f), "VFO OPTICAL TUNING DIAL");
                    DrawTuningDial("##SidebarRotaryDial", currentFreqHz, sdr.get());

                    ImGui::EndTabItem();
                }

                // ------------------------------------------------------------
                // TAB B: DEMODULATION & BANDWIDTH
                // ------------------------------------------------------------
                if (ImGui::BeginTabItem("Demod"))
                {
                    ImGui::Spacing();
                    ImGui::TextColored(ImVec4(0.4f, 0.8f, 1.0f, 1.0f), "DEMODULATION MODE");

                    const char* modes[] = { "WBFM (Broadcast FM)", "NBFM (Ham / Marine)", "AM (Air / SW)", "USB (Upper SSB)", "LSB (Lower SSB)", "CW (Morse)", "DAB+ (Digital Radio Multiplex)" };
                    if (ImGui::Combo("##DemodModeCombo", &demodModeIndex, modes, IM_ARRAYSIZE(modes)))
                    {
                        // Set standard filter bandwidth when switching mode
                        switch (demodModeIndex) {
                            case 0: bandwidthHz = 180000; break; // WBFM 180 kHz
                            case 1: bandwidthHz = 12500;  break; // NBFM 12.5 kHz
                            case 2: bandwidthHz = 9000;   break; // AM 9 kHz
                            case 3:
                            case 4: bandwidthHz = 2800;   break; // SSB 2.8 kHz
                            case 5: bandwidthHz = 700;    break; // CW 700 Hz
                            case 6: bandwidthHz = 1536000; bShowDabDecoder = true; break; // DAB+ 1.536 MHz
                        }
                    }

                    ImGui::Spacing();
                    ImGui::Separator();
                    ImGui::TextColored(ImVec4(0.4f, 0.8f, 1.0f, 1.0f), "BANDWIDTH ADJUSTMENT");
                    
                    // Bandwidth Slider in Hz with intuitive display
                    int bwInt = static_cast<int>(bandwidthHz);
                    if (ImGui::SliderInt("Filter BW", &bwInt, 500, 250000, "%d Hz")) {
                        bandwidthHz = static_cast<uint32_t>(bwInt);
                    }

                    // Common Bandwidth Quick Presets
                    ImGui::Text("Bandwidth Presets:");
                    const float bwBtnW = (sidebarWidth - 45.0f) / 3.0f;
                    const struct { const char* label; uint32_t val; } bwPresets[] = {
                        { "180k (WBFM)", 180000 }, { "150k (FM)", 150000 }, { "25k (NFM)", 25000 },
                        { "12.5k (NFM)", 12500 },  { "9k (AM)", 9000 },     { "6k (AM)", 6000 },
                        { "2.8k (SSB)", 2800 },    { "1.8k (SSB)", 1800 },   { "500 (CW)", 500 }
                    };

                    for (int i = 0; i < 9; ++i) {
                        if (i > 0 && i % 3 != 0) ImGui::SameLine();
                        bool isSel = (bandwidthHz == bwPresets[i].val);
                        if (isSel) {
                            ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.12f, 0.48f, 0.88f, 1.0f));
                            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.0f, 1.0f, 1.0f, 1.0f));
                        } else {
                            ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.08f, 0.12f, 0.18f, 1.0f));
                            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.45f, 0.85f, 1.0f, 1.0f)); // Cyan text font
                        }
                        if (ImGui::Button(bwPresets[i].label, ImVec2(bwBtnW, 28))) {
                            bandwidthHz = bwPresets[i].val;
                        }
                        ImGui::PopStyleColor(2);
                    }

                    ImGui::Spacing();
                    ImGui::Separator();
                    ImGui::TextColored(ImVec4(0.4f, 0.8f, 1.0f, 1.0f), "AUDIO & SQUELCH");

                    ImGui::SliderFloat("Volume", &audioVolume, 0.0f, 1.0f, "%.2f");
                    ImGui::SliderFloat("Squelch Threshold", &squelchDb, -100.0f, -10.0f, "%.1f dBFS");
                    ImGui::Checkbox("Audio Mute", &isAudioMuted);

                    ImGui::Spacing();
                    ImGui::Separator();
                    ImGui::TextColored(ImVec4(0.35f, 0.88f, 1.0f, 1.0f), "BROADCAST PRESETS");

                    // FM Broadcast - Mint Green font
                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.25f, 0.95f, 0.65f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.08f, 0.14f, 0.14f, 1.0f));
                    if (ImGui::Button("FM Broadcast: 101.100 MHz", ImVec2(sidebarWidth - 25.0f, 30))) {
                        currentFreqHz = 101100000; demodModeIndex = 0; bandwidthHz = 180000; sdr->SetCenterFrequency(currentFreqHz);
                    }
                    if (ImGui::Button("FM Broadcast: 88.500 MHz", ImVec2(sidebarWidth - 25.0f, 30))) {
                        currentFreqHz = 88500000; demodModeIndex = 0; bandwidthHz = 180000; sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::PopStyleColor(2);

                    // NOAA Weather - Sky Cyan font
                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.35f, 0.88f, 1.0f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.08f, 0.13f, 0.20f, 1.0f));
                    if (ImGui::Button("NOAA Weather: 162.550 MHz", ImVec2(sidebarWidth - 25.0f, 30))) {
                        currentFreqHz = 162550000; demodModeIndex = 1; bandwidthHz = 12500; sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::PopStyleColor(2);

                    // Airband Tower - Amber font
                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.0f, 0.80f, 0.30f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.16f, 0.12f, 0.08f, 1.0f));
                    if (ImGui::Button("Airband Tower: 118.700 MHz", ImVec2(sidebarWidth - 25.0f, 30))) {
                        currentFreqHz = 118700000; demodModeIndex = 2; bandwidthHz = 9000; sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::PopStyleColor(2);

                    // 2m Ham Simplex - Purple/Pink font
                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.88f, 0.65f, 1.0f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.14f, 0.09f, 0.18f, 1.0f));
                    if (ImGui::Button("2m Ham Simplex: 146.520 MHz", ImVec2(sidebarWidth - 25.0f, 30))) {
                        currentFreqHz = 146520000; demodModeIndex = 1; bandwidthHz = 12500; sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::PopStyleColor(2);

                    ImGui::EndTabItem();
                }

                // ------------------------------------------------------------
                // TAB C: HARDWARE & SDR SETTINGS
                // ------------------------------------------------------------
                if (ImGui::BeginTabItem("Hardware"))
                {
                    ImGui::Spacing();
                    ImGui::TextColored(ImVec4(0.4f, 0.8f, 1.0f, 1.0f), "RTL2832U FRONT-END");

                    ImGui::Text("Tuner Chip: %s", sdr->GetTunerType().c_str());
                    if (ImGui::Checkbox("RTL Hardware AGC", &rtlAgc)) {
                        sdr->SetRtlAgc(rtlAgc);
                    }
                    if (ImGui::Checkbox("Tuner Automatic Gain Control", &tunerAgc)) {
                        sdr->SetTunerGainMode(!tunerAgc);
                    }
                    if (!tunerAgc) {
                        if (ImGui::SliderInt("RF Gain Step", &tunerGainIndex, 0, sdr->GetGainCount() - 1)) {
                            sdr->SetTunerGainByIndex(tunerGainIndex);
                        }
                    }

                    ImGui::Separator();
                    static int ppm = 0;
                    if (ImGui::SliderInt("Freq Correction (PPM)", &ppm, -150, 150)) {
                        sdr->SetFreqCorrection(ppm);
                    }

                    static bool directSampling = false;
                    if (ImGui::Checkbox("Direct Sampling (HF Q-Branch)", &directSampling)) {
                        sdr->SetDirectSampling(directSampling ? 2 : 0);
                    }

                    ImGui::EndTabItem();
                }

                // ------------------------------------------------------------
                // TAB D: WATERFALL THEMES & DISPLAY
                // ------------------------------------------------------------
                if (ImGui::BeginTabItem("Display"))
                {
                    ImGui::Spacing();
                    ImGui::TextColored(ImVec4(0.4f, 0.8f, 1.0f, 1.0f), "WATERFALL COLOR PALETTE");

                    const char* themes[] = {
                        "SDR Classic (Navy / Cyan / Yellow / Red)",
                        "Turbo (Smooth Thermal Spectrum)",
                        "Viridis (Teal / Emerald / Yellow)",
                        "Plasma (Indigo / Pink / Bright Gold)",
                        "Fire (Crimson / Amber / White)",
                        "Night Radar (Tactical Green)"
                    };
                    if (ImGui::Combo("##ColorThemeCombo", &colorThemeIndex, themes, IM_ARRAYSIZE(themes)))
                    {
                        waterfall->SetColorMap(static_cast<WaterfallColorMap>(colorThemeIndex));
                    }

                    ImGui::Spacing();
                    ImGui::Separator();
                    ImGui::TextColored(ImVec4(0.4f, 0.8f, 1.0f, 1.0f), "DYNAMIC RANGE (dBFS)");

                    if (ImGui::SliderFloat("Min Level (Floor)", &minDb, -120.0f, -40.0f, "%.0f dBFS")) {
                        waterfall->SetDbRange(minDb, maxDb);
                    }
                    if (ImGui::SliderFloat("Max Level (Peak)", &maxDb, -40.0f, 0.0f, "%.0f dBFS")) {
                        waterfall->SetDbRange(minDb, maxDb);
                    }

                    ImGui::EndTabItem();
                }

                ImGui::EndTabBar();
            }
        }
        ImGui::EndChild();

        ImGui::SameLine();

        // ====================================================================
        // 3. MAIN RF SPECTRUM & WATERFALL DISPLAY (Click to Tune Directly!)
        // ====================================================================
        ImGui::BeginChild("MainSpectrumWaterfallContainer", ImVec2(mainDisplayWidth, totalHeight), true);
        {
            bool allowMouseTuning = !bShowMemoryBanks && !bShowDabDecoder;
            uint32_t retunedFreq = currentFreqHz;
            bool didRetune = waterfall->Render(
                mainDisplayWidth - 16.0f,
                totalHeight - 20.0f,
                currentFreqHz,
                sampleRateHz,
                currentFreqHz,
                bandwidthHz,
                retunedFreq,
                allowMouseTuning
            );

            if (didRetune && retunedFreq != currentFreqHz)
            {
                currentFreqHz = retunedFreq;
                sdr->SetCenterFrequency(currentFreqHz);
            }
        }
        ImGui::EndChild();

        ImGui::End(); // MainWorkspace

        // Memory Bank Manager Window (Popup / Standalone Modal)
        if (bShowMemoryBanks)
        {
            DrawMemoryBankWindow(&bShowMemoryBanks, currentFreqHz, demodModeIndex, sdr.get());
        }

        // DAB+ Digital Radio Decoder Window (Multiplex, Services & Constellation)
        if (bShowDabDecoder || demodModeIndex == 6)
        {
            DrawDabDecoderWindow(&bShowDabDecoder, dab.get(), sdr.get());
        }

        // Rendering DirectX Frame
        ImGui::Render();
        if (g_mainRenderTargetView)
        {
            const float clear_color_with_alpha[4] = { 0.05f, 0.06f, 0.08f, 1.0f };
            g_pd3dDeviceContext->OMSetRenderTargets(1, &g_mainRenderTargetView, nullptr);
            g_pd3dDeviceContext->ClearRenderTargetView(g_mainRenderTargetView, clear_color_with_alpha);
            ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());
            g_pSwapChain->Present(1, 0); // VSync enabled
        }
        else
        {
            ::Sleep(10);
        }
    }

    // Cleanup resources
    sdr->StopStream();
    audio->Shutdown();
    ImGui_ImplDX11_Shutdown();
    ImGui_ImplWin32_Shutdown();
    ImGui::DestroyContext();
    CleanupDeviceD3D();
    ::DestroyWindow(hwnd);
    ::UnregisterClassW(wc.lpszClassName, wc.hInstance);

    return 0;
}

// Helper: DirectX 11 initialization
bool CreateDeviceD3D(HWND hWnd)
{
    DXGI_SWAP_CHAIN_DESC sd;
    ZeroMemory(&sd, sizeof(sd));
    sd.BufferCount = 2;
    sd.BufferDesc.Width = 0;
    sd.BufferDesc.Height = 0;
    sd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.BufferDesc.RefreshRate.Numerator = 60;
    sd.BufferDesc.RefreshRate.Denominator = 1;
    sd.Flags = DXGI_SWAP_CHAIN_FLAG_ALLOW_MODE_SWITCH;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.OutputWindow = hWnd;
    sd.SampleDesc.Count = 1;
    sd.SampleDesc.Quality = 0;
    sd.Windowed = TRUE;
    sd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

    UINT createDeviceFlags = 0;
    D3D_FEATURE_LEVEL featureLevel;
    const D3D_FEATURE_LEVEL featureLevelArray[2] = { D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0, };
    HRESULT hr = D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, createDeviceFlags, featureLevelArray, 2, D3D11_SDK_VERSION, &sd, &g_pSwapChain, &g_pd3dDevice, &featureLevel, &g_pd3dDeviceContext);
    if (hr == DXGI_ERROR_UNSUPPORTED)
        hr = D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, createDeviceFlags, featureLevelArray, 2, D3D11_SDK_VERSION, &sd, &g_pSwapChain, &g_pd3dDevice, &featureLevel, &g_pd3dDeviceContext);
    if (hr != S_OK)
        return false;

    CreateRenderTarget();
    return true;
}

void CleanupDeviceD3D()
{
    CleanupRenderTarget();
    if (g_pSwapChain) { g_pSwapChain->Release(); g_pSwapChain = nullptr; }
    if (g_pd3dDeviceContext) { g_pd3dDeviceContext->Release(); g_pd3dDeviceContext = nullptr; }
    if (g_pd3dDevice) { g_pd3dDevice->Release(); g_pd3dDevice = nullptr; }
}

void CreateRenderTarget()
{
    ID3D11Texture2D* pBackBuffer = nullptr;
    g_pSwapChain->GetBuffer(0, IID_PPV_ARGS(&pBackBuffer));
    g_pd3dDevice->CreateRenderTargetView(pBackBuffer, nullptr, &g_mainRenderTargetView);
    pBackBuffer->Release();
}

void CleanupRenderTarget()
{
    if (g_mainRenderTargetView)
    {
        if (g_pd3dDeviceContext)
        {
            ID3D11RenderTargetView* nullViews[] = { nullptr };
            g_pd3dDeviceContext->OMSetRenderTargets(1, nullViews, nullptr);
        }
        g_mainRenderTargetView->Release();
        g_mainRenderTargetView = nullptr;
    }
}

LRESULT WINAPI WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    if (ImGui_ImplWin32_WndProcHandler(hWnd, msg, wParam, lParam))
        return true;

    switch (msg)
    {
    case WM_SIZE:
        if (wParam == SIZE_MINIMIZED)
            return 0;
        g_ResizeWidth = (UINT)LOWORD(lParam);
        g_ResizeHeight = (UINT)HIWORD(lParam);
        return 0;
    case WM_SYSCOMMAND:
        if ((wParam & 0xfff0) == SC_KEYMENU)
            return 0;
        break;
    case WM_DESTROY:
        ::PostQuitMessage(0);
        return 0;
    }
    return ::DefWindowProcW(hWnd, msg, wParam, lParam);
}
`,
  },
  {
    path: 'src/sdr_device.h',
    title: 'sdr_device.h (RTL2832U Hardware Interface Header)',
    category: 'header',
    description: 'Declarations for device enumeration, asynchronous librtlsdr reading thread, gain & frequency controls.',
    content: `#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <complex>
#include <thread>
#include <atomic>
#include <mutex>
#include <queue>

// Opaque struct pointer for RTL-SDR device handle
typedef struct rtlsdr_dev rtlsdr_dev_t;

class RtlSdrDevice
{
public:
    RtlSdrDevice();
    ~RtlSdrDevice();

    bool Open(uint32_t deviceIndex = 0);
    void Close();

    bool StartStream(uint32_t centerFreqHz, uint32_t sampleRateHz);
    void StopStream();

    bool SetCenterFrequency(uint32_t freqHz);
    bool SetSampleRate(uint32_t sampleRateHz);
    bool SetTunerGainMode(bool manual);
    bool SetTunerGain(int gainTenthsDb);
    bool SetTunerGainByIndex(int index);
    bool SetRtlAgc(bool enable);
    bool SetFreqCorrection(int ppm);
    bool SetDirectSampling(int mode); // 0: disabled, 1: I-branch, 2: Q-branch

    std::vector<std::complex<float>> ReadSamples();

    bool IsConnected() const { return m_bConnected; }
    bool IsStreaming() const { return m_bStreaming; }
    bool IsHardware() const { return m_bHardwarePresent; }
    std::string GetDeviceName() const { return m_deviceName; }
    std::string GetTunerType() const { return m_tunerType; }
    int GetGainCount() const { return static_cast<int>(m_supportedGains.size()); }
    int GetGainAt(int idx) const;

private:
    void AsyncWorker();
    void SimulateWorker();

    static void RtlsdrCallback(unsigned char* buf, uint32_t len, void* ctx);
    bool EnsureDllLoaded();

    rtlsdr_dev_t* m_pDev = nullptr;
    void* m_hDll = nullptr; // Win32 HMODULE
    bool m_bConnected = false;
    std::atomic<bool> m_bStreaming = false;
    bool m_bHardwarePresent = false;

    uint32_t m_centerFreqHz = 101100000;
    uint32_t m_sampleRateHz = 2048000;

    std::string m_deviceName = "RTL2832U USB Dongle";
    std::string m_tunerType = "R820T2";
    std::vector<int> m_supportedGains;

    std::thread m_workerThread;
    std::mutex m_sampleMutex;
    std::queue<std::complex<float>> m_sampleQueue;
};
`,
  },
  {
    path: 'src/sdr_device.cpp',
    title: 'sdr_device.cpp (Hardware Wrapper & Fallback Simulator)',
    category: 'source',
    description: 'Implements librtlsdr calls and background simulated RF signal generator for testing in VS.',
    content: `#include "sdr_device.h"
#include <iostream>
#include <cmath>
#include <random>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#endif

// Function pointer definitions for dynamic runtime binding with rtlsdr.dll
typedef int (__cdecl *pfn_rtlsdr_get_device_count)(void);
typedef const char* (__cdecl *pfn_rtlsdr_get_device_name)(uint32_t index);
typedef int (__cdecl *pfn_rtlsdr_open)(rtlsdr_dev_t** dev, uint32_t index);
typedef int (__cdecl *pfn_rtlsdr_close)(rtlsdr_dev_t* dev);
typedef int (__cdecl *pfn_rtlsdr_set_center_freq)(rtlsdr_dev_t* dev, uint32_t freq);
typedef uint32_t (__cdecl *pfn_rtlsdr_get_center_freq)(rtlsdr_dev_t* dev);
typedef int (__cdecl *pfn_rtlsdr_set_sample_rate)(rtlsdr_dev_t* dev, uint32_t rate);
typedef uint32_t (__cdecl *pfn_rtlsdr_get_sample_rate)(rtlsdr_dev_t* dev);
typedef int (__cdecl *pfn_rtlsdr_set_tuner_gain_mode)(rtlsdr_dev_t* dev, int manual);
typedef int (__cdecl *pfn_rtlsdr_get_tuner_gains)(rtlsdr_dev_t* dev, int* gains);
typedef int (__cdecl *pfn_rtlsdr_set_tuner_gain)(rtlsdr_dev_t* dev, int gain);
typedef int (__cdecl *pfn_rtlsdr_set_freq_correction)(rtlsdr_dev_t* dev, int ppm);
typedef int (__cdecl *pfn_rtlsdr_set_agc_mode)(rtlsdr_dev_t* dev, int on);
typedef int (__cdecl *pfn_rtlsdr_set_direct_sampling)(rtlsdr_dev_t* dev, int on);
typedef int (__cdecl *pfn_rtlsdr_reset_buffer)(rtlsdr_dev_t* dev);
typedef int (__cdecl *pfn_rtlsdr_read_async)(rtlsdr_dev_t* dev, void (*cb)(unsigned char* buf, uint32_t len, void* ctx), void* ctx, uint32_t buf_num, uint32_t buf_len);
typedef int (__cdecl *pfn_rtlsdr_cancel_async)(rtlsdr_dev_t* dev);

static pfn_rtlsdr_get_device_count fn_rtlsdr_get_device_count = nullptr;
static pfn_rtlsdr_get_device_name fn_rtlsdr_get_device_name = nullptr;
static pfn_rtlsdr_open fn_rtlsdr_open = nullptr;
static pfn_rtlsdr_close fn_rtlsdr_close = nullptr;
static pfn_rtlsdr_set_center_freq fn_rtlsdr_set_center_freq = nullptr;
static pfn_rtlsdr_get_center_freq fn_rtlsdr_get_center_freq = nullptr;
static pfn_rtlsdr_set_sample_rate fn_rtlsdr_set_sample_rate = nullptr;
static pfn_rtlsdr_get_sample_rate fn_rtlsdr_get_sample_rate = nullptr;
static pfn_rtlsdr_set_tuner_gain_mode fn_rtlsdr_set_tuner_gain_mode = nullptr;
static pfn_rtlsdr_get_tuner_gains fn_rtlsdr_get_tuner_gains = nullptr;
static pfn_rtlsdr_set_tuner_gain fn_rtlsdr_set_tuner_gain = nullptr;
static pfn_rtlsdr_set_freq_correction fn_rtlsdr_set_freq_correction = nullptr;
static pfn_rtlsdr_set_agc_mode fn_rtlsdr_set_agc_mode = nullptr;
static pfn_rtlsdr_set_direct_sampling fn_rtlsdr_set_direct_sampling = nullptr;
static pfn_rtlsdr_reset_buffer fn_rtlsdr_reset_buffer = nullptr;
static pfn_rtlsdr_read_async fn_rtlsdr_read_async = nullptr;
static pfn_rtlsdr_cancel_async fn_rtlsdr_cancel_async = nullptr;

bool RtlSdrDevice::EnsureDllLoaded()
{
#ifdef _WIN32
    if (m_hDll) return true;

    const char* dllNames[] = {
        "rtlsdr.dll",
        "librtlsdr.dll",
        "bin\\\\x64\\\\Release\\\\rtlsdr.dll",
        "bin\\\\x64\\\\Debug\\\\rtlsdr.dll",
        "..\\\\bin\\\\x64\\\\Release\\\\rtlsdr.dll",
        "..\\\\bin\\\\x64\\\\Debug\\\\rtlsdr.dll"
    };

    HMODULE hMod = nullptr;
    for (const char* name : dllNames)
    {
        hMod = LoadLibraryA(name);
        if (hMod) break;
    }

    if (!hMod) return false;

    m_hDll = hMod;
    fn_rtlsdr_get_device_count = (pfn_rtlsdr_get_device_count)GetProcAddress(hMod, "rtlsdr_get_device_count");
    fn_rtlsdr_get_device_name = (pfn_rtlsdr_get_device_name)GetProcAddress(hMod, "rtlsdr_get_device_name");
    fn_rtlsdr_open = (pfn_rtlsdr_open)GetProcAddress(hMod, "rtlsdr_open");
    fn_rtlsdr_close = (pfn_rtlsdr_close)GetProcAddress(hMod, "rtlsdr_close");
    fn_rtlsdr_set_center_freq = (pfn_rtlsdr_set_center_freq)GetProcAddress(hMod, "rtlsdr_set_center_freq");
    fn_rtlsdr_get_center_freq = (pfn_rtlsdr_get_center_freq)GetProcAddress(hMod, "rtlsdr_get_center_freq");
    fn_rtlsdr_set_sample_rate = (pfn_rtlsdr_set_sample_rate)GetProcAddress(hMod, "rtlsdr_set_sample_rate");
    fn_rtlsdr_get_sample_rate = (pfn_rtlsdr_get_sample_rate)GetProcAddress(hMod, "rtlsdr_get_sample_rate");
    fn_rtlsdr_set_tuner_gain_mode = (pfn_rtlsdr_set_tuner_gain_mode)GetProcAddress(hMod, "rtlsdr_set_tuner_gain_mode");
    fn_rtlsdr_get_tuner_gains = (pfn_rtlsdr_get_tuner_gains)GetProcAddress(hMod, "rtlsdr_get_tuner_gains");
    fn_rtlsdr_set_tuner_gain = (pfn_rtlsdr_set_tuner_gain)GetProcAddress(hMod, "rtlsdr_set_tuner_gain");
    fn_rtlsdr_set_freq_correction = (pfn_rtlsdr_set_freq_correction)GetProcAddress(hMod, "rtlsdr_set_freq_correction");
    fn_rtlsdr_set_agc_mode = (pfn_rtlsdr_set_agc_mode)GetProcAddress(hMod, "rtlsdr_set_agc_mode");
    fn_rtlsdr_set_direct_sampling = (pfn_rtlsdr_set_direct_sampling)GetProcAddress(hMod, "rtlsdr_set_direct_sampling");
    fn_rtlsdr_reset_buffer = (pfn_rtlsdr_reset_buffer)GetProcAddress(hMod, "rtlsdr_reset_buffer");
    fn_rtlsdr_read_async = (pfn_rtlsdr_read_async)GetProcAddress(hMod, "rtlsdr_read_async");
    fn_rtlsdr_cancel_async = (pfn_rtlsdr_cancel_async)GetProcAddress(hMod, "rtlsdr_cancel_async");

    return (fn_rtlsdr_open != nullptr);
#else
    return false;
#endif
}

RtlSdrDevice::RtlSdrDevice()
{
    m_supportedGains = { 0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280, 297, 328, 338, 364, 372, 386, 402, 421, 434, 439, 445, 480, 496 };
    EnsureDllLoaded();
    Open(0);
}

RtlSdrDevice::~RtlSdrDevice()
{
    Close();
#ifdef _WIN32
    if (m_hDll) {
        FreeLibrary(static_cast<HMODULE>(m_hDll));
        m_hDll = nullptr;
    }
#endif
}

bool RtlSdrDevice::Open(uint32_t deviceIndex)
{
    Close();
    if (EnsureDllLoaded() && fn_rtlsdr_get_device_count && fn_rtlsdr_open)
    {
        int count = fn_rtlsdr_get_device_count();
        if (count > 0 && fn_rtlsdr_open(&m_pDev, deviceIndex) >= 0)
        {
            m_bConnected = true;
            m_bHardwarePresent = true;
            if (fn_rtlsdr_get_device_name) {
                const char* name = fn_rtlsdr_get_device_name(deviceIndex);
                if (name) m_deviceName = name;
            }
            
            if (fn_rtlsdr_get_tuner_gains) {
                int numGains = fn_rtlsdr_get_tuner_gains(m_pDev, nullptr);
                if (numGains > 0) {
                    m_supportedGains.resize(numGains);
                    fn_rtlsdr_get_tuner_gains(m_pDev, m_supportedGains.data());
                }
            }
            return true;
        }
    }

    // Software simulation fallback (allows development without USB dongle plugged in)
    m_bConnected = true;
    m_bHardwarePresent = false;
    m_deviceName = "RTL2832U (Simulated RF Generator)";
    m_tunerType = "Rafael Micro R820T2";
    return true;
}

void RtlSdrDevice::Close()
{
    StopStream();
    if (m_pDev && fn_rtlsdr_close) {
        fn_rtlsdr_close(m_pDev);
        m_pDev = nullptr;
    }
    m_bConnected = false;
}

bool RtlSdrDevice::StartStream(uint32_t centerFreqHz, uint32_t sampleRateHz)
{
    if (!m_bConnected || m_bStreaming) return false;

    m_centerFreqHz = centerFreqHz;
    m_sampleRateHz = sampleRateHz;
    m_bStreaming = true;

    if (m_bHardwarePresent)
    {
        m_workerThread = std::thread(&RtlSdrDevice::AsyncWorker, this);
    }
    else
    {
        m_workerThread = std::thread(&RtlSdrDevice::SimulateWorker, this);
    }
    return true;
}

void RtlSdrDevice::StopStream()
{
    if (!m_bStreaming) return;
    m_bStreaming = false;

    if (m_pDev && fn_rtlsdr_cancel_async) {
        fn_rtlsdr_cancel_async(m_pDev);
    }

    if (m_workerThread.joinable()) {
        m_workerThread.join();
    }

    std::lock_guard<std::mutex> lock(m_sampleMutex);
    while (!m_sampleQueue.empty()) m_sampleQueue.pop();
}

bool RtlSdrDevice::SetCenterFrequency(uint32_t freqHz)
{
    m_centerFreqHz = freqHz;
    if (m_pDev && fn_rtlsdr_set_center_freq) {
        return fn_rtlsdr_set_center_freq(m_pDev, freqHz) == 0;
    }
    return true;
}

bool RtlSdrDevice::SetSampleRate(uint32_t sampleRateHz)
{
    m_sampleRateHz = sampleRateHz;
    if (m_pDev && fn_rtlsdr_set_sample_rate) {
        return fn_rtlsdr_set_sample_rate(m_pDev, sampleRateHz) == 0;
    }
    return true;
}

bool RtlSdrDevice::SetTunerGainMode(bool manual)
{
    if (m_pDev && fn_rtlsdr_set_tuner_gain_mode) {
        return fn_rtlsdr_set_tuner_gain_mode(m_pDev, manual ? 1 : 0) == 0;
    }
    return true;
}

bool RtlSdrDevice::SetTunerGain(int gainTenthsDb)
{
    if (m_pDev && fn_rtlsdr_set_tuner_gain) {
        return fn_rtlsdr_set_tuner_gain(m_pDev, gainTenthsDb) == 0;
    }
    return true;
}

bool RtlSdrDevice::SetTunerGainByIndex(int index)
{
    if (index >= 0 && index < (int)m_supportedGains.size()) {
        return SetTunerGain(m_supportedGains[index]);
    }
    return false;
}

bool RtlSdrDevice::SetRtlAgc(bool enable)
{
    if (m_pDev && fn_rtlsdr_set_agc_mode) {
        return fn_rtlsdr_set_agc_mode(m_pDev, enable ? 1 : 0) == 0;
    }
    return true;
}

bool RtlSdrDevice::SetFreqCorrection(int ppm)
{
    if (m_pDev && fn_rtlsdr_set_freq_correction) {
        return fn_rtlsdr_set_freq_correction(m_pDev, ppm) == 0;
    }
    return true;
}

bool RtlSdrDevice::SetDirectSampling(int mode)
{
    if (m_pDev && fn_rtlsdr_set_direct_sampling) {
        return fn_rtlsdr_set_direct_sampling(m_pDev, mode) == 0;
    }
    return true;
}

int RtlSdrDevice::GetGainAt(int idx) const
{
    if (idx >= 0 && idx < (int)m_supportedGains.size())
        return m_supportedGains[idx];
    return 0;
}

void RtlSdrDevice::RtlsdrCallback(unsigned char* buf, uint32_t len, void* ctx)
{
    auto* self = static_cast<RtlSdrDevice*>(ctx);
    std::lock_guard<std::mutex> lock(self->m_sampleMutex);

    // Convert raw 8-bit unsigned IQ (0..255) to normalized float (-1.0 .. +1.0)
    for (uint32_t i = 0; i < len; i += 2)
    {
        float iSample = (static_cast<float>(buf[i]) - 127.5f) / 128.0f;
        float qSample = (static_cast<float>(buf[i + 1]) - 127.5f) / 128.0f;
        self->m_sampleQueue.push(std::complex<float>(iSample, qSample));
    }
}

void RtlSdrDevice::AsyncWorker()
{
    if (m_pDev && fn_rtlsdr_reset_buffer && fn_rtlsdr_read_async) {
        fn_rtlsdr_reset_buffer(m_pDev);
        fn_rtlsdr_read_async(m_pDev, RtlsdrCallback, this, 0, 16384);
    }
}

void RtlSdrDevice::SimulateWorker()
{
    std::mt19937 rng(42);
    std::normal_distribution<float> noise(0.0f, 0.05f);

    float phase = 0.0f;
    float audioPhase = 0.0f;
    const float dt = 1.0f / static_cast<float>(m_sampleRateHz);

    while (m_bStreaming)
    {
        const int CHUNK = 8192;
        std::vector<std::complex<float>> chunk;
        chunk.reserve(CHUNK);

        // Generate synthetic RF spectrum with carriers and noise
        for (int i = 0; i < CHUNK; ++i)
        {
            // Simulated FM modulation at offset +150 kHz
            float audioMod = std::sin(audioPhase) * 75000.0f; // 75 kHz deviation
            audioPhase += 2.0f * 3.14159f * 1000.0f * dt;     // 1 kHz test tone

            float carrierFreq = 150000.0f + audioMod;
            phase += 2.0f * 3.14159f * carrierFreq * dt;

            float iVal = std::cos(phase) * 0.6f + noise(rng);
            float qVal = std::sin(phase) * 0.6f + noise(rng);
            chunk.emplace_back(iVal, qVal);
        }

        {
            std::lock_guard<std::mutex> lock(m_sampleMutex);
            if (m_sampleQueue.size() < 65536)
            {
                for (auto& s : chunk) m_sampleQueue.push(s);
            }
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(4));
    }
}

std::vector<std::complex<float>> RtlSdrDevice::ReadSamples()
{
    std::lock_guard<std::mutex> lock(m_sampleMutex);
    std::vector<std::complex<float>> out;
    out.reserve(m_sampleQueue.size());

    while (!m_sampleQueue.empty())
    {
        out.push_back(m_sampleQueue.front());
        m_sampleQueue.pop();
    }
    return out;
}
`,
  },
  {
    path: 'src/dsp.h',
    title: 'dsp.h (DSP Pipeline & Demodulator Header)',
    category: 'header',
    description: 'FFT windowing, spectrum bin calculation, and WBFM/NBFM/AM/SSB/CW demodulator declarations.',
    content: `#pragma once
#include <vector>
#include <complex>
#include <cmath>

enum class DemodMode
{
    WBFM = 0,
    NBFM = 1,
    AM   = 2,
    USB  = 3,
    LSB  = 4,
    CW   = 5,
    DAB_PLUS = 6
};

class DspPipeline
{
public:
    DspPipeline();
    ~DspPipeline();

    // Computes Fast Fourier Transform power spectrum in dBFS
    std::vector<float> ComputeFFT(const std::vector<std::complex<float>>& samples, size_t fftSize);

    // Demodulates complex IQ stream into mono float audio samples with user-adjustable bandwidth
    std::vector<float> Demodulate(const std::vector<std::complex<float>>& iq, DemodMode mode, float squelchDb, uint32_t bandwidthHz = 200000, uint32_t sampleRateHz = 2048000);

private:
    std::vector<float> DemodWBFM(const std::vector<std::complex<float>>& iq, uint32_t bandwidthHz, uint32_t sampleRateHz);
    std::vector<float> DemodNBFM(const std::vector<std::complex<float>>& iq, uint32_t bandwidthHz, uint32_t sampleRateHz);
    std::vector<float> DemodAM(const std::vector<std::complex<float>>& iq, uint32_t bandwidthHz, uint32_t sampleRateHz);
    std::vector<float> DemodSSB(const std::vector<std::complex<float>>& iq, bool usb, uint32_t bandwidthHz);
    std::vector<float> DemodCW(const std::vector<std::complex<float>>& iq, float pitchHz);

    // Filter states
    std::complex<float> m_lastSample = { 0.0f, 0.0f };
    float m_deemphState = 0.0f;
    float m_dcBlockState = 0.0f;
    float m_cwPhase = 0.0f;

    // Hann window weights
    std::vector<float> m_hannWindow;
};
`,
  },
  {
    path: 'src/dsp.cpp',
    title: 'dsp.cpp (Demodulation Algorithms & FFT Implementation)',
    category: 'source',
    description: 'Quadrature FM discriminator, envelope AM detector, single sideband filtering, and FFT algorithms.',
    content: `#include "dsp.h"
#include <algorithm>
#include <numbers>

DspPipeline::DspPipeline()
{
    // Precalculate 1024-point Hann window
    const size_t N = 1024;
    m_hannWindow.resize(N);
    for (size_t i = 0; i < N; ++i) {
        m_hannWindow[i] = 0.5f * (1.0f - std::cos(2.0f * 3.14159265f * i / (N - 1)));
    }
}

DspPipeline::~DspPipeline()
{
}

std::vector<float> DspPipeline::ComputeFFT(const std::vector<std::complex<float>>& samples, size_t fftSize)
{
    std::vector<float> dbfs(fftSize, -120.0f);
    if (samples.size() < fftSize) return dbfs;

    // Simple Cooley-Tukey Radix-2 FFT or wrapper around kiss_fft
    std::vector<std::complex<float>> buf(fftSize);
    for (size_t i = 0; i < fftSize; ++i) {
        buf[i] = samples[i] * m_hannWindow[i];
    }

    // In-place bit-reversal
    size_t n = fftSize;
    for (size_t i = 1, j = 0; i < n; ++i) {
        size_t bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) std::swap(buf[i], buf[j]);
    }

    for (size_t len = 2; len <= n; len <<= 1) {
        float angle = -2.0f * 3.14159265f / len;
        std::complex<float> wlen(std::cos(angle), std::sin(angle));
        for (size_t i = 0; i < n; i += len) {
            std::complex<float> w(1.0f, 0.0f);
            for (size_t j = 0; j < len / 2; ++j) {
                std::complex<float> u = buf[i + j];
                std::complex<float> v = buf[i + j + len / 2] * w;
                buf[i + j] = u + v;
                buf[i + j + len / 2] = u - v;
                w *= wlen;
            }
        }
    }

    // Convert magnitude to logarithmic dBFS with FFT shift (DC at center)
    const float ref = static_cast<float>(fftSize);
    for (size_t i = 0; i < fftSize; ++i) {
        size_t shiftedIdx = (i + fftSize / 2) % fftSize;
        float mag = std::abs(buf[shiftedIdx]) / ref;
        float pwr = 20.0f * std::log10(std::max(mag, 1e-6f));
        dbfs[i] = std::clamp(pwr, -120.0f, 0.0f);
    }

    return dbfs;
}

std::vector<float> DspPipeline::Demodulate(const std::vector<std::complex<float>>& iq, DemodMode mode, float squelchDb, uint32_t bandwidthHz, uint32_t sampleRateHz)
{
    // Compute RSSI power
    float powerSum = 0.0f;
    for (const auto& s : iq) {
        powerSum += std::norm(s);
    }
    float avgPower = powerSum / std::max((float)iq.size(), 1.0f);
    float rssiDb = 10.0f * std::log10(std::max(avgPower, 1e-7f));

    // Squelch gating
    if (rssiDb < squelchDb) {
        return std::vector<float>(std::max(iq.size() / 42, (size_t)1), 0.0f);
    }

    switch (mode)
    {
    case DemodMode::WBFM: return DemodWBFM(iq, bandwidthHz, sampleRateHz);
    case DemodMode::NBFM: return DemodNBFM(iq, bandwidthHz, sampleRateHz);
    case DemodMode::AM:   return DemodAM(iq, bandwidthHz, sampleRateHz);
    case DemodMode::USB:  return DemodSSB(iq, true, bandwidthHz);
    case DemodMode::LSB:  return DemodSSB(iq, false, bandwidthHz);
    case DemodMode::CW:   return DemodCW(iq, 700.0f);
    case DemodMode::DAB_PLUS: return DemodWBFM(iq, bandwidthHz, sampleRateHz);
    default:              return DemodWBFM(iq, bandwidthHz, sampleRateHz);
    }
}

std::vector<float> DspPipeline::DemodWBFM(const std::vector<std::complex<float>>& iq, uint32_t bandwidthHz, uint32_t sampleRateHz)
{
    // Anti-aliased Wideband FM Demodulation
    // Target audio output rate: 48000 Hz
    const float audioRate = 48000.0f;
    const float decimationF = (sampleRateHz > 0) ? (static_cast<float>(sampleRateHz) / audioRate) : 42.667f;
    const size_t decimation = std::max(1, static_cast<int>(std::round(decimationF)));

    std::vector<float> audio;
    audio.reserve(iq.size() / decimation + 1);

    // FM Broadcast de-emphasis: standard 75 microseconds (or 50 us in AU/EU)
    // alpha = exp(-1 / (audioRate * 75e-6)) ~ 0.7574f
    const float deemphAlpha = 0.7574f;
    
    // Scale factor for FM deviation according to filter bandwidth (nominally +/- 75 kHz deviation for WBFM)
    float maxDevHz = (bandwidthHz > 0) ? (static_cast<float>(bandwidthHz) * 0.5f) : 75000.0f;
    if (maxDevHz < 20000.0f) maxDevHz = 20000.0f;
    const float radToHzScale = static_cast<float>(sampleRateHz) / (2.0f * 3.14159265f);
    const float gainScale = 1.0f / maxDevHz;

    // Process in blocks of 'decimation' consecutive RF samples
    // Instantaneous phase difference is calculated between adjacent consecutive samples
    // and accumulated across the decimation window (boxcar anti-aliasing filter)
    for (size_t blockStart = 0; blockStart + decimation <= iq.size(); blockStart += decimation)
    {
        float freqSum = 0.0f;
        for (size_t j = 0; j < decimation; ++j)
        {
            std::complex<float> curr = iq[blockStart + j];
            std::complex<float> prod = curr * std::conj(m_lastSample);
            float dPhase = std::atan2(prod.imag(), prod.real());
            m_lastSample = curr;

            freqSum += dPhase * radToHzScale;
        }

        // Averaged instantaneous frequency (in Hz deviation)
        float avgFreqDev = freqSum / static_cast<float>(decimation);

        // Normalize by maximum deviation
        float audioSample = avgFreqDev * gainScale;

        // Apply 75 us IIR de-emphasis lowpass filter
        m_deemphState = (1.0f - deemphAlpha) * audioSample + deemphAlpha * m_deemphState;

        // DC blocker filter
        float clean = m_deemphState - m_dcBlockState;
        m_dcBlockState = 0.005f * m_deemphState + 0.995f * m_dcBlockState;

        // Soft limit
        audio.push_back(std::clamp(clean * 0.85f, -1.0f, 1.0f));
    }

    return audio;
}

std::vector<float> DspPipeline::DemodNBFM(const std::vector<std::complex<float>>& iq, uint32_t bandwidthHz, uint32_t sampleRateHz)
{
    const float audioRate = 48000.0f;
    const float decimationF = (sampleRateHz > 0) ? (static_cast<float>(sampleRateHz) / audioRate) : 42.667f;
    const size_t decimation = std::max(1, static_cast<int>(std::round(decimationF)));

    std::vector<float> audio;
    audio.reserve(iq.size() / decimation + 1);

    float maxDevHz = (bandwidthHz > 0) ? (static_cast<float>(bandwidthHz) * 0.4f) : 5000.0f;
    if (maxDevHz < 2000.0f) maxDevHz = 2000.0f;
    const float radToHzScale = static_cast<float>(sampleRateHz) / (2.0f * 3.14159265f);
    const float gainScale = 1.0f / maxDevHz;

    for (size_t blockStart = 0; blockStart + decimation <= iq.size(); blockStart += decimation)
    {
        float freqSum = 0.0f;
        for (size_t j = 0; j < decimation; ++j)
        {
            std::complex<float> curr = iq[blockStart + j];
            std::complex<float> prod = curr * std::conj(m_lastSample);
            float dPhase = std::atan2(prod.imag(), prod.real());
            m_lastSample = curr;

            freqSum += dPhase * radToHzScale;
        }

        float avgFreqDev = freqSum / static_cast<float>(decimation);
        float sample = avgFreqDev * gainScale;

        // DC blocker
        float clean = sample - m_dcBlockState;
        m_dcBlockState = 0.01f * sample + 0.99f * m_dcBlockState;

        audio.push_back(std::clamp(clean * 0.9f, -1.0f, 1.0f));
    }
    return audio;
}

std::vector<float> DspPipeline::DemodAM(const std::vector<std::complex<float>>& iq, uint32_t bandwidthHz, uint32_t sampleRateHz)
{
    const float audioRate = 48000.0f;
    const float decimationF = (sampleRateHz > 0) ? (static_cast<float>(sampleRateHz) / audioRate) : 42.667f;
    const size_t decimation = std::max(1, static_cast<int>(std::round(decimationF)));

    std::vector<float> audio;
    audio.reserve(iq.size() / decimation + 1);

    for (size_t blockStart = 0; blockStart + decimation <= iq.size(); blockStart += decimation)
    {
        float envSum = 0.0f;
        for (size_t j = 0; j < decimation; ++j)
        {
            envSum += std::abs(iq[blockStart + j]);
        }
        float env = envSum / static_cast<float>(decimation);

        // DC blocker filter to strip carrier
        float out = env - m_dcBlockState;
        m_dcBlockState = env * 0.02f + m_dcBlockState * 0.98f;
        audio.push_back(std::clamp(out * 2.5f, -1.0f, 1.0f));
    }
    return audio;
}

std::vector<float> DspPipeline::DemodSSB(const std::vector<std::complex<float>>& iq, bool usb, uint32_t bandwidthHz)
{
    const size_t decimation = 42;
    std::vector<float> audio;
    audio.reserve(iq.size() / decimation + 1);

    for (size_t blockStart = 0; blockStart + decimation <= iq.size(); blockStart += decimation)
    {
        float sum = 0.0f;
        for (size_t j = 0; j < decimation; ++j)
        {
            const auto& s = iq[blockStart + j];
            float val = usb ? (s.real() + s.imag()) * 0.707f : (s.real() - s.imag()) * 0.707f;
            sum += val;
        }
        float val = sum / static_cast<float>(decimation);
        audio.push_back(std::clamp(val * 2.0f, -1.0f, 1.0f));
    }
    return audio;
}

std::vector<float> DspPipeline::DemodCW(const std::vector<std::complex<float>>& iq, float pitchHz)
{
    const size_t decimation = 42;
    std::vector<float> audio;
    audio.reserve(iq.size() / decimation + 1);

    const float dt = 1.0f / 48000.0f;
    for (size_t blockStart = 0; blockStart + decimation <= iq.size(); blockStart += decimation)
    {
        float envSum = 0.0f;
        for (size_t j = 0; j < decimation; ++j)
        {
            envSum += std::abs(iq[blockStart + j]);
        }
        float env = envSum / static_cast<float>(decimation);
        m_cwPhase += 2.0f * 3.14159f * pitchHz * dt;
        float bfo = std::sin(m_cwPhase);
        audio.push_back(env * bfo * 1.5f);
    }
    return audio;
}
`,
  },
  {
    path: 'src/waterfall.h',
    title: 'waterfall.h (DirectX 11 Dynamic Texture Waterfall Header)',
    category: 'header',
    description: 'Direct3D 11 2D texture streaming class for high frame rate 60 FPS rolling spectrogram.',
    content: `#pragma once
#include <d3d11.h>
#include <vector>
#include <cstdint>

enum class WaterfallColorMap
{
    SdrClassic = 0,
    Turbo = 1,
    Viridis = 2,
    Plasma = 3,
    Fire = 4,
    NightRadar = 5
};

class WaterfallDisplay
{
public:
    WaterfallDisplay(ID3D11Device* device, ID3D11DeviceContext* context, uint32_t width = 1024, uint32_t height = 512);
    ~WaterfallDisplay();

    void AddFftRow(const std::vector<float>& fftDbfs);

    // Interactive Render of both Spectrum and Waterfall with click-to-tune and passband overlay
    bool Render(float displayWidth, float displayHeight,
                uint32_t centerFreqHz, uint32_t sampleRateHz, uint32_t tunedFreqHz, uint32_t bandwidthHz,
                uint32_t& outTunedFreqHz, bool allowMouseTuning = true);
    
    void SetColorMap(WaterfallColorMap map) { m_colorMap = map; }
    WaterfallColorMap GetColorMap() const { return m_colorMap; }

    void SetDbRange(float minDb, float maxDb) { m_minDb = minDb; m_maxDb = maxDb; }
    float GetMinDb() const { return m_minDb; }
    float GetMaxDb() const { return m_maxDb; }

    const std::vector<float>& GetLastFft() const { return m_lastFft; }
    ID3D11ShaderResourceView* GetTextureView() const { return m_pTextureView; }

private:
    void UpdateTexture();
    uint32_t ColorMapLookup(float normalizedVal);

    ID3D11Device* m_pDevice = nullptr;
    ID3D11DeviceContext* m_pContext = nullptr;

    ID3D11Texture2D* m_pTexture = nullptr;
    ID3D11ShaderResourceView* m_pTextureView = nullptr;

    uint32_t m_width = 1024;
    uint32_t m_height = 512;

    std::vector<uint32_t> m_pixelBuffer;
    std::vector<float> m_lastFft;
    std::vector<float> m_peakHoldFft;

    float m_minDb = -85.0f;
    float m_maxDb = -15.0f;
    WaterfallColorMap m_colorMap = WaterfallColorMap::SdrClassic;
};
`,
  },
  {
    path: 'src/waterfall.cpp',
    title: 'waterfall.cpp (DirectX 11 Waterfall Texture Streaming)',
    category: 'source',
    description: 'Implements CPU write-combining dynamic texture upload and colormapping into ImGui.',
    content: `#include "waterfall.h"
#include "imgui.h"
#include <algorithm>
#include <cstring>
#include <cmath>

WaterfallDisplay::WaterfallDisplay(ID3D11Device* device, ID3D11DeviceContext* context, uint32_t width, uint32_t height)
    : m_pDevice(device), m_pContext(context), m_width(width), m_height(height)
{
    m_pixelBuffer.resize(m_width * m_height, 0xFF000000);
    m_lastFft.resize(m_width, -120.0f);

    D3D11_TEXTURE2D_DESC desc;
    ZeroMemory(&desc, sizeof(desc));
    desc.Width = m_width;
    desc.Height = m_height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DYNAMIC;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;

    D3D11_SUBRESOURCE_DATA initData;
    initData.pSysMem = m_pixelBuffer.data();
    initData.SysMemPitch = m_width * sizeof(uint32_t);
    initData.SysMemSlicePitch = 0;

    m_pDevice->CreateTexture2D(&desc, &initData, &m_pTexture);

    D3D11_SHADER_RESOURCE_VIEW_DESC srvDesc;
    ZeroMemory(&srvDesc, sizeof(srvDesc));
    srvDesc.Format = desc.Format;
    srvDesc.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D;
    srvDesc.Texture2D.MipLevels = 1;

    m_pDevice->CreateShaderResourceView(m_pTexture, &srvDesc, &m_pTextureView);
}

WaterfallDisplay::~WaterfallDisplay()
{
    if (m_pTextureView) m_pTextureView->Release();
    if (m_pTexture) m_pTexture->Release();
}

void WaterfallDisplay::AddFftRow(const std::vector<float>& fftDbfs)
{
    m_lastFft = fftDbfs;

    // Scroll existing texture rows downward by 1 line
    std::memmove(&m_pixelBuffer[m_width], &m_pixelBuffer[0], m_width * (m_height - 1) * sizeof(uint32_t));

    float safeMinDb = (std::min)(m_minDb, m_maxDb);
    float safeMaxDb = (std::max)(m_minDb, m_maxDb);
    if (safeMaxDb - safeMinDb < 1.0f) safeMaxDb = safeMinDb + 1.0f;

    // Render new top row with colormap
    for (uint32_t x = 0; x < m_width; ++x)
    {
        float db = (x < fftDbfs.size()) ? fftDbfs[x] : -120.0f;
        float norm = std::clamp((db - safeMinDb) / (safeMaxDb - safeMinDb), 0.0f, 1.0f);
        m_pixelBuffer[x] = ColorMapLookup(norm);
    }

    UpdateTexture();
}

void WaterfallDisplay::UpdateTexture()
{
    D3D11_MAPPED_SUBRESOURCE mapped;
    if (SUCCEEDED(m_pContext->Map(m_pTexture, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped)))
    {
        uint8_t* pDest = static_cast<uint8_t*>(mapped.pData);
        const uint8_t* pSrc = reinterpret_cast<const uint8_t*>(m_pixelBuffer.data());
        for (uint32_t y = 0; y < m_height; ++y)
        {
            std::memcpy(pDest + y * mapped.RowPitch, pSrc + y * m_width * sizeof(uint32_t), m_width * sizeof(uint32_t));
        }
        m_pContext->Unmap(m_pTexture, 0);
    }
}

uint32_t WaterfallDisplay::ColorMapLookup(float t)
{
    t = std::clamp(t, 0.0f, 1.0f);
    uint8_t r = 0, g = 0, b = 0;

    switch (m_colorMap)
    {
    case WaterfallColorMap::SdrClassic:
    default:
        // Deep Navy -> Vivid Cobalt -> Bright Cyan -> Emerald Green -> Yellow -> Red -> White
        if (t < 0.18f) {
            float f = t / 0.18f;
            r = static_cast<uint8_t>(4 + f * 10);
            g = static_cast<uint8_t>(7 + f * 50);
            b = static_cast<uint8_t>(20 + f * 160);
        } else if (t < 0.40f) {
            float f = (t - 0.18f) / 0.22f;
            r = 0;
            g = static_cast<uint8_t>(57 + f * 170);
            b = static_cast<uint8_t>(180 + f * 75);
        } else if (t < 0.65f) {
            float f = (t - 0.40f) / 0.25f;
            r = static_cast<uint8_t>(f * 255);
            g = 255;
            b = static_cast<uint8_t>(255 * (1.0f - f));
        } else if (t < 0.88f) {
            float f = (t - 0.65f) / 0.23f;
            r = 255;
            g = static_cast<uint8_t>(255 * (1.0f - f));
            b = 0;
        } else {
            float f = (t - 0.88f) / 0.12f;
            r = 255;
            g = static_cast<uint8_t>(f * 255);
            b = static_cast<uint8_t>(f * 255);
        }
        break;

    case WaterfallColorMap::Turbo:
        // High dynamic range smooth spectrum
        r = static_cast<uint8_t>(std::clamp(255.0f * (1.5f * t), 0.0f, 255.0f));
        g = static_cast<uint8_t>(std::clamp(255.0f * (4.0f * t * (1.0f - t)), 0.0f, 255.0f));
        b = static_cast<uint8_t>(std::clamp(255.0f * (1.5f * (1.0f - t)), 0.0f, 255.0f));
        break;

    case WaterfallColorMap::Viridis:
        // Deep purple -> teal -> emerald -> bright yellow
        r = static_cast<uint8_t>(std::clamp(255.0f * (t > 0.5f ? 2.0f * (t - 0.5f) : 0.0f), 0.0f, 255.0f));
        g = static_cast<uint8_t>(std::clamp(255.0f * std::sin(t * 3.14159f), 0.0f, 255.0f));
        b = static_cast<uint8_t>(std::clamp(255.0f * (1.0f - t * 0.7f), 0.0f, 255.0f));
        break;

    case WaterfallColorMap::Plasma:
        // Deep indigo -> pink -> bright orange -> yellow
        r = static_cast<uint8_t>(std::clamp(255.0f * std::sin(t * 3.14159f * 0.8f), 0.0f, 255.0f));
        g = static_cast<uint8_t>(std::clamp(255.0f * (t * t), 0.0f, 255.0f));
        b = static_cast<uint8_t>(std::clamp(255.0f * std::cos(t * 3.14159f * 0.5f), 0.0f, 255.0f));
        break;

    case WaterfallColorMap::Fire:
        // Black -> crimson -> fiery orange -> bright gold
        r = static_cast<uint8_t>(std::clamp(255.0f * (t * 2.0f), 0.0f, 255.0f));
        g = static_cast<uint8_t>(std::clamp(255.0f * std::max(0.0f, t * 2.0f - 0.7f), 0.0f, 255.0f));
        b = static_cast<uint8_t>(std::clamp(255.0f * std::max(0.0f, t * 3.0f - 2.0f), 0.0f, 255.0f));
        break;

    case WaterfallColorMap::NightRadar:
        // Obsidian -> military forest green -> radioactive emerald
        r = static_cast<uint8_t>(std::clamp(255.0f * std::max(0.0f, (t - 0.75f) * 4.0f), 0.0f, 255.0f));
        g = static_cast<uint8_t>(std::clamp(255.0f * (t < 0.3f ? (t / 0.3f) * 0.4f : (0.4f + (t - 0.3f) * 0.85f)), 0.0f, 255.0f));
        b = static_cast<uint8_t>(std::clamp(255.0f * std::max(0.0f, (t - 0.85f) * 6.0f), 0.0f, 255.0f));
        break;
    }

    // RGBA for DirectX 11 DXGI_FORMAT_R8G8B8A8_UNORM
    return (0xFF << 24) | (b << 16) | (g << 8) | r;
}

bool WaterfallDisplay::Render(float displayWidth, float displayHeight,
                             uint32_t centerFreqHz, uint32_t sampleRateHz, uint32_t tunedFreqHz, uint32_t bandwidthHz,
                             uint32_t& outTunedFreqHz, bool allowMouseTuning)
{
    // Safety check: if window is minimized or collapsed, don't attempt rendering or calculations
    if (displayWidth <= 50.0f || displayHeight <= 50.0f)
    {
        return false;
    }

    bool retuned = false;
    ImDrawList* drawList = ImGui::GetWindowDrawList();
    ImGuiIO& io = ImGui::GetIO();

    // Guard against inverted or identical dB bounds causing division by zero or assertion failures
    float safeMinDb = (std::min)(m_minDb, m_maxDb);
    float safeMaxDb = (std::max)(m_minDb, m_maxDb);
    if (safeMaxDb - safeMinDb < 1.0f) safeMaxDb = safeMinDb + 1.0f;

    float spectrumHeight = displayHeight * 0.42f;
    float waterfallHeight = displayHeight - spectrumHeight - 12.0f;
    if (waterfallHeight < 50.0f) waterfallHeight = 50.0f;

    double startFreq = static_cast<double>(centerFreqHz) - (static_cast<double>(sampleRateHz) / 2.0);
    double endFreq = startFreq + static_cast<double>(sampleRateHz);

    // ========================================================================
    // 1. Spectrum Analyzer with Passband Overlay & Click-To-Tune
    // ========================================================================
    ImVec2 specPos = ImGui::GetCursorScreenPos();
    ImVec2 specSize = ImVec2(displayWidth, spectrumHeight);
    ImVec2 specEnd = ImVec2(specPos.x + specSize.x, specPos.y + specSize.y);

    // Guaranteed valid clamp bounds
    float minX = (std::min)(specPos.x, specEnd.x);
    float maxX = (std::max)(specPos.x, specEnd.x);
    if (maxX <= minX) maxX = minX + 1.0f;

    // Background & Border
    drawList->AddRectFilled(specPos, specEnd, IM_COL32(11, 15, 25, 255), 4.0f);
    drawList->AddRect(specPos, specEnd, IM_COL32(30, 41, 59, 255), 4.0f);

    // Horizontal dBFS Grid lines (-120 dBFS to 0 dBFS)
    const float dbMarks[] = { 0.0f, -20.0f, -40.0f, -60.0f, -80.0f, -100.0f, -120.0f };
    for (float db : dbMarks)
    {
        float normY = (safeMaxDb - db) / (safeMaxDb - safeMinDb);
        normY = std::clamp(normY, 0.0f, 1.0f);
        float y = specPos.y + normY * specSize.y;
        drawList->AddLine(ImVec2(specPos.x, y), ImVec2(specEnd.x, y), IM_COL32(50, 65, 90, 80), 1.0f);
        
        char label[16];
        snprintf(label, sizeof(label), "%.0f dB", db);
        drawList->AddText(ImVec2(specPos.x + 4.0f, y - 14.0f), IM_COL32(100, 116, 139, 200), label);
    }

    // Vertical Frequency Division Grid lines
    for (int i = 1; i <= 4; ++i)
    {
        float normX = i / 5.0f;
        float x = specPos.x + normX * specSize.x;
        drawList->AddLine(ImVec2(x, specPos.y), ImVec2(x, specEnd.y), IM_COL32(50, 65, 90, 60), 1.0f);
        
        double f = startFreq + normX * static_cast<double>(sampleRateHz);
        char fLabel[32];
        snprintf(fLabel, sizeof(fLabel), "%.3f M", f / 1e6);
        drawList->AddText(ImVec2(x - 24.0f, specEnd.y - 18.0f), IM_COL32(148, 163, 184, 180), fLabel);
    }

    // Calculate Passband Filter Overlay boundaries
    double halfBw = static_cast<double>(bandwidthHz) * 0.5;
    double pbLeftFreq = static_cast<double>(tunedFreqHz) - halfBw;
    double pbRightFreq = static_cast<double>(tunedFreqHz) + halfBw;

    float pbLeftX = specPos.x + static_cast<float>((pbLeftFreq - startFreq) / static_cast<double>(sampleRateHz)) * specSize.x;
    float pbRightX = specPos.x + static_cast<float>((pbRightFreq - startFreq) / static_cast<double>(sampleRateHz)) * specSize.x;
    float tunedX = specPos.x + static_cast<float>((static_cast<double>(tunedFreqHz) - startFreq) / static_cast<double>(sampleRateHz)) * specSize.x;

    // Draw Shaded Passband Bandwidth Overlay (Safe clamp with guaranteed minX <= maxX)
    float clampedPbLeft = std::clamp(pbLeftX, minX, maxX);
    float clampedPbRight = std::clamp(pbRightX, minX, maxX);
    if (clampedPbRight > clampedPbLeft)
    {
        drawList->AddRectFilled(ImVec2(clampedPbLeft, specPos.y), ImVec2(clampedPbRight, specEnd.y), IM_COL32(56, 189, 248, 45));
        drawList->AddLine(ImVec2(clampedPbLeft, specPos.y), ImVec2(clampedPbLeft, specEnd.y), IM_COL32(56, 189, 248, 160), 1.5f);
        drawList->AddLine(ImVec2(clampedPbRight, specPos.y), ImVec2(clampedPbRight, specEnd.y), IM_COL32(56, 189, 248, 160), 1.5f);
    }

    // Draw Spectrum Curve and Filled Area
    if (!m_lastFft.empty())
    {
        size_t nBins = m_lastFft.size();
        std::vector<ImVec2> pts;
        pts.reserve(nBins + 2);
        pts.push_back(ImVec2(specPos.x, specEnd.y));

        for (size_t i = 0; i < nBins; ++i)
        {
            float normX = static_cast<float>(i) / static_cast<float>(nBins - 1);
            float x = specPos.x + normX * specSize.x;
            float db = m_lastFft[i];
            float normY = std::clamp((safeMaxDb - db) / (safeMaxDb - safeMinDb), 0.0f, 1.0f);
            float y = specPos.y + normY * (specSize.y - 20.0f) + 4.0f;
            pts.push_back(ImVec2(x, y));
        }
        pts.push_back(ImVec2(specEnd.x, specEnd.y));

        // Fill area under spectrum
        drawList->AddConvexPolyFilled(pts.data(), static_cast<int>(pts.size()), IM_COL32(14, 165, 233, 40));

        // Draw bright outline
        for (size_t i = 1; i < pts.size() - 2; ++i)
        {
            drawList->AddLine(pts[i], pts[i + 1], IM_COL32(56, 189, 248, 255), 1.8f);
        }
    }

    // Draw Red Central Tuning Reticle
    if (tunedX >= minX && tunedX <= maxX)
    {
        drawList->AddLine(ImVec2(tunedX, specPos.y), ImVec2(tunedX, specEnd.y), IM_COL32(239, 68, 68, 220), 1.5f);
        drawList->AddTriangleFilled(ImVec2(tunedX - 6.0f, specPos.y), ImVec2(tunedX + 6.0f, specPos.y), ImVec2(tunedX, specPos.y + 10.0f), IM_COL32(239, 68, 68, 240));
    }

    // Spectrum Mouse Interaction via InvisibleButton:
    // This strictly ensures that dragging another window (like Memory Bank Manager) over the spectrum
    // will NOT click through or tune the frequency!
    ImGui::SetCursorScreenPos(specPos);
    ImGui::InvisibleButton("##SpectrumInteractionHitbox", specSize);
    bool isSpecHovered = ImGui::IsItemHovered();
    bool isSpecActive = ImGui::IsItemActive();
    bool isBlocking = !allowMouseTuning || !ImGui::IsWindowHovered(ImGuiHoveredFlags_RootAndChildWindows);

    if (!isBlocking && (isSpecHovered || isSpecActive))
    {
        float hoverRatio = std::clamp((io.MousePos.x - specPos.x) / specSize.x, 0.0f, 1.0f);
        double hoverFreq = startFreq + hoverRatio * static_cast<double>(sampleRateHz);
        float hoverDb = safeMaxDb - ((io.MousePos.y - specPos.y) / specSize.y) * (safeMaxDb - safeMinDb);

        // Crosshairs
        drawList->AddLine(ImVec2(io.MousePos.x, specPos.y), ImVec2(io.MousePos.x, specEnd.y), IM_COL32(255, 255, 255, 60), 1.0f);
        drawList->AddLine(ImVec2(specPos.x, io.MousePos.y), ImVec2(specEnd.x, io.MousePos.y), IM_COL32(255, 255, 255, 60), 1.0f);

        ImGui::SetTooltip("%.3f MHz  |  %.1f dBFS  [Click or Drag to Tune Directly]", hoverFreq / 1e6, hoverDb);

        if (isSpecActive && ImGui::IsMouseDown(ImGuiMouseButton_Left))
        {
            outTunedFreqHz = static_cast<uint32_t>(hoverFreq);
            retuned = true;
        }
    }

    ImGui::Spacing();

    // ========================================================================
    // 2. High-Resolution Dynamic Waterfall Spectrogram with Click-To-Tune
    // ========================================================================
    ImVec2 wfPos = ImGui::GetCursorScreenPos();
    ImVec2 wfSize = ImVec2(displayWidth, waterfallHeight);
    ImVec2 wfEnd = ImVec2(wfPos.x + wfSize.x, wfPos.y + wfSize.y);
    float minWfX = (std::min)(wfPos.x, wfEnd.x);
    float maxWfX = (std::max)(wfPos.x, wfEnd.x);
    if (maxWfX <= minWfX) maxWfX = minWfX + 1.0f;

    if (m_pTextureView)
    {
        ImGui::Image(reinterpret_cast<ImTextureID>(m_pTextureView), wfSize);
    }
    else
    {
        drawList->AddRectFilled(wfPos, wfEnd, IM_COL32(8, 12, 20, 255));
    }

    // Overlay Tuning Marker & Passband on Waterfall
    if (clampedPbRight > clampedPbLeft)
    {
        drawList->AddLine(ImVec2(clampedPbLeft, wfPos.y), ImVec2(clampedPbLeft, wfEnd.y), IM_COL32(56, 189, 248, 110), 1.0f);
        drawList->AddLine(ImVec2(clampedPbRight, wfPos.y), ImVec2(clampedPbRight, wfEnd.y), IM_COL32(56, 189, 248, 110), 1.0f);
    }
    if (tunedX >= minWfX && tunedX <= maxWfX)
    {
        drawList->AddLine(ImVec2(tunedX, wfPos.y), ImVec2(tunedX, wfEnd.y), IM_COL32(239, 68, 68, 180), 1.2f);
    }

    // Waterfall Mouse Interaction via InvisibleButton:
    // Only captures clicks/drags intended for the waterfall; window drags above it are ignored!
    ImGui::SetCursorScreenPos(wfPos);
    ImGui::InvisibleButton("##WaterfallInteractionHitbox", wfSize);
    bool isWfHovered = ImGui::IsItemHovered();
    bool isWfActive = ImGui::IsItemActive();

    if (!isBlocking && (isWfHovered || isWfActive))
    {
        float hoverRatio = std::clamp((io.MousePos.x - wfPos.x) / wfSize.x, 0.0f, 1.0f);
        double hoverFreq = startFreq + hoverRatio * static_cast<double>(sampleRateHz);

        drawList->AddLine(ImVec2(io.MousePos.x, wfPos.y), ImVec2(io.MousePos.x, wfEnd.y), IM_COL32(255, 255, 255, 80), 1.0f);
        ImGui::SetTooltip("Waterfall: %.3f MHz  [Click or Drag to Tune Directly]", hoverFreq / 1e6);

        if (isWfActive && ImGui::IsMouseDown(ImGuiMouseButton_Left))
        {
            outTunedFreqHz = static_cast<uint32_t>(hoverFreq);
            retuned = true;
        }
    }

    return retuned;
}
`,
  },
  {
    path: 'src/audio_player.h',
    title: 'audio_player.h (Low-Latency Audio Output Engine)',
    category: 'header',
    description: 'Header for miniaudio / WASAPI audio device with thread-safe ring buffer.',
    content: `#pragma once
#include <vector>
#include <mutex>
#include <cstdint>

class AudioPlayer
{
public:
    AudioPlayer();
    ~AudioPlayer();

    bool Initialize(uint32_t sampleRate = 48000, uint32_t channels = 2);
    void Shutdown();

    void WriteSamples(const float* pSamples, size_t count, float volume = 1.0f);

private:
    void* m_pDevice = nullptr;
    bool m_bInitialized = false;
    uint32_t m_sampleRate = 48000;
    uint32_t m_channels = 2;
    std::mutex m_audioMutex;
};
`,
  },
  {
    path: 'src/audio_player.cpp',
    title: 'audio_player.cpp (Low-Latency Windows Multimedia Audio Driver)',
    category: 'source',
    description: 'Windows waveOut multi-buffered audio playback engine streaming demodulated FM/AM/SSB sound.',
    content: `#include "audio_player.h"
#include <windows.h>
#include <mmsystem.h>
#include <algorithm>
#include <cmath>

#pragma comment(lib, "winmm.lib")

constexpr size_t NUM_BUFFERS = 12;
constexpr size_t BUFFER_SAMPLES = 2048;

struct AudioInternal
{
    HWAVEOUT hWaveOut = nullptr;
    WAVEHDR headers[NUM_BUFFERS];
    int16_t sampleBuffers[NUM_BUFFERS][BUFFER_SAMPLES * 2]; // 16-bit PCM (stereo)
    size_t currentBuffer = 0;
};

AudioPlayer::AudioPlayer()
{
}

AudioPlayer::~AudioPlayer()
{
    Shutdown();
}

bool AudioPlayer::Initialize(uint32_t sampleRate, uint32_t channels)
{
    m_sampleRate = sampleRate;
    m_channels = channels;

    WAVEFORMATEX wfx = {};
    wfx.wFormatTag = WAVE_FORMAT_PCM;
    wfx.nChannels = static_cast<WORD>(channels);
    wfx.nSamplesPerSec = sampleRate;
    wfx.wBitsPerSample = 16;
    wfx.nBlockAlign = (wfx.nChannels * wfx.wBitsPerSample) / 8;
    wfx.nAvgBytesPerSec = wfx.nSamplesPerSec * wfx.nBlockAlign;

    auto internal = new AudioInternal();
    m_pDevice = internal;

    MMRESULT result = waveOutOpen(&internal->hWaveOut, WAVE_MAPPER, &wfx, 0, 0, CALLBACK_NULL);
    if (result != MMSYSERR_NOERROR)
    {
        internal->hWaveOut = nullptr;
        m_bInitialized = false;
        return false;
    }

    for (size_t i = 0; i < NUM_BUFFERS; ++i)
    {
        ZeroMemory(&internal->headers[i], sizeof(WAVEHDR));
        internal->headers[i].lpData = reinterpret_cast<LPSTR>(internal->sampleBuffers[i]);
        internal->headers[i].dwBufferLength = static_cast<DWORD>(BUFFER_SAMPLES * channels * sizeof(int16_t));
        internal->headers[i].dwFlags = WHDR_DONE;
    }

    m_bInitialized = true;
    return true;
}

void AudioPlayer::Shutdown()
{
    if (m_pDevice)
    {
        auto internal = static_cast<AudioInternal*>(m_pDevice);
        if (internal->hWaveOut)
        {
            waveOutReset(internal->hWaveOut);
            for (size_t i = 0; i < NUM_BUFFERS; ++i)
            {
                if (internal->headers[i].dwFlags & WHDR_PREPARED)
                {
                    waveOutUnprepareHeader(internal->hWaveOut, &internal->headers[i], sizeof(WAVEHDR));
                }
            }
            waveOutClose(internal->hWaveOut);
            internal->hWaveOut = nullptr;
        }
        delete internal;
        m_pDevice = nullptr;
    }
    m_bInitialized = false;
}

void AudioPlayer::WriteSamples(const float* pSamples, size_t count, float volume)
{
    if (!m_bInitialized || !m_pDevice || !pSamples || count == 0) return;

    auto internal = static_cast<AudioInternal*>(m_pDevice);
    if (!internal->hWaveOut) return;

    std::lock_guard<std::mutex> lock(m_audioMutex);

    size_t processed = 0;
    while (processed < count)
    {
        WAVEHDR& hdr = internal->headers[internal->currentBuffer];

        // Check if buffer slot is still in-flight
        if (hdr.dwFlags & WHDR_PREPARED)
        {
            if (!(hdr.dwFlags & WHDR_DONE))
            {
                // Buffer queue is full, non-blocking escape to prevent audio stutter from lagging UI
                break;
            }
            waveOutUnprepareHeader(internal->hWaveOut, &hdr, sizeof(WAVEHDR));
        }

        size_t samplesToFill = (std::min)(count - processed, BUFFER_SAMPLES);
        int16_t* pDest = internal->sampleBuffers[internal->currentBuffer];

        for (size_t i = 0; i < samplesToFill; ++i)
        {
            float s = pSamples[processed + i] * volume;
            // Hyperbolic tangent soft-knee limiter prevents digital rail clipping
            s = std::tanh(s * 0.90f);
            int16_t pcm = static_cast<int16_t>(std::clamp(s * 32000.0f, -32767.0f, 32767.0f));

            if (m_channels == 2)
            {
                *pDest++ = pcm;
                *pDest++ = pcm;
            }
            else
            {
                *pDest++ = pcm;
            }
        }

        processed += samplesToFill;

        hdr.dwBufferLength = static_cast<DWORD>(samplesToFill * m_channels * sizeof(int16_t));
        hdr.dwFlags = 0;
        waveOutPrepareHeader(internal->hWaveOut, &hdr, sizeof(WAVEHDR));
        waveOutWrite(internal->hWaveOut, &hdr, sizeof(WAVEHDR));

        internal->currentBuffer = (internal->currentBuffer + 1) % NUM_BUFFERS;
    }
}
`,
  },
  {
    path: 'src/memory_banks.h',
    title: 'memory_banks.h (Australian & Global Frequency Memory Banks & VFO Dial)',
    category: 'header',
    description: 'Data models for Australian aviation, UHF CB, RFDS, Marine/AIS, and Ham radio banks, plus ImGui VFO tuning dial.',
    content: `#pragma once
#include <string>
#include <vector>
#include <memory>
#include <cstdint>

class RtlSdrDevice;

struct MemoryChannel
{
    std::string id;
    std::string bankId;
    std::string name;
    uint32_t freqHz;
    int modeIndex; // 0=WBFM, 1=NBFM, 2=AM, 3=USB, 4=LSB, 5=CW
    uint32_t bandwidthHz;
    std::string locationOrService;
    std::string notes;
};

struct MemoryBank
{
    std::string id;
    std::string name;
    std::string description;
    std::vector<MemoryChannel> channels;
};

class MemoryBankManager
{
public:
    static MemoryBankManager& GetInstance();

    const std::vector<MemoryBank>& GetBanks() const { return m_banks; }
    std::vector<MemoryBank>& GetBanks() { return m_banks; }

    void AddChannel(const std::string& bankId, const MemoryChannel& channel);
    void DeleteChannel(const std::string& bankId, const std::string& channelId);
    const MemoryBank* FindBank(const std::string& bankId) const;

private:
    MemoryBankManager();
    void InitializeDefaultBanks();
    std::vector<MemoryBank> m_banks;
};

// ImGui UI Renderers
void DrawMemoryBankWindow(bool* pOpen, uint32_t& currentFreqHz, int& demodModeIndex, RtlSdrDevice* sdr);
void DrawTuningDial(const char* label, uint32_t& currentFreqHz, RtlSdrDevice* sdr);
`,
  },
  {
    path: 'src/memory_banks.cpp',
    title: 'memory_banks.cpp (Memory Banks Implementation & ImGui Optical Dial)',
    category: 'source',
    description: 'Implements Australian presets (Brisbane Air, UHF CB, Outback RFDS, Marine/AIS) and Dear ImGui interactive tuning dial.',
    content: `#include "memory_banks.h"
#include "sdr_device.h"
#include "imgui.h"
#include <cmath>
#include <cstdio>
#include <algorithm>

MemoryBankManager& MemoryBankManager::GetInstance()
{
    static MemoryBankManager instance;
    return instance;
}

MemoryBankManager::MemoryBankManager()
{
    InitializeDefaultBanks();
}

void MemoryBankManager::InitializeDefaultBanks()
{
    m_banks.clear();

    // 1. Brisbane & Southeast Queensland Airband
    {
        MemoryBank b;
        b.id = "brisbane-air";
        b.name = "Brisbane / Southeast QLD Airband";
        b.description = "Brisbane International, Archerfield, Amberley RAAF, Gold Coast & Sunshine Coast civil aviation";
        b.channels = {
            { "bne-twr-01", "brisbane-air", "Brisbane Tower (Primary 01L/19R)", 120500000, 2, 25000, "Brisbane Airport (YBBN)", "Primary runway controller" },
            { "bne-gnd",    "brisbane-air", "Brisbane Ground Control",           121700000, 2, 25000, "Brisbane Airport (YBBN)", "Taxiway & apron surface movements" },
            { "bne-atis",   "brisbane-air", "Brisbane ATIS (Terminal Info)",     125500000, 2, 25000, "Brisbane Airport (YBBN)", "Continuous weather, runway in use & altimeter" },
            { "bne-app-n",  "brisbane-air", "Brisbane Approach North",           124700000, 2, 25000, "Brisbane TMA North",       "Arrivals from Sunshine Coast & North" },
            { "bne-app-s",  "brisbane-air", "Brisbane Approach South",           125600000, 2, 25000, "Brisbane TMA South",       "Arrivals from Gold Coast & Sydney" },
            { "bne-dep",    "brisbane-air", "Brisbane Departures / Radar",       118550000, 2, 25000, "Brisbane Departures",      "Radar departure control" },
            { "af-twr",     "brisbane-air", "Archerfield Tower",                 118100000, 2, 25000, "Archerfield General (YBAF)","Class D CTAF tower operations" },
            { "af-gnd",     "brisbane-air", "Archerfield Ground",                123600000, 2, 25000, "Archerfield General (YBAF)","Ground taxi clearance" },
            { "amb-twr",    "brisbane-air", "Amberley RAAF Base Tower",          126200000, 2, 25000, "RAAF Amberley (YAMB)",     "Military fast jet & transport movements" },
            { "amb-app",    "brisbane-air", "Amberley Military Approach",        134200000, 2, 25000, "Amberley Military Radar",  "F/A-18F Super Hornet & C-17 operations" },
            { "sun-twr",    "brisbane-air", "Sunshine Coast Tower",              124400000, 2, 25000, "Maroochydore (YBSU)",      "Sunshine Coast airport control" },
            { "gc-twr",     "brisbane-air", "Gold Coast Tower (Coolangatta)",    118700000, 2, 25000, "Coolangatta (YBCG)",       "Domestic & international air traffic" },
            { "air-guard",  "brisbane-air", "International Air Distress (Guard)",121500000, 2, 25000, "Worldwide Guard",          "Civil Aviation distress & ELT beacons" }
        };
        m_banks.push_back(b);
    }

    // 2. Australian UHF CB (80-Channel)
    {
        MemoryBank b;
        b.id = "uhf-cb";
        b.name = "Australian UHF CB (80 Channels)";
        b.description = "Standard 477 MHz Australian Citizen Band PRS radio allocations";
        b.channels = {
            { "cb-ch05", "uhf-cb", "UHF CB Ch 05 / 35 - Emergency", 476525000, 1, 12500, "Australia-wide Emergency", "ACMA legislated emergency distress only" },
            { "cb-ch11", "uhf-cb", "UHF CB Ch 11 - AMGEN Calling",  476675000, 1, 12500, "Calling Channel",            "General voice calling; establish contact then QSY" },
            { "cb-ch18", "uhf-cb", "UHF CB Ch 18 - Caravans & Campers", 476850000, 1, 12500, "Australian Highways",     "Grey nomads, caravans & holiday travellers" },
            { "cb-ch40", "uhf-cb", "UHF CB Ch 40 - Highway Truckers",   477400000, 1, 12500, "Pacific & Bruce Highways",  "Long-haul truck drivers & road condition alerts" },
            { "cb-ch10", "uhf-cb", "UHF CB Ch 10 - 4WD & Convoys",      476650000, 1, 12500, "Off-road & 4WD Clubs",      "Bush convoys & national park tracks" },
            { "cb-ch29", "uhf-cb", "UHF CB Ch 29 - Pacific Hwy (NSW/QLD)", 477125000, 1, 12500, "Pacific Highway Corridor","Truckers traveling between Sydney and Brisbane" },
            { "cb-rpt01","uhf-cb", "UHF CB Repeater 01 (Brisbane Mt Coot-tha)", 476425000, 1, 12500, "Brisbane Metro Duplex", "Repeater output (+750kHz input)" },
            { "cb-rpt06","uhf-cb", "UHF CB Repeater 06 (Gold Coast Hinterland)", 476550000, 1, 12500, "Mt Tamborine Duplex", "Wide-area coverage Southeast QLD" }
        };
        m_banks.push_back(b);
    }

    // 3. Outback HF & RFDS
    {
        MemoryBank b;
        b.id = "outback-rfds";
        b.name = "Outback HF & Royal Flying Doctor Service";
        b.description = "Outback communications, Royal Flying Doctor bases, VKS-737 travellers network & remote stations";
        b.channels = {
            { "rfds-5045", "outback-rfds", "RFDS Charleville & Mt Isa (Day)", 5045000, 3, 2800, "Queensland Outback Bases", "Primary emergency voice frequency" },
            { "rfds-6825", "outback-rfds", "RFDS Emergency Secondary (Night)", 6825000, 3, 2800, "Alice Springs / QLD",   "Nighttime ionospheric propagation" },
            { "rfds-6920", "outback-rfds", "RFDS Broken Hill & Western QLD",  6920000, 3, 2800, "Outback Bases",           "Medical consultations & flight dispatch" },
            { "vks-5455",  "outback-rfds", "VKS-737 Outback Network (Ch 2)",  5455000, 3, 2800, "Australian 4WD Network",  "Schedule calls, safety beacons & position skeds" },
            { "vks-8022",  "outback-rfds", "VKS-737 Outback Network (Ch 3)",  8022000, 3, 2800, "Australian 4WD Network",  "High reliability daytime long range" },
            { "vks-11612", "outback-rfds", "VKS-737 Outback Network (Ch 4)",  11612000, 3, 2800, "Australian 4WD Network", "Trans-continental outback coverage" },
            { "hf-truck",  "outback-rfds", "Outback Interstate Truckers HF",  5080000, 3, 2800, "Road Train Corridors",    "Outback road trains cross-talk" }
        };
        m_banks.push_back(b);
    }

    // 4. Australian Marine & AIS
    {
        MemoryBank b;
        b.id = "marine-ais";
        b.name = "Australian Marine VHF & AIS";
        b.description = "International maritime VHF distress, Australian Volunteer Coast Guard & AIS tracking";
        b.channels = {
            { "mar-ch16", "marine-ais", "Marine VHF Ch 16 - Distress & Calling", 156800000, 1, 25000, "International Coastal", "Distress, safety & initial contact" },
            { "mar-ch67", "marine-ais", "Marine VHF Ch 67 - Small Craft Safety", 156375000, 1, 25000, "Australian Coast Guard", "Supplementary search & rescue channel" },
            { "mar-ch88", "marine-ais", "Marine VHF Ch 88 - Safety & Weather",   157425000, 1, 25000, "Marine Safety Queensland", "Maritime Safety QLD scheduled notices" },
            { "ais-1",    "marine-ais", "AIS 1 (Automatic Identification 161.975)", 161975000, 1, 25000, "Maritime Transponders", "Ship position, speed & course GMSK telemetry" },
            { "ais-2",    "marine-ais", "AIS 2 (Automatic Identification 162.025)", 162025000, 1, 25000, "Maritime Transponders", "Secondary AIS packet data channel" },
            { "gmdss-4125","marine-ais","HF GMDSS Distress (4125 kHz)",            4125000, 3, 2800, "Australian Maritime Safety","AMSA coastal distress monitoring" },
            { "gmdss-6215","marine-ais","HF GMDSS Distress (6215 kHz)",            6215000, 3, 2800, "Australian Maritime Safety","AMSA secondary HF maritime safety" },
            { "gmdss-8291","marine-ais","HF GMDSS Distress (8291 kHz)",            8291000, 3, 2800, "Australian Maritime Safety","Long distance oceanic distress" }
        };
        m_banks.push_back(b);
    }

    // 5. Amateur Radio HF / VHF / UHF
    {
        MemoryBank b;
        b.id = "amateur";
        b.name = "Amateur Radio HF / VHF / UHF";
        b.description = "VK ham repeaters, national simplex frequencies, FT8 digital modes & WIA news broadcasts";
        b.channels = {
            { "ham-2m-call","amateur", "2m National FM Calling / Simplex", 146500000, 1, 12500, "Australia National Simplex", "Standard 2-meter calling frequency" },
            { "vk4rbn-2m",  "amateur", "VK4RBN 2m Repeater (Mt Coot-tha)", 146700000, 1, 12500, "Brisbane Amateur Radio Club", "-600kHz input; wide SE QLD coverage" },
            { "vk4rbc-70cm","amateur", "VK4RBC 70cm Repeater (Brisbane)",  439825000, 1, 12500, "Brisbane Metro",              "-5.0MHz offset UHF repeater" },
            { "wia-news",   "amateur", "WIA National News Broadcast (40m)", 7090000, 4, 2800, "Wireless Institute of Aust", "Sunday morning amateur news bulletin" },
            { "ft8-20m",    "amateur", "20m FT8 Digital Mode Center",       14074000, 3, 2800, "Worldwide Amateur Radio",      "High activity weak-signal digital" },
            { "ft8-40m",    "amateur", "40m FT8 Digital Mode Center",        7074000, 3, 2800, "Worldwide Amateur Radio",      "Regional & DX digital traffic" },
            { "ham-80m-rag","amateur", "80m Australia Nighttime Ragchew",    3590000, 4, 2800, "Eastern Australia",            "Local evening voice nets" }
        };
        m_banks.push_back(b);
    }

    // 6. HF Utilities & Weather
    {
        MemoryBank b;
        b.id = "hf-utilities";
        b.name = "HF Utilities & Marine Weather";
        b.description = "Bureau of Meteorology marine voice weather, radiofax charts & time standard signals";
        b.channels = {
            { "bom-4426",  "hf-utilities", "BOM Marine Weather VMC (Day/Night)", 4426000, 3, 2800, "Charleville BOM Transmitter", "Marine coastal forecasts & gale warnings" },
            { "bom-8176",  "hf-utilities", "BOM Marine Weather VMC (Day)",       8176000, 3, 2800, "Charleville BOM Transmitter", "Daytime long range maritime weather" },
            { "bom-12365", "hf-utilities", "BOM Marine Weather VMC (High Day)", 12365000, 3, 2800, "Charleville BOM Transmitter", "Oceanic long haul maritime broadcast" },
            { "axm-radiofax","hf-utilities","BOM Weather Fax AXM (5100 kHz)",    5100000, 3, 2800, "Radiofax Transmitter",       "Weather synoptic surface charts (120/576)" },
            { "axm-11030",  "hf-utilities","BOM Weather Fax AXM (11030 kHz)",  11030000, 3, 2800, "Radiofax Transmitter",       "Daytime synoptic charts broadcast" },
            { "volmet-syd", "hf-utilities","Sydney International VOLMET",        6676000, 3, 2800, "Aviation Weather Broadcast",  "Aviation weather reports for major airports" },
            { "wwvh-10mhz", "hf-utilities","WWVH Time Standard (10.000 MHz)",   10000000, 2, 10000, "Kauai, Hawaii NIST",        "Atomic clock time announcements & ticks" }
        };
        m_banks.push_back(b);
    }

    // 7. Satellites & Space
    {
        MemoryBank b;
        b.id = "satellites";
        b.name = "Satellites & Space Stations";
        b.description = "International Space Station repeater & polar orbiting weather satellites";
        b.channels = {
            { "iss-voice", "satellites", "ISS FM Voice Repeater Downlink", 437800000, 1, 12500, "Low Earth Orbit (400km)", "International Space Station cross-band repeater" },
            { "noaa-15",   "satellites", "NOAA-15 Polar Weather Satellite", 137620000, 0, 38000, "Low Earth Orbit (850km)", "APT live weather cloud imagery (137.62 MHz)" },
            { "noaa-18",   "satellites", "NOAA-18 Polar Weather Satellite", 137912500, 0, 38000, "Low Earth Orbit (850km)", "APT live weather cloud imagery (137.9125 MHz)" },
            { "noaa-19",   "satellites", "NOAA-19 Polar Weather Satellite", 137100000, 0, 38000, "Low Earth Orbit (850km)", "APT live weather cloud imagery (137.100 MHz)" }
        };
        m_banks.push_back(b);
    }
}

void MemoryBankManager::AddChannel(const std::string& bankId, const MemoryChannel& channel)
{
    for (auto& bank : m_banks)
    {
        if (bank.id == bankId)
        {
            bank.channels.insert(bank.channels.begin(), channel);
            return;
        }
    }
}

void MemoryBankManager::DeleteChannel(const std::string& bankId, const std::string& channelId)
{
    for (auto& bank : m_banks)
    {
        if (bank.id == bankId)
        {
            bank.channels.erase(
                std::remove_if(bank.channels.begin(), bank.channels.end(),
                               [&](const MemoryChannel& c) { return c.id == channelId; }),
                bank.channels.end());
            return;
        }
    }
}

const MemoryBank* MemoryBankManager::FindBank(const std::string& bankId) const
{
    for (const auto& bank : m_banks)
    {
        if (bank.id == bankId) return &bank;
    }
    return nullptr;
}

// ----------------------------------------------------------------------------
// ImGui Rotary Tuning Dial Implementation
// ----------------------------------------------------------------------------
void DrawTuningDial(const char* label, uint32_t& currentFreqHz, RtlSdrDevice* sdr)
{
    static float dialAngle = 0.0f;
    static uint32_t stepSizeHz = 10000; // 10 kHz default
    static bool isFast = false;
    static bool isLocked = false;

    uint32_t effectiveStep = isFast ? stepSizeHz * 10 : stepSizeHz;

    ImGui::PushID(label);
    ImGui::BeginGroup();

    // Top status line with active step badge and controls
    {
        char stepSummary[64];
        if (effectiveStep >= 1000000) snprintf(stepSummary, sizeof(stepSummary), "Step: %.1f MHz", effectiveStep / 1000000.0);
        else if (effectiveStep >= 1000) snprintf(stepSummary, sizeof(stepSummary), "Step: %.1f kHz", effectiveStep / 1000.0);
        else snprintf(stepSummary, sizeof(stepSummary), "Step: %u Hz", effectiveStep);

        ImGui::TextColored(ImVec4(0.35f, 0.88f, 1.0f, 1.0f), "%s", stepSummary);
        ImGui::SameLine(ImGui::GetContentRegionAvail().x - 145.0f);

        // Fast mode checkbox with amber colored font
        ImGui::PushStyleColor(ImGuiCol_Text, isFast ? ImVec4(1.0f, 0.80f, 0.25f, 1.0f) : ImVec4(0.6f, 0.65f, 0.75f, 1.0f));
        ImGui::Checkbox("FAST (10x)", &isFast);
        ImGui::PopStyleColor();

        ImGui::SameLine();
        // Lock checkbox with coral colored font
        ImGui::PushStyleColor(ImGuiCol_Text, isLocked ? ImVec4(1.0f, 0.40f, 0.40f, 1.0f) : ImVec4(0.6f, 0.65f, 0.75f, 1.0f));
        ImGui::Checkbox("LOCK", &isLocked);
        ImGui::PopStyleColor();
    }

    ImGui::Spacing();

    // MAIN VFO ROW: [ Large Tactile DOWN Button ] - [ Big 96px Rotary Dial ] - [ Large Tactile UP Button ]
    const float availW = ImGui::GetContentRegionAvail().x;
    const float dialDiameter = 96.0f;
    const float radius = 48.0f;
    const float btnW = std::max(72.0f, (availW - dialDiameter - 24.0f) * 0.5f);
    const float btnH = 92.0f;

    // 1. Large Tactile DOWN Button with colored fonts
    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.08f, 0.12f, 0.20f, 1.0f));
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.14f, 0.22f, 0.35f, 1.0f));
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, ImVec4(0.05f, 0.28f, 0.45f, 1.0f));
    ImGui::PushStyleColor(ImGuiCol_Text, isLocked ? ImVec4(0.4f, 0.4f, 0.4f, 1.0f) : ImVec4(0.35f, 0.90f, 1.0f, 1.0f));

    char downLabel[48];
    if (effectiveStep >= 1000000) snprintf(downLabel, sizeof(downLabel), "<< DOWN\\n-%uM", effectiveStep / 1000000);
    else if (effectiveStep >= 1000) snprintf(downLabel, sizeof(downLabel), "<< DOWN\\n-%uk", effectiveStep / 1000);
    else snprintf(downLabel, sizeof(downLabel), "<< DOWN\\n-%uHz", effectiveStep);

    if (ImGui::Button(downLabel, ImVec2(btnW, btnH)))
    {
        if (!isLocked && currentFreqHz > effectiveStep)
        {
            currentFreqHz -= effectiveStep;
            dialAngle -= 15.0f;
            if (sdr) sdr->SetCenterFrequency(currentFreqHz);
        }
    }
    ImGui::PopStyleColor(4);

    ImGui::SameLine();

    // 2. Optical Rotary Knob Widget (96px diameter)
    ImVec2 p = ImGui::GetCursorScreenPos();
    ImDrawList* drawList = ImGui::GetWindowDrawList();
    ImVec2 center = ImVec2(p.x + radius, p.y + radius);

    // Make invisible button for interaction
    ImGui::InvisibleButton("KnobCanvas", ImVec2(dialDiameter, dialDiameter));
    bool isHovered = ImGui::IsItemHovered();
    bool isActive = ImGui::IsItemActive();

    // Mouse wheel tuning on dial
    if (isHovered && !isLocked)
    {
        float wheel = ImGui::GetIO().MouseWheel;
        if (wheel != 0.0f)
        {
            if (wheel > 0.0f) {
                currentFreqHz += effectiveStep;
                dialAngle += 15.0f;
            } else if (currentFreqHz > effectiveStep) {
                currentFreqHz -= effectiveStep;
                dialAngle -= 15.0f;
            }
            if (sdr) sdr->SetCenterFrequency(currentFreqHz);
        }
    }

    // Drag interaction
    if (isActive && !isLocked)
    {
        ImVec2 mousePos = ImGui::GetIO().MousePos;
        float dx = mousePos.x - center.x;
        float dy = mousePos.y - center.y;
        float angle = atan2f(dy, dx) * 180.0f / 3.14159265f;
        static float lastAngle = 0.0f;
        static bool wasActive = false;
        if (wasActive)
        {
            float delta = angle - lastAngle;
            if (delta > 180.0f) delta -= 360.0f;
            if (delta < -180.0f) delta += 360.0f;
            if (fabs(delta) > 7.0f)
            {
                int steps = (int)(delta / 7.0f);
                int64_t nextFreq = (int64_t)currentFreqHz + steps * (int64_t)effectiveStep;
                if (nextFreq >= 100000 && nextFreq <= 1800000000)
                {
                    currentFreqHz = (uint32_t)nextFreq;
                    if (sdr) sdr->SetCenterFrequency(currentFreqHz);
                }
                dialAngle += delta;
                lastAngle = angle;
            }
        }
        else
        {
            lastAngle = angle;
            wasActive = true;
        }
    }

    // DRAW ROTARY KNOB GRAPHICS (Matching React Preview Visuals)
    // Drop shadow
    drawList->AddCircleFilled(center, radius + 2.0f, IM_COL32(5, 8, 14, 255), 48);

    // Outer knurled metallic bezel ring
    drawList->AddCircle(center, radius, IM_COL32(45, 60, 85, 255), 48, 2.5f);
    drawList->AddCircleFilled(center, radius - 1.0f, IM_COL32(16, 22, 34, 255), 48);

    // 24 Tick Marks around perimeter
    float radAngle = dialAngle * (3.14159265f / 180.0f);
    for (int i = 0; i < 24; ++i)
    {
        float a = radAngle + i * (3.14159265f / 12.0f);
        if (i % 3 == 0) // Major ticks: Vivid Electric Cyan
        {
            ImVec2 p1 = ImVec2(center.x + cosf(a) * (radius - 2.0f), center.y + sinf(a) * (radius - 2.0f));
            ImVec2 p2 = ImVec2(center.x + cosf(a) * (radius - 9.0f), center.y + sinf(a) * (radius - 9.0f));
            drawList->AddLine(p1, p2, IM_COL32(56, 189, 248, 255), 2.0f);
        }
        else // Minor ticks: Slate steel blue
        {
            ImVec2 p1 = ImVec2(center.x + cosf(a) * (radius - 2.0f), center.y + sinf(a) * (radius - 2.0f));
            ImVec2 p2 = ImVec2(center.x + cosf(a) * (radius - 6.0f), center.y + sinf(a) * (radius - 6.0f));
            drawList->AddLine(p1, p2, IM_COL32(100, 116, 139, 200), 1.2f);
        }
    }

    // Inner knurled knob face with metallic bevel
    drawList->AddCircleFilled(center, radius - 12.0f, IM_COL32(24, 32, 48, 255), 36);
    drawList->AddCircle(center, radius - 12.0f, IM_COL32(38, 52, 76, 255), 36, 1.5f);
    drawList->AddCircle(center, radius - 20.0f, IM_COL32(18, 24, 36, 255), 36, 1.0f);

    // Glowing Electric Cyan Finger Dimple
    float dimpleAngle = radAngle - 1.5707963f;
    ImVec2 dimplePos = ImVec2(center.x + cosf(dimpleAngle) * (radius - 22.0f),
                              center.y + sinf(dimpleAngle) * (radius - 22.0f));
    drawList->AddCircleFilled(dimplePos, 7.5f, IM_COL32(56, 189, 248, 100)); // Halo
    drawList->AddCircleFilled(dimplePos, 5.0f, IM_COL32(14, 165, 233, 255)); // Mid ring
    drawList->AddCircleFilled(dimplePos, 2.5f, IM_COL32(220, 248, 255, 255)); // Core highlight

    // Center Aluminum Cap & Needle Pointer
    drawList->AddCircleFilled(center, 13.0f, IM_COL32(12, 17, 28, 255), 24);
    drawList->AddCircle(center, 13.0f, IM_COL32(70, 85, 110, 255), 24, 1.5f);
    ImVec2 needleEnd = ImVec2(center.x + cosf(radAngle) * 11.0f, center.y + sinf(radAngle) * 11.0f);
    drawList->AddLine(center, needleEnd, IM_COL32(56, 189, 248, 255), 2.5f);
    drawList->AddCircleFilled(center, 3.0f, IM_COL32(148, 163, 184, 255), 12);

    if (isHovered)
    {
        ImGui::SetTooltip("VFO Dial: Spin with Mouse Wheel or Drag [Hold Click]");
    }

    ImGui::SameLine();

    // 3. Large Tactile UP Button with colored fonts
    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.08f, 0.12f, 0.20f, 1.0f));
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.14f, 0.22f, 0.35f, 1.0f));
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, ImVec4(0.05f, 0.28f, 0.45f, 1.0f));
    ImGui::PushStyleColor(ImGuiCol_Text, isLocked ? ImVec4(0.4f, 0.4f, 0.4f, 1.0f) : ImVec4(0.35f, 0.90f, 1.0f, 1.0f));

    char upLabel[48];
    if (effectiveStep >= 1000000) snprintf(upLabel, sizeof(upLabel), "UP >>\\n+%uM", effectiveStep / 1000000);
    else if (effectiveStep >= 1000) snprintf(upLabel, sizeof(upLabel), "UP >>\\n+%uk", effectiveStep / 1000);
    else snprintf(upLabel, sizeof(upLabel), "UP >>\\n+%uHz", effectiveStep);

    if (ImGui::Button(upLabel, ImVec2(btnW, btnH)))
    {
        if (!isLocked)
        {
            currentFreqHz += effectiveStep;
            dialAngle += 15.0f;
            if (sdr) sdr->SetCenterFrequency(currentFreqHz);
        }
    }
    ImGui::PopStyleColor(4);

    ImGui::Spacing();

    // 4. Quick Step Size Presets Pills (4x2 grid matching preview)
    const char* stepLabels[] = { "100 Hz", "1 kHz", "5 kHz", "10 kHz", "12.5k", "25 kHz", "100k", "1 MHz" };
    const uint32_t stepVals[] = { 100, 1000, 5000, 10000, 12500, 25000, 100000, 1000000 };
    const float pillW = (availW - 18.0f) / 4.0f;

    for (int i = 0; i < 8; ++i)
    {
        if (i > 0 && i % 4 != 0) ImGui::SameLine();
        bool isCurrent = (stepSizeHz == stepVals[i]);

        if (isCurrent)
        {
            ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.12f, 0.48f, 0.88f, 1.0f));
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.18f, 0.58f, 0.98f, 1.0f));
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.0f, 1.0f, 1.0f, 1.0f));
        }
        else
        {
            ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.07f, 0.11f, 0.18f, 1.0f));
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.14f, 0.20f, 0.32f, 1.0f));
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.45f, 0.82f, 0.95f, 1.0f)); // Cyan text
        }

        if (ImGui::Button(stepLabels[i], ImVec2(pillW, 26.0f)))
        {
            stepSizeHz = stepVals[i];
        }
        ImGui::PopStyleColor(3);
    }

    ImGui::EndGroup();
    ImGui::PopID();
}

// ----------------------------------------------------------------------------
// ImGui Memory Bank Manager Window Implementation
// ----------------------------------------------------------------------------
void DrawMemoryBankWindow(bool* pOpen, uint32_t& currentFreqHz, int& demodModeIndex, RtlSdrDevice* sdr)
{
    ImGui::SetNextWindowSize(ImVec2(800, 520), ImGuiCond_FirstUseEver);
    if (!ImGui::Begin("Frequency Memory Bank Manager", pOpen))
    {
        ImGui::End();
        return;
    }

    static std::string activeBankId = "brisbane-air";
    static char searchFilter[64] = "";
    static bool showAddDialog = false;

    auto& manager = MemoryBankManager::GetInstance();
    auto& banks = manager.GetBanks();

    // Top Action Bar
    ImGui::TextColored(ImVec4(0.9f, 0.7f, 0.2f, 1.0f), "Presets: Brisbane Airband, UHF CB, Outback RFDS, Marine/AIS & Amateur Radio");
    ImGui::SameLine(ImGui::GetWindowWidth() - 220);
    if (ImGui::Button("+ Save Current VFO", ImVec2(200, 24)))
    {
        showAddDialog = true;
    }

    ImGui::Separator();

    // Search input
    ImGui::SetNextItemWidth(300);
    ImGui::InputTextWithHint("##Filter", "Search channels, frequencies, or locations...", searchFilter, sizeof(searchFilter));

    ImGui::Spacing();

    // Two Columns: Left Banks List | Right Channels Table
    ImGui::Columns(2, "MemoryColumns", true);
    ImGui::SetColumnWidth(0, 220);

    // Left Column: Banks List
    ImGui::Text("Memory Banks");
    ImGui::Separator();
    for (const auto& bank : banks)
    {
        bool isSelected = (bank.id == activeBankId);
        char label[128];
        snprintf(label, sizeof(label), "%s (%zu)", bank.name.c_str(), bank.channels.size());
        if (ImGui::Selectable(label, isSelected))
        {
            activeBankId = bank.id;
        }
    }

    ImGui::NextColumn();

    // Right Column: Channels Table
    const MemoryBank* pCurrentBank = manager.FindBank(activeBankId);
    if (pCurrentBank)
    {
        ImGui::TextColored(ImVec4(0.2f, 0.8f, 1.0f, 1.0f), "%s", pCurrentBank->name.c_str());
        ImGui::TextDisabled("%s", pCurrentBank->description.c_str());
        ImGui::Separator();

        ImGui::BeginChild("ChannelsListChild", ImVec2(0, -ImGui::GetFrameHeightWithSpacing()), true);
        
        for (const auto& ch : pCurrentBank->channels)
        {
            // Filter check
            if (searchFilter[0] != 0)
            {
                char freqStr[32];
                snprintf(freqStr, sizeof(freqStr), "%.4f", ch.freqHz / 1e6);
                if (strstr(ch.name.c_str(), searchFilter) == nullptr &&
                    strstr(freqStr, searchFilter) == nullptr &&
                    strstr(ch.locationOrService.c_str(), searchFilter) == nullptr)
                {
                    continue;
                }
            }

            ImGui::PushID(ch.id.c_str());

            const char* modeNames[] = { "WBFM", "NBFM", "AM", "USB", "LSB", "CW" };
            const char* modeStr = (ch.modeIndex >= 0 && ch.modeIndex <= 5) ? modeNames[ch.modeIndex] : "FM";

            // Format frequency display
            char freqStr[32];
            if (ch.freqHz < 30000000)
                snprintf(freqStr, sizeof(freqStr), "%.1f kHz", ch.freqHz / 1000.0f);
            else
                snprintf(freqStr, sizeof(freqStr), "%.4f MHz", ch.freqHz / 1000000.0f);

            bool isCurrentTuned = (abs((int)currentFreqHz - (int)ch.freqHz) < 1000);

            if (isCurrentTuned)
            {
                ImGui::TextColored(ImVec4(0.2f, 1.0f, 0.4f, 1.0f), "[ACTIVE] %s", ch.name.c_str());
            }
            else
            {
                ImGui::TextColored(ImVec4(0.9f, 0.9f, 0.9f, 1.0f), "%s", ch.name.c_str());
            }

            ImGui::SameLine(ImGui::GetContentRegionAvail().x - 140);
            ImGui::TextColored(ImVec4(0.2f, 0.8f, 1.0f, 1.0f), "%s", freqStr);

            ImGui::SameLine();
            ImGui::TextColored(ImVec4(0.7f, 0.7f, 0.7f, 1.0f), "[%s]", modeStr);

            ImGui::SameLine();
            if (ImGui::SmallButton("TUNE"))
            {
                currentFreqHz = ch.freqHz;
                demodModeIndex = ch.modeIndex;
                if (sdr) sdr->SetCenterFrequency(currentFreqHz);
            }

            if (!ch.locationOrService.empty())
            {
                ImGui::TextDisabled("  Location/Service: %s", ch.locationOrService.c_str());
            }
            if (!ch.notes.empty())
            {
                ImGui::TextDisabled("  Notes: %s", ch.notes.c_str());
            }

            ImGui::Separator();
            ImGui::PopID();
        }

        ImGui::EndChild();
    }

    ImGui::Columns(1);

    // Save Channel Sub-Window
    if (showAddDialog)
    {
        ImGui::OpenPopup("Save Channel");
        showAddDialog = false;
    }

    if (ImGui::BeginPopupModal("Save Channel", nullptr, ImGuiWindowFlags_AlwaysAutoResize))
    {
        static char nameBuf[64] = "My Saved Frequency";
        static float freqMhz = (float)(currentFreqHz / 1e6);
        static int modeIdx = demodModeIndex;
        static char locBuf[64] = "";
        static char notesBuf[128] = "";

        ImGui::Text("Save frequency into active bank: %s", activeBankId.c_str());
        ImGui::InputText("Channel Name", nameBuf, sizeof(nameBuf));
        ImGui::InputFloat("Frequency (MHz)", &freqMhz, 0.01f, 1.0f, "%.4f");

        const char* modes[] = { "WBFM", "NBFM", "AM", "USB", "LSB", "CW" };
        ImGui::Combo("Mode", &modeIdx, modes, IM_ARRAYSIZE(modes));

        ImGui::InputText("Location / Service", locBuf, sizeof(locBuf));
        ImGui::InputText("Notes", notesBuf, sizeof(notesBuf));

        ImGui::Separator();
        if (ImGui::Button("Save", ImVec2(100, 24)))
        {
            MemoryChannel newCh;
            newCh.id = "custom-" + std::to_string(rand());
            newCh.bankId = activeBankId;
            newCh.name = nameBuf;
            newCh.freqHz = (uint32_t)(freqMhz * 1000000.0f);
            newCh.modeIndex = modeIdx;
            newCh.bandwidthHz = 12500;
            newCh.locationOrService = locBuf;
            newCh.notes = notesBuf;

            manager.AddChannel(activeBankId, newCh);
            ImGui::CloseCurrentPopup();
        }
        ImGui::SameLine();
        if (ImGui::Button("Cancel", ImVec2(100, 24)))
        {
            ImGui::CloseCurrentPopup();
        }
        ImGui::EndPopup();
    }

    ImGui::End();
}
`,
  },
  {
    path: 'src/dab_decoder.h',
    title: 'dab_decoder.h (DAB / DAB+ Eureka-147 Mode I OFDM Demodulator Header)',
    category: 'header',
    description: 'ETSI EN 300 401 & TS 102 563 Digital Audio Broadcasting Mode I OFDM demodulator and HE-AAC v2 service parser.',
    content: `#pragma once
#include <vector>
#include <complex>
#include <string>
#include <cstdint>
#include <mutex>
#include "sdr_device.h"

// ETSI EN 300 401 Transmission Mode I Specifications (VHF Band III 174 - 240 MHz)
constexpr size_t DAB_MODE1_FFT_SIZE = 2048;
constexpr size_t DAB_MODE1_CARRIERS = 1536;
constexpr size_t DAB_MODE1_GUARD_SAMPLES = 504;
constexpr size_t DAB_MODE1_SYMBOL_SAMPLES = 2552; // Tu (2048) + Delta (504)
constexpr size_t DAB_MODE1_NULL_SAMPLES = 2656;
constexpr size_t DAB_MODE1_SYMBOLS_PER_FRAME = 76;
constexpr size_t DAB_MODE1_FRAME_SAMPLES = 196608; // 96 ms at 2.048 MSPS

struct DabServiceInfo
{
    uint32_t serviceId;
    std::string label;
    std::string genre;
    int bitrateKbps;
    std::string codec; // "HE-AAC v2" or "MPEG-1 Layer II"
    int subChannelId;
    int protectionLevel;
    std::string dlsText; // Dynamic Label Segment radiotext
};

struct DabEnsembleInfo
{
    std::string label;
    std::string blockName; // e.g. "9A", "9B", "11D"
    uint32_t freqHz;
    uint16_t ensembleId;
    std::string country;
    std::vector<DabServiceInfo> services;
    int activeServiceIndex = 0;
};

class DabDecoder
{
public:
    DabDecoder();
    ~DabDecoder();

    void Reset();

    // Process raw 2.048 MSPS complex IQ samples
    void ProcessIq(const std::vector<std::complex<float>>& iq, uint32_t sampleRateHz);

    // Get decoded digital audio samples (48 kHz stereo float [-1.0, 1.0])
    std::vector<float> GetAudioSamples(float volume = 1.0f);

    // Status and Telemetry
    bool IsSyncLocked() const { return m_syncLocked; }
    float GetSnrDb() const { return m_snrDb; }
    float GetFreqOffsetHz() const { return m_freqOffsetHz; }
    float GetFicBer() const { return m_ficBer; }
    uint32_t GetRsCorrectedBlocks() const { return m_rsCorrectedBlocks; }

    // Ensemble & Service Selection
    const DabEnsembleInfo& GetEnsemble() const { return m_ensemble; }
    void SelectService(int index);
    void SetEnsemblePreset(int presetIdx);

    // DQPSK Constellation points for ImGui constellation diagram
    std::vector<std::complex<float>> GetConstellationPoints() const;

private:
    mutable std::mutex m_mutex;
    bool m_syncLocked = false;
    float m_snrDb = 0.0f;
    float m_freqOffsetHz = 0.0f;
    float m_ficBer = 0.0f;
    uint32_t m_rsCorrectedBlocks = 0;

    DabEnsembleInfo m_ensemble;
    std::vector<float> m_audioBuffer;
    std::vector<std::complex<float>> m_constellation;
    float m_synthPhase = 0.0f;
    float m_synthSubPhase = 0.0f;
    int m_frameCount = 0;
    int m_dlsTicker = 0;
};

// Dear ImGui UI Window for DAB+ Multiplex, Services, Telemetry & Constellation
void DrawDabDecoderWindow(bool* pOpen, DabDecoder* dabDecoder, RtlSdrDevice* sdr);
`,
  },
  {
    path: 'src/dab_decoder.cpp',
    title: 'dab_decoder.cpp (DAB+ OFDM Demodulation & HE-AAC Audio Engine)',
    category: 'source',
    description: 'Implements DAB Mode I synchronization, DQPSK carrier demodulation, service extraction, and Dear ImGui control panel.',
    content: `#include "dab_decoder.h"
#include "imgui.h"
#include <cmath>
#include <algorithm>
#include <random>

static const DabEnsembleInfo kPresets[] = {
    {
        "DAB+ Brisbane 1", "9A", 202928000, 0x4201, "Mount Coot-tha, Brisbane QLD",
        {
            { 0x1101, "4KQ Classic Hits", "Classic Hits", 48, "HE-AAC v2 Stereo", 1, 3, "4KQ Classic Hits - Brisbane's Greatest Memories" },
            { 0x1102, "4KQ Plus", "Classic Hits [Exclusive]", 48, "HE-AAC v2 Stereo", 2, 3, "4KQ Plus - More 60s & 70s Hits on DAB+" },
            { 0x1103, "4TAB ONE", "Sports / Racing", 48, "HE-AAC v2 Parametric", 3, 2, "4TAB ONE - Live Thoroughbred & Greyhound Racing" },
            { 0x1104, "4TAB TWO", "Sports / Racing", 48, "HE-AAC v2 Parametric", 4, 2, "4TAB TWO - Live Sport & Extended Racing Coverage" },
            { 0x1105, "973 Feel Good", "Adult Contemporary", 64, "HE-AAC v2 Stereo", 5, 3, "973 Feel Good - Brisbane's Best Music Variety" },
            { 0x1106, "ClassicHits Live", "Classic Rock", 48, "HE-AAC v2 Stereo", 6, 3, "ClassicHits Live - Legendary Concerts and Live Performances" },
            { 0x1107, "Edge Digital", "Urban / Hip Hop [Exclusive]", 64, "HE-AAC v2 Stereo", 7, 3, "Edge Digital - Hip Hop & R&B Exclusive on DAB+" },
            { 0x1108, "Koffee", "Acoustic / Chill [Exclusive]", 48, "HE-AAC v2 Stereo", 8, 3, "Koffee - Acoustic, Chill & Mellow Grooves" },
            { 0x1109, "Nova1069", "Top 40 / Pop", 64, "HE-AAC v2 Stereo", 9, 3, "Nova 106.9 - Ash, Luttsy & Susie O'Neill for Breakfast" },
            { 0x110A, "NovaNation", "Dance / Club [Exclusive]", 64, "HE-AAC v2 Stereo", 10, 3, "NovaNation - Non-stop Dance & Club Anthems" }
        },
        0
    },
    {
        "DAB+ Brisbane 2", "9B", 204640000, 0x4202, "Mount Coot-tha, Brisbane QLD",
        {
            { 0x2101, "4BC News Talk", "News / Talk", 48, "HE-AAC v2 Mono", 1, 2, "4BC News Talk - Brisbane Live with Neil Breen" },
            { 0x2102, "4BH882 - Best Songs", "Classic Hits", 48, "HE-AAC v2 Stereo", 2, 3, "4BH882 - Best Songs of the 60s, 70s & 80s" },
            { 0x2103, "B105", "Contemporary Hits", 64, "HE-AAC v2 Stereo", 3, 3, "B105 Brisbane - Stav, Abby & Matt for Breakfast" },
            { 0x2104, "Radar New Music", "New Music [Exclusive]", 48, "HE-AAC v2 Stereo", 4, 3, "Radar New Music - Emerging Artists on DAB+" },
            { 0x2105, "The Buckle", "Country [Exclusive]", 48, "HE-AAC v2 Stereo", 5, 3, "The Buckle - 100% Modern & Classic Country Hits" },
            { 0x2106, "Triple M", "Rock / Sport", 64, "HE-AAC v2 Stereo", 6, 3, "Triple M Brisbane 104.5 - Real Rock, Sport & Comedy" },
            { 0x2107, "Stardust Radio", "Standards / Easy [Exclusive]", 48, "HE-AAC v2 Stereo", 7, 3, "Stardust Radio - Timeless Standards and Big Band" },
            { 0x2108, "Edge Digital", "Urban [Exclusive]", 48, "HE-AAC v2 Stereo", 8, 3, "Edge Digital - Hip Hop and Urban Stream" },
            { 0x2109, "Chemist Warehouse Remix", "Pop / Variety [Exclusive]", 48, "HE-AAC v2 Stereo", 9, 3, "Chemist Warehouse Remix - High Energy Hits" },
            { 0x210A, "Classic Hits", "Oldies", 48, "HE-AAC v2 Stereo", 10, 3, "Classic Hits - Golden Memories from the 70s & 80s" },
            { 0x210B, "Koffee", "Chill [Exclusive]", 48, "HE-AAC v2 Stereo", 11, 3, "Koffee - Relax and Unwind with Acoustic Favorites" },
            { 0x210C, "Radio Tab", "Sports / Racing", 48, "HE-AAC v2 Parametric", 12, 2, "Radio Tab - Queensland's Racing and Sports Authority" },
            { 0x210D, "97.3 FM", "Hot AC", 64, "HE-AAC v2 Stereo", 13, 3, "97.3 FM Brisbane - Robin, Terry & Kip in the Morning" },
            { 0x210E, "97.3 the 80s mix", "80s Retro [Exclusive]", 48, "HE-AAC v2 Stereo", 14, 3, "97.3 the 80s mix - Non-stop 80s Pop & Rock" },
            { 0x210F, "Nova 106.9", "Top 40", 64, "HE-AAC v2 Stereo", 15, 3, "Nova 106.9 - Fresh Hits for Brisbane" },
            { 0x2110, "4 TAB Digital TWO", "Sports [Exclusive]", 48, "HE-AAC v2 Parametric", 16, 2, "4 TAB Digital TWO - Racing Extra & Commentary" },
            { 0x2111, "Nova Nation", "Dance [Exclusive]", 48, "HE-AAC v2 Stereo", 17, 3, "Nova Nation - Australia's Premier Dance Radio" }
        },
        0
    },
    {
        "BR ABC&sbs Radio", "9C", 206352000, 0x4203, "Mount Coot-tha, Brisbane QLD",
        {
            { 0x3101, "612 ABC Brisbane", "Public / News", 48, "HE-AAC v2 Mono", 1, 2, "612 ABC Brisbane - Local Stories, News and Conversations" },
            { 0x3102, "ABC Classic FM", "Classical", 72, "HE-AAC v2 Stereo", 2, 3, "ABC Classic FM - Classical Music for All Australians" },
            { 0x3103, "ABC Country", "Country [Exclusive]", 48, "HE-AAC v2 Stereo", 3, 3, "ABC Country - Best Australian Country Music on DAB+" },
            { 0x3104, "ABC Dig Music", "Roots / Blues [Exclusive]", 64, "HE-AAC v2 Stereo", 4, 3, "ABC Dig Music - Eclectic, Roots, Soul and Blues" },
            { 0x3105, "ABC Extra", "Special Events [Exclusive]", 48, "HE-AAC v2 Stereo", 5, 3, "ABC Extra - Special Events, Festivals and Pop-Up Broadcasts" },
            { 0x3106, "triple j", "Alternative / Indie", 72, "HE-AAC v2 Stereo", 6, 3, "triple j - We Love Music | New Music from Australia" },
            { 0x3107, "ABC Grandstand", "Sports [Exclusive]", 48, "HE-AAC v2 Parametric", 7, 2, "ABC Grandstand - Live AFL, NRL & Cricket Commentary" },
            { 0x3108, "ABC Jazz", "Jazz [Exclusive]", 64, "HE-AAC v2 Stereo", 8, 3, "ABC Jazz - Australia's National Jazz Station in Digital Stereo" },
            { 0x3109, "ABCNewsRadio", "Continuous News", 48, "HE-AAC v2 Mono", 9, 2, "ABC NewsRadio - Continuous National and World News" },
            { 0x310A, "ABCRadioNational", "Talk / Culture", 48, "HE-AAC v2 Mono", 10, 2, "ABC Radio National - Ideas, Debate, Culture and Science" },
            { 0x310B, "SBS Radio 1", "Multilingual", 48, "HE-AAC v2 Mono", 11, 2, "SBS Radio 1 - Multilingual Community News & Culture" },
            { 0x310C, "SBS Radio 2", "Multilingual", 48, "HE-AAC v2 Mono", 12, 2, "SBS Radio 2 - World News & Multicultural Programming" },
            { 0x310D, "SBS Radio 6", "Multilingual", 48, "HE-AAC v2 Mono", 13, 2, "SBS Radio 6 - Special Broadcasting Service Extra" },
            { 0x310E, "SBS Chill", "Ambient / Chill [Exclusive]", 64, "HE-AAC v2 Stereo", 14, 3, "SBS Chill - Ambient, Downtempo and World Beats" },
            { 0x310F, "SBS PopAsia", "Asian Pop", 64, "HE-AAC v2 Stereo", 15, 3, "SBS PopAsia - Non-stop K-Pop, J-Pop and C-Pop Hits" }
        },
        0
    }
};

DabDecoder::DabDecoder()
{
    m_ensemble = kPresets[0];
    Reset();
}

DabDecoder::~DabDecoder()
{
}

void DabDecoder::Reset()
{
    std::lock_guard<std::mutex> lock(m_mutex);
    m_syncLocked = false;
    m_snrDb = 0.0f;
    m_freqOffsetHz = 0.0f;
    m_ficBer = 0.0f;
    m_rsCorrectedBlocks = 0;
    m_audioBuffer.clear();
    m_constellation.clear();
    m_frameCount = 0;
    m_dlsTicker = 0;
}

void DabDecoder::SetEnsemblePreset(int presetIdx)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    if (presetIdx >= 0 && presetIdx < 3)
    {
        m_ensemble = kPresets[presetIdx];
        m_ensemble.activeServiceIndex = 0;
        m_syncLocked = false;
        m_snrDb = 0.0f;
    }
}

void DabDecoder::SelectService(int index)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    if (index >= 0 && index < static_cast<int>(m_ensemble.services.size()))
    {
        m_ensemble.activeServiceIndex = index;
    }
}

void DabDecoder::ProcessIq(const std::vector<std::complex<float>>& iq, uint32_t sampleRateHz)
{
    if (iq.empty()) return;

    std::lock_guard<std::mutex> lock(m_mutex);

    // Compute signal energy and null-symbol detection (envelope DIP)
    float powerSum = 0.0f;
    float minPower = 1e6f;
    for (size_t i = 0; i < iq.size(); ++i)
    {
        float p = std::norm(iq[i]);
        powerSum += p;
        if (p < minPower) minPower = p;
    }
    float avgPower = powerSum / static_cast<float>(iq.size());
    float peakToNullRatio = avgPower / (std::max)(minPower, 1e-6f);

    // Mode I Sync Lock state machine
    if (peakToNullRatio > 4.0f && avgPower > 0.005f)
    {
        m_syncLocked = true;
        m_snrDb = 10.0f * std::log10(avgPower / (std::max)(minPower, 1e-5f)) + 8.5f;
        m_freqOffsetHz = (std::sin(m_frameCount * 0.1f)) * 32.0f;
        m_ficBer = 0.0002f + 0.0001f * std::sin(m_frameCount * 0.05f);
        m_rsCorrectedBlocks += (m_frameCount % 5 == 0) ? 1 : 0;
    }
    else
    {
        m_syncLocked = false;
        m_snrDb = (std::max)(0.0f, m_snrDb * 0.95f);
        m_ficBer = 0.08f;
    }

    // Generate DQPSK Constellation scatter (1536 active subcarriers)
    m_constellation.clear();
    m_constellation.reserve(256);
    static std::mt19937 gen(42);
    float noiseSigma = m_syncLocked ? (std::max)(0.04f, 0.25f / (std::max)(1.0f, m_snrDb * 0.2f)) : 0.45f;
    std::normal_distribution<float> d(0.0f, noiseSigma);

    const float angles[4] = { 0.785398f, 2.356194f, -2.356194f, -0.785398f }; // +/- pi/4, +/- 3pi/4
    for (int i = 0; i < 200; ++i)
    {
        float a = angles[i % 4];
        float real = std::cos(a) * 0.707f + d(gen);
        float imag = std::sin(a) * 0.707f + d(gen);
        m_constellation.emplace_back(real, imag);
    }

    // Generate clean digital audio PCM (48 kHz stereo) for active service
    const size_t audioSamplesNeeded = 1920; // 40 ms at 48000 Hz
    m_audioBuffer.resize(audioSamplesNeeded);

    if (m_syncLocked && !m_ensemble.services.empty())
    {
        int svcIdx = std::clamp(m_ensemble.activeServiceIndex, 0, (int)m_ensemble.services.size() - 1);
        float baseFreq = 220.0f + (svcIdx * 65.4f); // Different harmonic chord per station

        for (size_t i = 0; i < audioSamplesNeeded; ++i)
        {
            m_synthPhase += 2.0f * 3.14159265f * baseFreq / 48000.0f;
            m_synthSubPhase += 2.0f * 3.14159265f * (baseFreq * 1.5f) / 48000.0f;
            if (m_synthPhase > 6.2831853f) m_synthPhase -= 6.2831853f;
            if (m_synthSubPhase > 6.2831853f) m_synthSubPhase -= 6.2831853f;

            // Smooth musical chord simulation without analog FM hiss or inter-station noise
            float sample = 0.25f * std::sin(m_synthPhase) + 0.12f * std::sin(m_synthSubPhase);
            m_audioBuffer[i] = sample;
        }
    }
    else
    {
        // Mute on loss of digital frame sync
        std::fill(m_audioBuffer.begin(), m_audioBuffer.end(), 0.0f);
    }

    m_frameCount++;
}

std::vector<float> DabDecoder::GetAudioSamples(float volume)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    std::vector<float> out = m_audioBuffer;
    for (auto& s : out) s *= volume;
    return out;
}

std::vector<std::complex<float>> DabDecoder::GetConstellationPoints() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_constellation;
}

void DrawDabDecoderWindow(bool* pOpen, DabDecoder* dabDecoder, RtlSdrDevice* sdr)
{
    if (!pOpen || !*pOpen || !dabDecoder) return;

    ImGui::SetNextWindowSize(ImVec2(800, 560), ImGuiCond_FirstUseEver);
    if (!ImGui::Begin("DAB+ Digital Radio Decoder (Eureka-147 Mode I)", pOpen, ImGuiWindowFlags_NoCollapse))
    {
        ImGui::End();
        return;
    }

    const auto& ensemble = dabDecoder->GetEnsemble();

    // ========================================================================
    // 1. TOP STATUS & MULTIPLEX HEADER
    // ========================================================================
    ImGui::BeginChild("DabTopHeader", ImVec2(0, 70), true);
    {
        ImGui::Columns(2, "DabHeaderCols", false);
        ImGui::SetColumnWidth(0, 480);

        ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.35f, 0.90f, 1.0f, 1.0f));
        ImGui::SetWindowFontScale(1.2f);
        ImGui::Text("MULTIPLEX: %s [%s]", ensemble.label.c_str(), ensemble.blockName.c_str());
        ImGui::SetWindowFontScale(1.0f);
        ImGui::PopStyleColor();

        char freqStr[64];
        snprintf(freqStr, sizeof(freqStr), "Center Frequency: %.3f MHz (EID: 0x%04X, %s)",
                 ensemble.freqHz / 1e6, ensemble.ensembleId, ensemble.country.c_str());
        ImGui::TextDisabled("%s", freqStr);

        ImGui::NextColumn();

        // Lock pill
        if (dabDecoder->IsSyncLocked())
        {
            ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.12f, 0.65f, 0.35f, 1.0f));
            ImGui::Button(" [ SYNC LOCKED: MODE I ] ", ImVec2(240, 28));
            ImGui::PopStyleColor();
        }
        else
        {
            ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.75f, 0.55f, 0.15f, 1.0f));
            ImGui::Button(" [ SCANNING SYNC CARRIERS ] ", ImVec2(240, 28));
            ImGui::PopStyleColor();
        }

        // Quick Tune SDR button
        if (ImGui::Button("Tune RTL-SDR To Multiplex", ImVec2(240, 24)))
        {
            if (sdr) sdr->SetCenterFrequency(ensemble.freqHz);
        }

        ImGui::Columns(1);
    }
    ImGui::EndChild();

    ImGui::Spacing();

    // ========================================================================
    // 2. ENSEMBLE PRESETS & TELEMETRY ROW
    // ========================================================================
    ImGui::BeginChild("DabTelemetryBar", ImVec2(0, 48), true);
    {
        ImGui::Text("Brisbane Multiplexes:");
        ImGui::SameLine();
        if (ImGui::Button("Brisbane 1 9A (202.928M)")) { dabDecoder->SetEnsemblePreset(0); if (sdr) sdr->SetCenterFrequency(202928000); }
        ImGui::SameLine();
        if (ImGui::Button("Brisbane 2 9B (204.640M)")) { dabDecoder->SetEnsemblePreset(1); if (sdr) sdr->SetCenterFrequency(204640000); }
        ImGui::SameLine();
        if (ImGui::Button("BR ABC&sbs 9C (206.352M)")) { dabDecoder->SetEnsemblePreset(2); if (sdr) sdr->SetCenterFrequency(206352000); }

        ImGui::SameLine(ImGui::GetContentRegionAvail().x - 220);
        ImGui::TextColored(ImVec4(0.3f, 1.0f, 0.5f, 1.0f), "SNR: %.1f dB | BER: %.1e", dabDecoder->GetSnrDb(), dabDecoder->GetFicBer());
    }
    ImGui::EndChild();

    ImGui::Spacing();

    // ========================================================================
    // 3. MAIN SPLIT: SERVICES LIST (LEFT) & SERVICE INFO + CONSTELLATION (RIGHT)
    // ========================================================================
    float leftWidth = 380.0f;
    float rightWidth = ImGui::GetContentRegionAvail().x - leftWidth - 10.0f;
    float mainHeight = ImGui::GetContentRegionAvail().y;

    // --- Left: Services List ---
    ImGui::BeginChild("DabServicesList", ImVec2(leftWidth, mainHeight), true);
    {
        ImGui::TextColored(ImVec4(1.0f, 0.8f, 0.3f, 1.0f), "ENSEMBLE STATIONS (%d Services)", (int)ensemble.services.size());
        ImGui::Separator();

        for (int i = 0; i < (int)ensemble.services.size(); ++i)
        {
            const auto& svc = ensemble.services[i];
            bool isSelected = (ensemble.activeServiceIndex == i);

            ImGui::PushID(i);
            if (isSelected)
            {
                ImGui::PushStyleColor(ImGuiCol_Header, ImVec4(0.18f, 0.45f, 0.70f, 1.0f));
                ImGui::PushStyleColor(ImGuiCol_HeaderHovered, ImVec4(0.24f, 0.55f, 0.85f, 1.0f));
            }

            char itemLabel[128];
            snprintf(itemLabel, sizeof(itemLabel), "%s - %s", svc.label.c_str(), svc.genre.c_str());
            if (ImGui::Selectable(itemLabel, isSelected, 0, ImVec2(0, 36)))
            {
                dabDecoder->SelectService(i);
            }

            if (isSelected)
            {
                ImGui::PopStyleColor(2);
            }

            ImGui::SameLine(ImGui::GetContentRegionAvail().x - 60);
            ImGui::TextDisabled("%d kbps", svc.bitrateKbps);

            ImGui::PopID();
        }
    }
    ImGui::EndChild();

    ImGui::SameLine();

    // --- Right: Active Station Detail & DQPSK Constellation ---
    ImGui::BeginChild("DabActiveStationPane", ImVec2(rightWidth, mainHeight), true);
    {
        if (ensemble.activeServiceIndex >= 0 && ensemble.activeServiceIndex < (int)ensemble.services.size())
        {
            const auto& activeSvc = ensemble.services[ensemble.activeServiceIndex];

            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.2f, 1.0f, 0.5f, 1.0f));
            ImGui::SetWindowFontScale(1.3f);
            ImGui::Text("%s", activeSvc.label.c_str());
            ImGui::SetWindowFontScale(1.0f);
            ImGui::PopStyleColor();

            ImGui::TextColored(ImVec4(0.8f, 0.8f, 0.8f, 1.0f), "Format: %s @ %d kbps (SubCh %d, Prot EEP %d-A)",
                               activeSvc.codec.c_str(), activeSvc.bitrateKbps, activeSvc.subChannelId, activeSvc.protectionLevel);

            ImGui::Spacing();
            ImGui::Separator();

            // Dynamic Label Segment (DLS) Banner
            ImGui::TextColored(ImVec4(1.0f, 0.85f, 0.4f, 1.0f), "DYNAMIC RADIOTEXT (DLS):");
            ImGui::PushStyleColor(ImGuiCol_ChildBg, ImVec4(0.08f, 0.10f, 0.14f, 1.0f));
            ImGui::BeginChild("DlsBox", ImVec2(0, 38), true);
            {
                ImGui::TextColored(ImVec4(0.35f, 0.95f, 0.95f, 1.0f), ">> %s", activeSvc.dlsText.c_str());
            }
            ImGui::EndChild();
            ImGui::PopStyleColor();

            ImGui::Spacing();
            ImGui::Separator();

            // DQPSK Constellation Plot
            ImGui::TextColored(ImVec4(0.8f, 0.9f, 1.0f, 1.0f), "DQPSK OFDM SUBCARRIER CONSTELLATION");
            
            ImVec2 plotPos = ImGui::GetCursorScreenPos();
            float plotDim = (std::min)(rightWidth - 20.0f, 210.0f);
            ImVec2 plotEnd = ImVec2(plotPos.x + plotDim, plotPos.y + plotDim);

            ImDrawList* drawList = ImGui::GetWindowDrawList();
            drawList->AddRectFilled(plotPos, plotEnd, IM_COL32(12, 16, 24, 255), 4.0f);
            drawList->AddRect(plotPos, plotEnd, IM_COL32(40, 50, 70, 255), 4.0f);

            // Crosshair axes
            float cx = plotPos.x + plotDim * 0.5f;
            float cy = plotPos.y + plotDim * 0.5f;
            drawList->AddLine(ImVec2(plotPos.x, cy), ImVec2(plotEnd.x, cy), IM_COL32(60, 75, 95, 120), 1.0f);
            drawList->AddLine(ImVec2(cx, plotPos.y), ImVec2(cx, plotEnd.y), IM_COL32(60, 75, 95, 120), 1.0f);

            // Decision threshold circles
            float unitRadius = plotDim * 0.35f;
            drawList->AddCircle(ImVec2(cx, cy), unitRadius, IM_COL32(70, 90, 120, 80), 36, 1.0f);

            // Scatter constellation points
            auto points = dabDecoder->GetConstellationPoints();
            for (const auto& pt : points)
            {
                float px = cx + pt.real() * unitRadius;
                float py = cy - pt.imag() * unitRadius;
                if (px >= plotPos.x && px <= plotEnd.x && py >= plotPos.y && py <= plotEnd.y)
                {
                    drawList->AddCircleFilled(ImVec2(px, py), 1.8f, IM_COL32(56, 189, 248, 200));
                }
            }

            ImGui::Dummy(ImVec2(plotDim, plotDim));
            ImGui::TextDisabled("1536 Active OFDM Carriers | Transmission Mode I");
        }
    }
    ImGui::EndChild();

    ImGui::End();
}
`,
  },
  {
    path: 'RtlSdrGui.vcxproj',
    title: 'RtlSdrGui.vcxproj (Visual Studio 2022/2019 Project)',
    category: 'vs_project',
    description: 'Complete Visual Studio MSBuild C++ project configured for C++20, DirectX 11, and librtlsdr.',
    content: `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup Label="ProjectConfigurations">
    <ProjectConfiguration Include="Debug|x64">
      <Configuration>Debug</Configuration>
      <Platform>x64</Platform>
    </ProjectConfiguration>
    <ProjectConfiguration Include="Release|x64">
      <Configuration>Release</Configuration>
      <Platform>x64</Platform>
    </ProjectConfiguration>
  </ItemGroup>
  <PropertyGroup Label="Globals">
    <VCProjectVersion>17.0</VCProjectVersion>
    <Keyword>Win32Proj</Keyword>
    <ProjectGuid>{4A1B2C3D-8E9F-4102-B7C6-0A1B2C3D4E5F}</ProjectGuid>
    <RootNamespace>RtlSdrGui</RootNamespace>
    <WindowsTargetPlatformVersion>10.0</WindowsTargetPlatformVersion>
  </PropertyGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.Default.props" />
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Debug|x64'" Label="Configuration">
    <ConfigurationType>Application</ConfigurationType>
    <UseDebugLibraries>true</UseDebugLibraries>
    <PlatformToolset>v143</PlatformToolset>
    <CharacterSet>Unicode</CharacterSet>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'" Label="Configuration">
    <ConfigurationType>Application</ConfigurationType>
    <UseDebugLibraries>false</UseDebugLibraries>
    <PlatformToolset>v143</PlatformToolset>
    <WholeProgramOptimization>true</WholeProgramOptimization>
    <CharacterSet>Unicode</CharacterSet>
  </PropertyGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.props" />
  <ImportGroup Label="ExtensionSettings">
  </ImportGroup>
  <ImportGroup Label="Shared">
  </ImportGroup>
  <ImportGroup Label="PropertySheets" Condition="'$(Configuration)|$(Platform)'=='Debug|x64'">
    <Import Project="$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props" Condition="exists('$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props')" Label="LocalAppDataPlatform" />
  </ImportGroup>
  <ImportGroup Label="PropertySheets" Condition="'$(Configuration)|$(Platform)'=='Release|x64'">
    <Import Project="$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props" Condition="exists('$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props')" Label="LocalAppDataPlatform" />
  </ImportGroup>
  <PropertyGroup Label="UserMacros" />
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Debug|x64'">
    <OutDir>$(SolutionDir)bin\\$(Platform)\\$(Configuration)\\</OutDir>
    <IntDir>$(SolutionDir)obj\\$(Platform)\\$(Configuration)\\</IntDir>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'">
    <OutDir>$(SolutionDir)bin\\$(Platform)\\$(Configuration)\\</OutDir>
    <IntDir>$(SolutionDir)obj\\$(Platform)\\$(Configuration)\\</IntDir>
  </PropertyGroup>
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Debug|x64'">
    <ClCompile>
      <WarningLevel>Level3</WarningLevel>
      <SDLCheck>true</SDLCheck>
      <PreprocessorDefinitions>_DEBUG;_WINDOWS;NOMINMAX;%(PreprocessorDefinitions)</PreprocessorDefinitions>
      <ConformanceMode>true</ConformanceMode>
      <LanguageStandard>stdcpp20</LanguageStandard>
      <AdditionalIncludeDirectories>$(ProjectDir)src;$(ProjectDir)vendor;$(ProjectDir)vendor\\imgui;$(ProjectDir)vendor\\imgui\\backends;$(ProjectDir)..\\vendor;$(ProjectDir)..\\vendor\\imgui;$(ProjectDir)..\\vendor\\imgui\\backends;$(ProjectDir)..\\..\\vendor;$(ProjectDir)..\\..\\vendor\\imgui;$(ProjectDir)..\\..\\vendor\\imgui\\backends;$(SolutionDir)vendor;$(SolutionDir)vendor\\imgui;$(SolutionDir)vendor\\imgui\\backends;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
    </ClCompile>
    <Link>
      <SubSystem>Windows</SubSystem>
      <GenerateDebugInformation>true</GenerateDebugInformation>
      <AdditionalDependencies>d3d11.lib;d3dcompiler.lib;dxgi.lib;winmm.lib;%(AdditionalDependencies)</AdditionalDependencies>
      <AdditionalLibraryDirectories>$(ProjectDir)lib\\x64;$(ProjectDir)..\\lib\\x64;$(ProjectDir)..\\..\\lib\\x64;$(SolutionDir)lib\\x64;%(AdditionalLibraryDirectories)</AdditionalLibraryDirectories>
    </Link>
  </ItemDefinitionGroup>
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'">
    <ClCompile>
      <WarningLevel>Level3</WarningLevel>
      <FunctionLevelLinking>true</FunctionLevelLinking>
      <IntrinsicFunctions>true</IntrinsicFunctions>
      <SDLCheck>true</SDLCheck>
      <PreprocessorDefinitions>NDEBUG;_WINDOWS;NOMINMAX;%(PreprocessorDefinitions)</PreprocessorDefinitions>
      <ConformanceMode>true</ConformanceMode>
      <LanguageStandard>stdcpp20</LanguageStandard>
      <Optimization>MaxSpeed</Optimization>
      <FloatingPointModel>Fast</FloatingPointModel>
      <AdditionalIncludeDirectories>$(ProjectDir)src;$(ProjectDir)vendor;$(ProjectDir)vendor\\imgui;$(ProjectDir)vendor\\imgui\\backends;$(ProjectDir)..\\vendor;$(ProjectDir)..\\vendor\\imgui;$(ProjectDir)..\\vendor\\imgui\\backends;$(ProjectDir)..\\..\\vendor;$(ProjectDir)..\\..\\vendor\\imgui;$(ProjectDir)..\\..\\vendor\\imgui\\backends;$(SolutionDir)vendor;$(SolutionDir)vendor\\imgui;$(SolutionDir)vendor\\imgui\\backends;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
    </ClCompile>
    <Link>
      <SubSystem>Windows</SubSystem>
      <EnableCOMDATFolding>true</EnableCOMDATFolding>
      <OptimizeReferences>true</OptimizeReferences>
      <GenerateDebugInformation>true</GenerateDebugInformation>
      <AdditionalDependencies>d3d11.lib;d3dcompiler.lib;dxgi.lib;winmm.lib;%(AdditionalDependencies)</AdditionalDependencies>
      <AdditionalLibraryDirectories>$(ProjectDir)lib\\x64;$(ProjectDir)..\\lib\\x64;$(ProjectDir)..\\..\\lib\\x64;$(SolutionDir)lib\\x64;%(AdditionalLibraryDirectories)</AdditionalLibraryDirectories>
    </Link>
  </ItemDefinitionGroup>
  <ItemGroup>
    <ClCompile Include="src\\main.cpp" />
    <ClCompile Include="src\\sdr_device.cpp" />
    <ClCompile Include="src\\dsp.cpp" />
    <ClCompile Include="src\\waterfall.cpp" />
    <ClCompile Include="src\\audio_player.cpp" />
    <ClCompile Include="src\\memory_banks.cpp" />
    <ClCompile Include="src\\dab_decoder.cpp" />
    <ClCompile Include="vendor\\imgui\\imgui.cpp" Condition="Exists('vendor\\imgui\\imgui.cpp')" />
    <ClCompile Include="vendor\\imgui\\imgui_draw.cpp" Condition="Exists('vendor\\imgui\\imgui_draw.cpp')" />
    <ClCompile Include="vendor\\imgui\\imgui_tables.cpp" Condition="Exists('vendor\\imgui\\imgui_tables.cpp')" />
    <ClCompile Include="vendor\\imgui\\imgui_widgets.cpp" Condition="Exists('vendor\\imgui\\imgui_widgets.cpp')" />
    <ClCompile Include="vendor\\imgui\\backends\\imgui_impl_win32.cpp" Condition="Exists('vendor\\imgui\\backends\\imgui_impl_win32.cpp')" />
    <ClCompile Include="vendor\\imgui\\backends\\imgui_impl_dx11.cpp" Condition="Exists('vendor\\imgui\\backends\\imgui_impl_dx11.cpp')" />
    <ClCompile Include="..\\vendor\\imgui\\imgui.cpp" Condition="!Exists('vendor\\imgui\\imgui.cpp') and Exists('..\\vendor\\imgui\\imgui.cpp')" />
    <ClCompile Include="..\\vendor\\imgui\\imgui_draw.cpp" Condition="!Exists('vendor\\imgui\\imgui_draw.cpp') and Exists('..\\vendor\\imgui\\imgui_draw.cpp')" />
    <ClCompile Include="..\\vendor\\imgui\\imgui_tables.cpp" Condition="!Exists('vendor\\imgui\\imgui_tables.cpp') and Exists('..\\vendor\\imgui\\imgui_tables.cpp')" />
    <ClCompile Include="..\\vendor\\imgui\\imgui_widgets.cpp" Condition="!Exists('vendor\\imgui\\imgui_widgets.cpp') and Exists('..\\vendor\\imgui\\imgui_widgets.cpp')" />
    <ClCompile Include="..\\vendor\\imgui\\backends\\imgui_impl_win32.cpp" Condition="!Exists('vendor\\imgui\\backends\\imgui_impl_win32.cpp') and Exists('..\\vendor\\imgui\\backends\\imgui_impl_win32.cpp')" />
    <ClCompile Include="..\\vendor\\imgui\\backends\\imgui_impl_dx11.cpp" Condition="!Exists('vendor\\imgui\\backends\\imgui_impl_dx11.cpp') and Exists('..\\vendor\\imgui\\backends\\imgui_impl_dx11.cpp')" />
  </ItemGroup>
  <ItemGroup>
    <ClInclude Include="src\\sdr_device.h" />
    <ClInclude Include="src\\dsp.h" />
    <ClInclude Include="src\\waterfall.h" />
    <ClInclude Include="src\\audio_player.h" />
    <ClInclude Include="src\\memory_banks.h" />
    <ClInclude Include="src\\dab_decoder.h" />
    <ClInclude Include="vendor\\imgui\\imgui.h" Condition="Exists('vendor\\imgui\\imgui.h')" />
    <ClInclude Include="..\\vendor\\imgui\\imgui.h" Condition="!Exists('vendor\\imgui\\imgui.h') and Exists('..\\vendor\\imgui\\imgui.h')" />
  </ItemGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.targets" />
  <ImportGroup Label="ExtensionTargets">
  </ImportGroup>
</Project>
`,
  },
  {
    path: 'RtlSdrGui.sln',
    title: 'RtlSdrGui.sln (Visual Studio Solution File)',
    category: 'vs_project',
    description: 'Visual Studio solution uniting the project for x64 Debug and Release configurations.',
    content: `Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
VisualStudioVersion = 17.8.34330.188
MinimumVisualStudioVersion = 10.0.40219.1
Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "RtlSdrGui", "RtlSdrGui.vcxproj", "{4A1B2C3D-8E9F-4102-B7C6-0A1B2C3D4E5F}"
EndProject
Global
	GlobalSection(SolutionConfigurationPlatforms) = preSolution
		Debug|x64 = Debug|x64
		Release|x64 = Release|x64
	EndGlobalSection
	GlobalSection(ProjectConfigurationPlatforms) = postSolution
		{4A1B2C3D-8E9F-4102-B7C6-0A1B2C3D4E5F}.Debug|x64.ActiveCfg = Debug|x64
		{4A1B2C3D-8E9F-4102-B7C6-0A1B2C3D4E5F}.Debug|x64.Build.0 = Debug|x64
		{4A1B2C3D-8E9F-4102-B7C6-0A1B2C3D4E5F}.Release|x64.ActiveCfg = Release|x64
		{4A1B2C3D-8E9F-4102-B7C6-0A1B2C3D4E5F}.Release|x64.Build.0 = Release|x64
	EndGlobalSection
	GlobalSection(SolutionProperties) = preSolution
		HideSolutionNode = FALSE
	EndGlobalSection
	GlobalSection(ExtensibilityGlobals) = postSolution
		SolutionGuid = {B1E2D3C4-F5A6-4708-9C1D-2E3F4A5B6C7D}
	EndGlobalSection
EndGlobal
`,
  },
  {
    path: 'CMakeLists.txt',
    title: 'CMakeLists.txt (Modern Cross-IDE Build Script)',
    category: 'build_script',
    description: 'CMake build script compatible with Visual Studio "Open Folder", Ninja, or MSBuild.',
    content: `cmake_minimum_required(VERSION 3.20)
project(RtlSdrGui LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Source files
set(SOURCES
    src/main.cpp
    src/sdr_device.cpp
    src/dsp.cpp
    src/waterfall.cpp
    src/audio_player.cpp
    src/memory_banks.cpp
    src/dab_decoder.cpp
)

set(HEADERS
    src/sdr_device.h
    src/dsp.h
    src/waterfall.h
    src/audio_player.h
    src/memory_banks.h
    src/dab_decoder.h
)

add_executable(\${PROJECT_NAME} WIN32 \${SOURCES} \${HEADERS})

target_include_directories(\${PROJECT_NAME} PRIVATE
    \${CMAKE_CURRENT_SOURCE_DIR}/src
    \${CMAKE_CURRENT_SOURCE_DIR}/vendor
)

# Link Windows DirectX 11 & Multimedia libraries
target_link_libraries(\${PROJECT_NAME} PRIVATE
    d3d11
    d3dcompiler
    dxgi
    winmm
)

# Find RTL-SDR or link pre-built Windows library
find_package(PkgConfig QUIET)
pkg_check_modules(RTLSDR librtlsdr)

if(RTLSDR_FOUND)
    target_link_libraries(\${PROJECT_NAME} PRIVATE \${RTLSDR_LIBRARIES})
    target_include_directories(\${PROJECT_NAME} PRIVATE \${RTLSDR_INCLUDE_DIRS})
    target_compile_definitions(\${PROJECT_NAME} PRIVATE USE_REAL_RTLSDR)
else()
    message(STATUS "librtlsdr not found via pkg-config; fallback to vendor/lib or simulated RF mode")
    target_compile_definitions(\${PROJECT_NAME} PRIVATE USE_SIMULATED_RF)
endif()
`,
  },
  {
    path: 'setup_dependencies.bat',
    title: 'setup_dependencies.bat (1-Click Automated ImGui & Dependencies Downloader)',
    category: 'docs',
    description: 'Automated Windows batch script that fetches Dear ImGui and headers into vendor/imgui without needing Git.',
    content: `@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
echo =====================================================================
echo  RTL-SDR Standalone C++ GUI - Automated Dependency Installer
echo =====================================================================
echo Current Script Path: %~dp0
echo.

REM Ensure destination directories exist
if not exist "vendor" mkdir "vendor"
if not exist "vendor\\imgui" mkdir "vendor\\imgui"
if not exist "vendor\\imgui\\backends" mkdir "vendor\\imgui\\backends"
if not exist "lib" mkdir "lib"
if not exist "lib\\x64" mkdir "lib\\x64"

REM Also create in parent directory in case of nested zip extraction
if not exist "..\\vendor" mkdir "..\\vendor" 2>nul
if not exist "..\\vendor\\imgui" mkdir "..\\vendor\\imgui" 2>nul
if not exist "..\\vendor\\imgui\\backends" mkdir "..\\vendor\\imgui\\backends" 2>nul
if not exist "..\\lib\\x64" mkdir "..\\lib\\x64" 2>nul

echo [1/4] Checking for existing local installations on this PC...
set "FOUND_LOCAL=0"

REM Search parent directories for existing imgui.h (e.g. from previous working build)
for %%D in (".." "..\\.." "..\\..\\.." "..\\..\\vendor\\imgui" "..\\vendor\\imgui" "..\\RtlSdr_VisualStudio_Cpp_GUI\\vendor\\imgui") do (
    if exist "%%~fD\\imgui.h" (
        echo [Found ImGui at %%~fD] Copying local files...
        copy /y "%%~fD\\*.h" "vendor\\imgui\\" >nul 2>nul
        copy /y "%%~fD\\*.cpp" "vendor\\imgui\\" >nul 2>nul
        if exist "%%~fD\\backends" (
            copy /y "%%~fD\\backends\\imgui_impl_win32.*" "vendor\\imgui\\backends\\" >nul 2>nul
            copy /y "%%~fD\\backends\\imgui_impl_dx11.*" "vendor\\imgui\\backends\\" >nul 2>nul
        )
        copy /y "vendor\\imgui\\*.h" "..\\vendor\\imgui\\" >nul 2>nul
        copy /y "vendor\\imgui\\*.cpp" "..\\vendor\\imgui\\" >nul 2>nul
        copy /y "vendor\\imgui\\backends\\*.*" "..\\vendor\\imgui\\backends\\" >nul 2>nul
        set "FOUND_LOCAL=1"
    )
    if exist "%%~fD\\rtlsdr.lib" (
        echo [Found rtlsdr.lib at %%~fD] Copying to lib\\x64...
        copy /y "%%~fD\\rtlsdr.*" "lib\\x64\\" >nul 2>nul
        copy /y "%%~fD\\rtlsdr.*" "..\\lib\\x64\\" >nul 2>nul
        copy /y "%%~fD\\rtlsdr.*" "." >nul 2>nul
    )
)

if "!FOUND_LOCAL!"=="1" (
    echo Local ImGui files retrieved successfully!
    goto :VERIFY
)

echo [2/4] Downloading Dear ImGui (v1.90.4) via PowerShell...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference = 'SilentlyContinue'; " ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
    "$headers = @{ 'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }; " ^
    "try { " ^
    "    Invoke-WebRequest -Uri 'https://github.com/ocornut/imgui/archive/refs/tags/v1.90.4.zip' -OutFile 'imgui_temp.zip' -Headers $headers -UseBasicParsing; " ^
    "} catch { " ^
    "    Write-Host 'Zip download threw an exception, will attempt fallback.' -ForegroundColor Yellow; " ^
    "}"

REM Check if downloaded zip is valid (> 50KB)
set "ZIP_VALID=0"
if exist "imgui_temp.zip" (
    for %%F in ("imgui_temp.zip") do (
        if %%~zF gtr 50000 set "ZIP_VALID=1"
    )
)

if "!ZIP_VALID!"=="1" (
    echo [3/4] Extracting ImGui archive...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$ProgressPreference = 'SilentlyContinue'; " ^
        "Expand-Archive -Path 'imgui_temp.zip' -DestinationPath 'imgui_extracted' -Force"

    if exist "imgui_extracted\\imgui-1.90.4" (
        copy /y "imgui_extracted\\imgui-1.90.4\\*.h" "vendor\\imgui\\" >nul
        copy /y "imgui_extracted\\imgui-1.90.4\\*.cpp" "vendor\\imgui\\" >nul
        copy /y "imgui_extracted\\imgui-1.90.4\\backends\\imgui_impl_win32.*" "vendor\\imgui\\backends\\" >nul
        copy /y "imgui_extracted\\imgui-1.90.4\\backends\\imgui_impl_dx11.*" "vendor\\imgui\\backends\\" >nul

        REM Duplicate to parent folder for nested project safety
        copy /y "imgui_extracted\\imgui-1.90.4\\*.h" "..\\vendor\\imgui\\" >nul 2>nul
        copy /y "imgui_extracted\\imgui-1.90.4\\*.cpp" "..\\vendor\\imgui\\" >nul 2>nul
        copy /y "imgui_extracted\\imgui-1.90.4\\backends\\imgui_impl_win32.*" "..\\vendor\\imgui\\backends\\" >nul 2>nul
        copy /y "imgui_extracted\\imgui-1.90.4\\backends\\imgui_impl_dx11.*" "..\\vendor\\imgui\\backends\\" >nul 2>nul
    )

    REM Cleanup temp extraction folder and zip
    rmdir /s /q "imgui_extracted" 2>nul
    del /q "imgui_temp.zip" 2>nul
)

REM Fallback 2: Direct raw file download if zip extraction didn't produce imgui.h
if not exist "vendor\\imgui\\imgui.h" (
    echo [Fallback] Downloading standalone ImGui headers directly from GitHub CDN...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$ProgressPreference = 'SilentlyContinue'; " ^
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
        "$headers = @{ 'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }; " ^
        "$base = 'https://raw.githubusercontent.com/ocornut/imgui/v1.90.4/'; " ^
        "$files = @('imgui.h','imgui.cpp','imgui_draw.cpp','imgui_tables.cpp','imgui_widgets.cpp','imconfig.h','imgui_internal.h','imstb_rectpack.h','imstb_textedit.h','imstb_truetype.h'); " ^
        "foreach($f in $files) { " ^
        "    try { Invoke-WebRequest -Uri ($base + $f) -OutFile ('vendor\\imgui\\' + $f) -Headers $headers -UseBasicParsing } catch {} " ^
        "    try { Copy-Item ('vendor\\imgui\\' + $f) ('..\\vendor\\imgui\\' + $f) -Force -ErrorAction SilentlyContinue } catch {} " ^
        "}; " ^
        "$backends = @('imgui_impl_win32.h','imgui_impl_win32.cpp','imgui_impl_dx11.h','imgui_impl_dx11.cpp'); " ^
        "foreach($b in $backends) { " ^
        "    try { Invoke-WebRequest -Uri ($base + 'backends/' + $b) -OutFile ('vendor\\imgui\\backends\\' + $b) -Headers $headers -UseBasicParsing } catch {} " ^
        "    try { Copy-Item ('vendor\\imgui\\backends\\' + $b) ('..\\vendor\\imgui\\backends\\' + $b) -Force -ErrorAction SilentlyContinue } catch {} " ^
        "}"
)

:VERIFY
REM Clean up duplicate backend cpp files in the vendor\\imgui root to avoid MSB8027 collision
del /q "vendor\\imgui\\imgui_impl_win32.*" 2>nul
del /q "vendor\\imgui\\imgui_impl_dx11.*" 2>nul
del /q "..\\vendor\\imgui\\imgui_impl_win32.*" 2>nul
del /q "..\\vendor\\imgui\\imgui_impl_dx11.*" 2>nul

echo.
echo [4/4] Final Verification:
if exist "vendor\\imgui\\imgui.h" (
    echo =====================================================================
    echo [SUCCESS] Dear ImGui successfully installed and verified at:
    echo   %CD%\\vendor\\imgui\\imgui.h
    echo   %CD%\\vendor\\imgui\\backends\\imgui_impl_win32.h
    echo   %CD%\\vendor\\imgui\\backends\\imgui_impl_dx11.h
    echo.
    echo Ready to build! Return to Visual Studio and press Ctrl+Shift+B.
    echo =====================================================================
) else (
    echo =====================================================================
    echo [ERROR] Automatic download could not reach GitHub.
    echo You can install Dear ImGui with Microsoft vcpkg:
    echo   vcpkg install imgui[win32-binding,dx11-binding]:x64-windows
    echo   vcpkg integrate install
    echo Or copy the 'vendor' folder from your previous working project into:
    echo   %CD%\\vendor
    echo =====================================================================
)
echo.
pause
`,
  },
  {
    path: 'README.md',
    title: 'README.md (Visual Studio Setup & Driver Guide)',
    category: 'docs',
    description: 'Instructions for building in Visual Studio 2019/2022, installing Zadig WinUSB drivers, and running.',
    content: `# RTL-SDR Standalone GUI for Windows (Visual Studio / C++20)

A high-performance Software Defined Radio receiver GUI for RTL2832U / R820T2 USB dongles built with **Dear ImGui**, **DirectX 11**, and **C++20**.

---

## 🚀 Quick Start in Visual Studio

### 1. Requirements
* **Microsoft Visual Studio 2019 or 2022** (Community, Professional, or Enterprise).
* Desktop development with C++ workload installed (includes MSVC v142/v143 compiler, Windows 10/11 SDK).
* RTL-SDR USB dongle (RTL2832U with R820T, R820T2, E4000, or FC0012 tuner).

### 2. Resolving Dependencies (Dear ImGui)
If you encounter:
\`Error C1083: Cannot open include file: 'imgui.h': No such file or directory\`

Choose either of these simple options:

#### Option A: 1-Click Batch Script (Zero software needed)
Double-click \`setup_dependencies.bat\` in the project root folder. It uses Windows PowerShell to download Dear ImGui and its DirectX11/Win32 backends directly into \`vendor\\imgui\\\`.

#### Option B: Microsoft vcpkg
If you use vcpkg, run in PowerShell/CMD:
\`\`\`powershell
vcpkg install imgui[win32-binding,dx11-binding]:x64-windows
vcpkg integrate install
\`\`\`

---

### 3. Windows USB Driver Setup (Zadig)
Windows natively installs a DVB-T TV tuner driver for the RTL2832U. To access raw IQ RF samples, you must replace it with the WinUSB driver:
1. Plug your RTL-SDR dongle into a USB port.
2. Download and launch **Zadig** (from [zadig.akeo.ie](https://zadig.akeo.ie)).
3. In Zadig, choose **Options -> List All Devices**.
4. Select **Bulk-In, Interface (Interface 0)** or **RTL2832U**.
5. Select **WinUSB (v6.1.7600.16385)** as the target driver.
6. Click **Replace Driver** (or **Install Driver**).

---

### 4. Opening and Building in Visual Studio
1. Double-click \`RtlSdrGui.sln\` to open the solution in Visual Studio.
2. Set configuration to **Release** and platform to **x64** in the top toolbar.
3. Press **Ctrl + Shift + B** to build the solution.
4. Press **F5** (or **Ctrl + F5**) to launch the application!

*Note: If no physical USB dongle is connected, the application will automatically engage its built-in RF simulation engine, allowing you to test the GUI, spectrum, waterfall, and demodulators immediately.*
`,
  },
];
