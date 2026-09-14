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

// Forward declare message handler from imgui_impl_win32.cpp
extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam);

// Global DirectX 11 State
static ID3D11Device*           g_pd3dDevice = nullptr;
static ID3D11DeviceContext*     g_pd3dDeviceContext = nullptr;
static IDXGISwapChain*          g_pSwapChain = nullptr;
static ID3D11RenderTargetView*  g_mainRenderTargetView = nullptr;

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

    audio->Initialize(48000, 2);

    // Initial Hardware & DSP default configuration
    uint32_t currentFreqHz = 101100000; // 101.1 MHz WBFM Broadcast
    uint32_t sampleRateHz  = 2048000;   // 2.048 MSPS standard for RTL2832U
    int tunerGainIndex     = 20;        // ~32.8 dB
    bool rtlAgc            = false;
    bool tunerAgc          = false;
    int demodModeIndex     = 0;         // 0: WBFM, 1: NBFM, 2: AM, 3: USB, 4: LSB, 5: CW
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

                // Run Demodulator with adjustable filter bandwidth and sample rate
                std::vector<float> audioSamples = dsp->Demodulate(iqSamples, static_cast<DemodMode>(demodModeIndex), squelchDb, bandwidthHz, sampleRateHz);
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
            if (ImGui::Button("Memory Banks", ImVec2(120, 30))) {
                bShowMemoryBanks = !bShowMemoryBanks;
            }

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
        float sidebarWidth = 370.0f;
        if (totalWidth < 800.0f) sidebarWidth = totalWidth * 0.45f;
        float mainDisplayWidth = totalWidth - sidebarWidth - 10.0f;

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
                if (ImGui::BeginTabItem("Tuning & Keypad"))
                {
                    ImGui::Spacing();
                    ImGui::TextColored(ImVec4(0.4f, 0.8f, 1.0f, 1.0f), "DIRECT FREQUENCY KEYPAD");

                    // Direct input display
                    ImGui::PushStyleColor(ImGuiCol_FrameBg, ImVec4(0.04f, 0.07f, 0.12f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.3f, 0.95f, 0.6f, 1.0f));
                    ImGui::SetNextItemWidth(sidebarWidth - 25.0f);
                    if (ImGui::InputText("##DirectFreqText", keypadBuffer, sizeof(keypadBuffer), ImGuiInputTextFlags_EnterReturnsTrue))
                    {
                        double val = atof(keypadBuffer);
                        if (val > 0.0) {
                            if (val < 2500.0) currentFreqHz = static_cast<uint32_t>(val * 1e6); // e.g. 101.1 -> 101.1 MHz
                            else currentFreqHz = static_cast<uint32_t>(val);
                            sdr->SetCenterFrequency(currentFreqHz);
                            keypadBuffer[0] = '\0';
                        }
                    }
                    ImGui::PopStyleColor(2);

                    // 3x4 Keypad Grid
                    const float btnW = (sidebarWidth - 45.0f) / 3.0f;
                    const float btnH = 34.0f;
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
                            if (ImGui::Button(lbl, ImVec2(btnW, btnH)))
                            {
                                if (strcmp(lbl, "CLR") == 0) {
                                    keypadBuffer[0] = '\0';
                                } else {
                                    size_t len = strlen(keypadBuffer);
                                    if (len < sizeof(keypadBuffer) - 2) {
                                        keypadBuffer[len] = lbl[0];
                                        keypadBuffer[len + 1] = '\0';
                                    }
                                }
                            }
                        }
                    }

                    // TUNE / ENTER BUTTON
                    ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.15f, 0.45f, 0.85f, 1.0f));
                    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.25f, 0.55f, 0.95f, 1.0f));
                    if (ImGui::Button(" [ TUNE FREQUENCY (ENTER) ] ", ImVec2(sidebarWidth - 25.0f, 38.0f)))
                    {
                        double val = atof(keypadBuffer);
                        if (val > 0.0) {
                            if (val < 2500.0) currentFreqHz = static_cast<uint32_t>(val * 1e6);
                            else currentFreqHz = static_cast<uint32_t>(val);
                            sdr->SetCenterFrequency(currentFreqHz);
                            keypadBuffer[0] = '\0';
                        }
                    }
                    ImGui::PopStyleColor(2);

                    ImGui::Separator();
                    ImGui::TextColored(ImVec4(0.4f, 0.8f, 1.0f, 1.0f), "FREQUENCY STEPPING");

                    // Step buttons
                    const float stepBtnW = (sidebarWidth - 40.0f) / 2.0f;
                    if (ImGui::Button("-1.0 MHz", ImVec2(stepBtnW, 28))) {
                        if (currentFreqHz >= 1000000) currentFreqHz -= 1000000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::SameLine();
                    if (ImGui::Button("+1.0 MHz", ImVec2(stepBtnW, 28))) {
                        currentFreqHz += 1000000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }

                    if (ImGui::Button("-100 kHz", ImVec2(stepBtnW, 28))) {
                        if (currentFreqHz >= 100000) currentFreqHz -= 100000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::SameLine();
                    if (ImGui::Button("+100 kHz", ImVec2(stepBtnW, 28))) {
                        currentFreqHz += 100000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }

                    if (ImGui::Button("-10 kHz", ImVec2(stepBtnW, 28))) {
                        if (currentFreqHz >= 10000) currentFreqHz -= 10000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::SameLine();
                    if (ImGui::Button("+10 kHz", ImVec2(stepBtnW, 28))) {
                        currentFreqHz += 10000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }

                    if (ImGui::Button("-1 kHz", ImVec2(stepBtnW, 28))) {
                        if (currentFreqHz >= 1000) currentFreqHz -= 1000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }
                    ImGui::SameLine();
                    if (ImGui::Button("+1 kHz", ImVec2(stepBtnW, 28))) {
                        currentFreqHz += 1000;
                        sdr->SetCenterFrequency(currentFreqHz);
                    }

                    ImGui::Separator();
                    ImGui::Text("Rotary Dial Tuning:");
                    DrawTuningDial("##SidebarRotaryDial", currentFreqHz, sdr.get());

                    ImGui::EndTabItem();
                }

                // ------------------------------------------------------------
                // TAB B: DEMODULATION & BANDWIDTH
                // ------------------------------------------------------------
                if (ImGui::BeginTabItem("Demod & Bandwidth"))
                {
                    ImGui::Spacing();
                    ImGui::TextColored(ImVec4(0.4f, 0.8f, 1.0f, 1.0f), "DEMODULATION MODE");

                    const char* modes[] = { "WBFM (Broadcast FM)", "NBFM (Ham / Marine)", "AM (Air / SW)", "USB (Upper SSB)", "LSB (Lower SSB)", "CW (Morse)" };
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
                    if (ImGui::Button("180 kHz (WBFM)", ImVec2(bwBtnW, 26))) bandwidthHz = 180000;
                    ImGui::SameLine();
                    if (ImGui::Button("150 kHz (FM)", ImVec2(bwBtnW, 26)))   bandwidthHz = 150000;
                    ImGui::SameLine();
                    if (ImGui::Button("25 kHz (NFM)", ImVec2(bwBtnW, 26)))    bandwidthHz = 25000;

                    if (ImGui::Button("12.5k (NFM)", ImVec2(bwBtnW, 26)))    bandwidthHz = 12500;
                    ImGui::SameLine();
                    if (ImGui::Button("9 kHz (AM)", ImVec2(bwBtnW, 26)))     bandwidthHz = 9000;
                    ImGui::SameLine();
                    if (ImGui::Button("6 kHz (AM)", ImVec2(bwBtnW, 26)))     bandwidthHz = 6000;

                    if (ImGui::Button("2.8k (SSB)", ImVec2(bwBtnW, 26)))     bandwidthHz = 2800;
                    ImGui::SameLine();
                    if (ImGui::Button("1.8k (SSB)", ImVec2(bwBtnW, 26)))     bandwidthHz = 1800;
                    ImGui::SameLine();
                    if (ImGui::Button("500 Hz (CW)", ImVec2(bwBtnW, 26)))    bandwidthHz = 500;

                    ImGui::Spacing();
                    ImGui::Separator();
                    ImGui::TextColored(ImVec4(0.4f, 0.8f, 1.0f, 1.0f), "AUDIO & SQUELCH");

                    ImGui::SliderFloat("Volume", &audioVolume, 0.0f, 1.0f, "%.2f");
                    ImGui::SliderFloat("Squelch Threshold", &squelchDb, -100.0f, -10.0f, "%.1f dBFS");
                    ImGui::Checkbox("Audio Mute", &isAudioMuted);

                    ImGui::Spacing();
                    ImGui::Separator();
                    ImGui::TextColored(ImVec4(0.4f, 0.8f, 1.0f, 1.0f), "BROADCAST PRESETS");
                    if (ImGui::Button("FM Broadcast: 101.100 MHz", ImVec2(sidebarWidth - 25.0f, 26))) {
                        currentFreqHz = 101100000; demodModeIndex = 0; bandwidthHz = 180000; sdr->SetCenterFrequency(currentFreqHz);
                    }
                    if (ImGui::Button("FM Broadcast: 88.500 MHz", ImVec2(sidebarWidth - 25.0f, 26))) {
                        currentFreqHz = 88500000; demodModeIndex = 0; bandwidthHz = 180000; sdr->SetCenterFrequency(currentFreqHz);
                    }
                    if (ImGui::Button("NOAA Weather: 162.550 MHz", ImVec2(sidebarWidth - 25.0f, 26))) {
                        currentFreqHz = 162550000; demodModeIndex = 1; bandwidthHz = 12500; sdr->SetCenterFrequency(currentFreqHz);
                    }
                    if (ImGui::Button("Airband Tower: 118.700 MHz", ImVec2(sidebarWidth - 25.0f, 26))) {
                        currentFreqHz = 118700000; demodModeIndex = 2; bandwidthHz = 9000; sdr->SetCenterFrequency(currentFreqHz);
                    }
                    if (ImGui::Button("2m Ham Simplex: 146.520 MHz", ImVec2(sidebarWidth - 25.0f, 26))) {
                        currentFreqHz = 146520000; demodModeIndex = 1; bandwidthHz = 12500; sdr->SetCenterFrequency(currentFreqHz);
                    }

                    ImGui::EndTabItem();
                }

                // ------------------------------------------------------------
                // TAB C: HARDWARE & SDR SETTINGS
                // ------------------------------------------------------------
                if (ImGui::BeginTabItem("Hardware & SDR"))
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
                if (ImGui::BeginTabItem("Display & Themes"))
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
            uint32_t retunedFreq = currentFreqHz;
            bool didRetune = waterfall->Render(
                mainDisplayWidth - 16.0f,
                totalHeight - 20.0f,
                currentFreqHz,
                sampleRateHz,
                currentFreqHz,
                bandwidthHz,
                retunedFreq
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

        // Rendering DirectX Frame
        ImGui::Render();
        const float clear_color_with_alpha[4] = { 0.05f, 0.06f, 0.08f, 1.0f };
        g_pd3dDeviceContext->OMSetRenderTargets(1, &g_mainRenderTargetView, nullptr);
        g_pd3dDeviceContext->ClearRenderTargetView(g_mainRenderTargetView, clear_color_with_alpha);
        ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());
        g_pSwapChain->Present(1, 0); // VSync enabled
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
    if (g_mainRenderTargetView) { g_mainRenderTargetView->Release(); g_mainRenderTargetView = nullptr; }
}

LRESULT WINAPI WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    if (ImGui_ImplWin32_WndProcHandler(hWnd, msg, wParam, lParam))
        return true;

    switch (msg)
    {
    case WM_SIZE:
        if (g_pd3dDevice != nullptr && wParam != SIZE_MINIMIZED)
        {
            CleanupRenderTarget();
            g_pSwapChain->ResizeBuffers(0, (UINT)LOWORD(lParam), (UINT)HIWORD(lParam), DXGI_FORMAT_UNKNOWN, 0);
            CreateRenderTarget();
        }
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
    CW   = 5
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
                uint32_t& outTunedFreqHz);
    
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

    // Render new top row with colormap
    for (uint32_t x = 0; x < m_width; ++x)
    {
        float db = (x < fftDbfs.size()) ? fftDbfs[x] : -120.0f;
        float norm = std::clamp((db - m_minDb) / (m_maxDb - m_minDb), 0.0f, 1.0f);
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
                             uint32_t& outTunedFreqHz)
{
    bool retuned = false;
    ImDrawList* drawList = ImGui::GetWindowDrawList();
    ImGuiIO& io = ImGui::GetIO();

    float spectrumHeight = displayHeight * 0.42f;
    float waterfallHeight = displayHeight - spectrumHeight - 12.0f;
    if (waterfallHeight < 80.0f) waterfallHeight = 80.0f;

    double startFreq = static_cast<double>(centerFreqHz) - (static_cast<double>(sampleRateHz) / 2.0);
    double endFreq = startFreq + static_cast<double>(sampleRateHz);

    // ========================================================================
    // 1. Spectrum Analyzer with Passband Overlay & Click-To-Tune
    // ========================================================================
    ImVec2 specPos = ImGui::GetCursorScreenPos();
    ImVec2 specSize = ImVec2(displayWidth, spectrumHeight);
    ImVec2 specEnd = ImVec2(specPos.x + specSize.x, specPos.y + specSize.y);

    // Background & Border
    drawList->AddRectFilled(specPos, specEnd, IM_COL32(11, 15, 25, 255), 4.0f);
    drawList->AddRect(specPos, specEnd, IM_COL32(30, 41, 59, 255), 4.0f);

    // Horizontal dBFS Grid lines (-120 dBFS to 0 dBFS)
    const float dbMarks[] = { 0.0f, -20.0f, -40.0f, -60.0f, -80.0f, -100.0f, -120.0f };
    for (float db : dbMarks)
    {
        float normY = (m_maxDb - db) / (m_maxDb - m_minDb);
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

    // Draw Shaded Passband Bandwidth Overlay
    float clampedPbLeft = std::clamp(pbLeftX, specPos.x, specEnd.x);
    float clampedPbRight = std::clamp(pbRightX, specPos.x, specEnd.x);
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
            float normY = std::clamp((m_maxDb - db) / (m_maxDb - m_minDb), 0.0f, 1.0f);
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
    if (tunedX >= specPos.x && tunedX <= specEnd.x)
    {
        drawList->AddLine(ImVec2(tunedX, specPos.y), ImVec2(tunedX, specEnd.y), IM_COL32(239, 68, 68, 220), 1.5f);
        drawList->AddTriangleFilled(ImVec2(tunedX - 6.0f, specPos.y), ImVec2(tunedX + 6.0f, specPos.y), ImVec2(tunedX, specPos.y + 10.0f), IM_COL32(239, 68, 68, 240));
    }

    // Spectrum Mouse Click & Drag to Tune
    bool isHoveredSpec = (io.MousePos.x >= specPos.x && io.MousePos.x <= specEnd.x &&
                          io.MousePos.y >= specPos.y && io.MousePos.y <= specEnd.y);
    if (isHoveredSpec)
    {
        float hoverRatio = (io.MousePos.x - specPos.x) / specSize.x;
        double hoverFreq = startFreq + hoverRatio * static_cast<double>(sampleRateHz);
        float hoverDb = m_maxDb - ((io.MousePos.y - specPos.y) / specSize.y) * (m_maxDb - m_minDb);

        // Crosshairs
        drawList->AddLine(ImVec2(io.MousePos.x, specPos.y), ImVec2(io.MousePos.x, specEnd.y), IM_COL32(255, 255, 255, 60), 1.0f);
        drawList->AddLine(ImVec2(specPos.x, io.MousePos.y), ImVec2(specEnd.x, io.MousePos.y), IM_COL32(255, 255, 255, 60), 1.0f);

        ImGui::SetTooltip("%.3f MHz  |  %.1f dBFS\n[Left-Click to Tune Directly]", hoverFreq / 1e6, hoverDb);

        if (ImGui::IsMouseDown(ImGuiMouseButton_Left))
        {
            outTunedFreqHz = static_cast<uint32_t>(hoverFreq);
            retuned = true;
        }
    }

    ImGui::Dummy(specSize);
    ImGui::Spacing();

    // ========================================================================
    // 2. High-Resolution Dynamic Waterfall Spectrogram with Click-To-Tune
    // ========================================================================
    ImVec2 wfPos = ImGui::GetCursorScreenPos();
    ImVec2 wfSize = ImVec2(displayWidth, waterfallHeight);
    ImVec2 wfEnd = ImVec2(wfPos.x + wfSize.x, wfPos.y + wfSize.y);

    if (m_pTextureView)
    {
        ImGui::Image(reinterpret_cast<ImTextureID>(m_pTextureView), wfSize);
    }
    else
    {
        drawList->AddRectFilled(wfPos, wfEnd, IM_COL32(8, 12, 20, 255));
        ImGui::Dummy(wfSize);
    }

    // Overlay Tuning Marker & Passband on Waterfall
    if (clampedPbRight > clampedPbLeft)
    {
        drawList->AddLine(ImVec2(clampedPbLeft, wfPos.y), ImVec2(clampedPbLeft, wfEnd.y), IM_COL32(56, 189, 248, 110), 1.0f);
        drawList->AddLine(ImVec2(clampedPbRight, wfPos.y), ImVec2(clampedPbRight, wfEnd.y), IM_COL32(56, 189, 248, 110), 1.0f);
    }
    if (tunedX >= wfPos.x && tunedX <= wfEnd.x)
    {
        drawList->AddLine(ImVec2(tunedX, wfPos.y), ImVec2(tunedX, wfEnd.y), IM_COL32(239, 68, 68, 180), 1.2f);
    }

    // Waterfall Mouse Click & Drag to Tune
    bool isHoveredWf = (io.MousePos.x >= wfPos.x && io.MousePos.x <= wfEnd.x &&
                        io.MousePos.y >= wfPos.y && io.MousePos.y <= wfEnd.y);
    if (isHoveredWf)
    {
        float hoverRatio = (io.MousePos.x - wfPos.x) / wfSize.x;
        double hoverFreq = startFreq + hoverRatio * static_cast<double>(sampleRateHz);

        drawList->AddLine(ImVec2(io.MousePos.x, wfPos.y), ImVec2(io.MousePos.x, wfEnd.y), IM_COL32(255, 255, 255, 80), 1.0f);
        ImGui::SetTooltip("Waterfall: %.3f MHz\n[Left-Click to Tune Directly]", hoverFreq / 1e6);

        if (ImGui::IsMouseDown(ImGuiMouseButton_Left))
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

constexpr size_t NUM_BUFFERS = 4;
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
            s = std::clamp(s, -1.0f, 1.0f);
            int16_t pcm = static_cast<int16_t>(s * 32767.0f);

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

    // Large Tactile DOWN Button
    if (ImGui::Button(" < DOWN ", ImVec2(70, 48)))
    {
        if (!isLocked && currentFreqHz > effectiveStep)
        {
            currentFreqHz -= effectiveStep;
            dialAngle -= 15.0f;
            if (sdr) sdr->SetCenterFrequency(currentFreqHz);
        }
    }

    ImGui::SameLine();

    // Optical Rotary Knob Widget
    ImVec2 p = ImGui::GetCursorScreenPos();
    ImDrawList* drawList = ImGui::GetWindowDrawList();
    float radius = 24.0f;
    ImVec2 center = ImVec2(p.x + radius, p.y + radius);

    // Make invisible button for interaction
    ImGui::InvisibleButton("KnobCanvas", ImVec2(radius * 2, radius * 2));
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
        float angle = atan2f(dy, dx) * 180.0f / 3.14159f;
        static float lastAngle = 0.0f;
        static bool wasActive = false;
        if (wasActive)
        {
            float delta = angle - lastAngle;
            if (delta > 180.0f) delta -= 360.0f;
            if (delta < -180.0f) delta += 360.0f;
            if (fabs(delta) > 8.0f)
            {
                int steps = (int)(delta / 8.0f);
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

    // Draw Knob Outer Rim
    drawList->AddCircleFilled(center, radius, IM_COL32(20, 26, 38, 255), 32);
    drawList->AddCircle(center, radius, IM_COL32(50, 70, 100, 255), 32, 2.0f);

    // Draw 12 Tick Marks
    float radAngle = dialAngle * (3.14159f / 180.0f);
    for (int i = 0; i < 12; ++i)
    {
        float a = radAngle + i * (3.14159f / 6.0f);
        ImVec2 p1 = ImVec2(center.x + cosf(a) * (radius - 2.0f), center.y + sinf(a) * (radius - 2.0f));
        ImVec2 p2 = ImVec2(center.x + cosf(a) * (radius - 6.0f), center.y + sinf(a) * (radius - 6.0f));
        drawList->AddLine(p1, p2, (i % 3 == 0) ? IM_COL32(56, 189, 248, 255) : IM_COL32(100, 116, 139, 255), 1.5f);
    }

    // Inner knob face & Finger Dimple
    drawList->AddCircleFilled(center, radius - 8.0f, IM_COL32(30, 41, 59, 255), 24);
    float dimpleAngle = radAngle - 1.5708f;
    ImVec2 dimplePos = ImVec2(center.x + cosf(dimpleAngle) * (radius - 14.0f),
                              center.y + sinf(dimpleAngle) * (radius - 14.0f));
    drawList->AddCircleFilled(dimplePos, 3.5f, IM_COL32(56, 189, 248, 255));

    ImGui::SameLine();

    // Large Tactile UP Button
    if (ImGui::Button(" UP > ", ImVec2(70, 48)))
    {
        if (!isLocked)
        {
            currentFreqHz += effectiveStep;
            dialAngle += 15.0f;
            if (sdr) sdr->SetCenterFrequency(currentFreqHz);
        }
    }

    ImGui::SameLine();

    // Step Size Combo & Fast Mode
    ImGui::BeginGroup();
    {
        const char* stepLabels[] = { "100 Hz", "1 kHz", "5 kHz", "10 kHz", "12.5 kHz", "25 kHz", "100 kHz", "1 MHz" };
        const uint32_t stepVals[] = { 100, 1000, 5000, 10000, 12500, 25000, 100000, 1000000 };
        static int stepIdx = 3; // 10 kHz
        ImGui::SetNextItemWidth(85.0f);
        if (ImGui::Combo("Step", &stepIdx, stepLabels, IM_ARRAYSIZE(stepLabels)))
        {
            stepSizeHz = stepVals[stepIdx];
        }

        ImGui::Checkbox("FAST (10x)", &isFast);
        ImGui::SameLine();
        ImGui::Checkbox("LOCK", &isLocked);
    }
    ImGui::EndGroup();

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
      <AdditionalIncludeDirectories>$(ProjectDir)src;$(ProjectDir)vendor;$(ProjectDir)vendor\\imgui;$(ProjectDir)vendor\\imgui\\backends;$(ProjectDir)..\\vendor;$(ProjectDir)..\\vendor\\imgui;$(ProjectDir)..\\vendor\\imgui\\backends;$(SolutionDir)vendor;$(SolutionDir)vendor\\imgui;$(SolutionDir)vendor\\imgui\\backends;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
    </ClCompile>
    <Link>
      <SubSystem>Windows</SubSystem>
      <GenerateDebugInformation>true</GenerateDebugInformation>
      <AdditionalDependencies>d3d11.lib;d3dcompiler.lib;dxgi.lib;winmm.lib;%(AdditionalDependencies)</AdditionalDependencies>
      <AdditionalLibraryDirectories>$(ProjectDir)lib\\x64;%(AdditionalLibraryDirectories)</AdditionalLibraryDirectories>
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
      <AdditionalIncludeDirectories>$(ProjectDir)src;$(ProjectDir)vendor;$(ProjectDir)vendor\\imgui;$(ProjectDir)vendor\\imgui\\backends;$(ProjectDir)..\\vendor;$(ProjectDir)..\\vendor\\imgui;$(ProjectDir)..\\vendor\\imgui\\backends;$(SolutionDir)vendor;$(SolutionDir)vendor\\imgui;$(SolutionDir)vendor\\imgui\\backends;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
    </ClCompile>
    <Link>
      <SubSystem>Windows</SubSystem>
      <EnableCOMDATFolding>true</EnableCOMDATFolding>
      <OptimizeReferences>true</OptimizeReferences>
      <GenerateDebugInformation>true</GenerateDebugInformation>
      <AdditionalDependencies>d3d11.lib;d3dcompiler.lib;dxgi.lib;winmm.lib;%(AdditionalDependencies)</AdditionalDependencies>
      <AdditionalLibraryDirectories>$(ProjectDir)lib\\x64;%(AdditionalLibraryDirectories)</AdditionalLibraryDirectories>
    </Link>
  </ItemDefinitionGroup>
  <ItemGroup>
    <ClCompile Include="src\\main.cpp" />
    <ClCompile Include="src\\sdr_device.cpp" />
    <ClCompile Include="src\\dsp.cpp" />
    <ClCompile Include="src\\waterfall.cpp" />
    <ClCompile Include="src\\audio_player.cpp" />
    <ClCompile Include="src\\memory_banks.cpp" />
    <ClCompile Include="vendor\\imgui\\imgui.cpp" Condition="Exists('vendor\\imgui\\imgui.cpp')" />
    <ClCompile Include="vendor\\imgui\\imgui_draw.cpp" Condition="Exists('vendor\\imgui\\imgui_draw.cpp')" />
    <ClCompile Include="vendor\\imgui\\imgui_tables.cpp" Condition="Exists('vendor\\imgui\\imgui_tables.cpp')" />
    <ClCompile Include="vendor\\imgui\\imgui_widgets.cpp" Condition="Exists('vendor\\imgui\\imgui_widgets.cpp')" />
    <ClCompile Include="vendor\\imgui\\backends\\imgui_impl_win32.cpp" Condition="Exists('vendor\\imgui\\backends\\imgui_impl_win32.cpp')" />
    <ClCompile Include="vendor\\imgui\\backends\\imgui_impl_dx11.cpp" Condition="Exists('vendor\\imgui\\backends\\imgui_impl_dx11.cpp')" />
    <ClCompile Include="vendor\\imgui\\imgui_impl_win32.cpp" Condition="!Exists('vendor\\imgui\\backends\\imgui_impl_win32.cpp') and Exists('vendor\\imgui\\imgui_impl_win32.cpp')" />
    <ClCompile Include="vendor\\imgui\\imgui_impl_dx11.cpp" Condition="!Exists('vendor\\imgui\\backends\\imgui_impl_dx11.cpp') and Exists('vendor\\imgui\\imgui_impl_dx11.cpp')" />
  </ItemGroup>
  <ItemGroup>
    <ClInclude Include="src\\sdr_device.h" />
    <ClInclude Include="src\\dsp.h" />
    <ClInclude Include="src\\waterfall.h" />
    <ClInclude Include="src\\audio_player.h" />
    <ClInclude Include="src\\memory_banks.h" />
    <ClInclude Include="vendor\\imgui\\imgui.h" Condition="Exists('vendor\\imgui\\imgui.h')" />
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
)

set(HEADERS
    src/sdr_device.h
    src/dsp.h
    src/waterfall.h
    src/audio_player.h
    src/memory_banks.h
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
echo Working Directory: %CD%
echo.

REM Create directories in current directory and parent directory just in case
if not exist "vendor" mkdir "vendor"
if not exist "vendor\\imgui" mkdir "vendor\\imgui"
if not exist "vendor\\imgui\\backends" mkdir "vendor\\imgui\\backends"
if not exist "..\\vendor" mkdir "..\\vendor" 2>nul
if not exist "..\\vendor\\imgui" mkdir "..\\vendor\\imgui" 2>nul
if not exist "..\\vendor\\imgui\\backends" mkdir "..\\vendor\\imgui\\backends" 2>nul

echo [1/3] Downloading Dear ImGui (v1.90.4)...
set "DOWNLOADED=0"

where curl.exe >nul 2>nul
if %errorlevel% equ 0 (
    echo Attempting download with native curl...
    curl.exe -fSL -k "https://github.com/ocornut/imgui/archive/refs/tags/v1.90.4.zip" -o "imgui_temp.zip"
    if exist "imgui_temp.zip" set "DOWNLOADED=1"
)

if "!DOWNLOADED!"=="0" (
    echo Attempting download with PowerShell TLS 1.2...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor 3072 -bor 12288; " ^
        "(New-Object System.Net.WebClient).DownloadFile('https://github.com/ocornut/imgui/archive/refs/tags/v1.90.4.zip', 'imgui_temp.zip')"
    if exist "imgui_temp.zip" set "DOWNLOADED=1"
)

echo [2/3] Extracting files...
if exist "imgui_temp.zip" (
    where tar.exe >nul 2>nul
    if %errorlevel% equ 0 (
        tar.exe -xf imgui_temp.zip
    ) else (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path 'imgui_temp.zip' -DestinationPath '.' -Force"
    )

    if exist "imgui-1.90.4" (
        copy /y "imgui-1.90.4\\*.h" "vendor\\imgui\\" >nul
        copy /y "imgui-1.90.4\\*.cpp" "vendor\\imgui\\" >nul
        copy /y "imgui-1.90.4\\backends\\imgui_impl_win32.*" "vendor\\imgui\\backends\\" >nul
        copy /y "imgui-1.90.4\\backends\\imgui_impl_dx11.*" "vendor\\imgui\\backends\\" >nul

        copy /y "imgui-1.90.4\\*.h" "..\\vendor\\imgui\\" >nul 2>nul
        copy /y "imgui-1.90.4\\*.cpp" "..\\vendor\\imgui\\" >nul 2>nul
        copy /y "imgui-1.90.4\\backends\\imgui_impl_win32.*" "..\\vendor\\imgui\\backends\\" >nul 2>nul
        copy /y "imgui-1.90.4\\backends\\imgui_impl_dx11.*" "..\\vendor\\imgui\\backends\\" >nul 2>nul

        REM Remove duplicates in root imgui dir so MSBuild doesn't produce MSB8027
        del /q "vendor\\imgui\\imgui_impl_win32.*" 2>nul
        del /q "vendor\\imgui\\imgui_impl_dx11.*" 2>nul
        del /q "..\\vendor\\imgui\\imgui_impl_win32.*" 2>nul
        del /q "..\\vendor\\imgui\\imgui_impl_dx11.*" 2>nul

        del /q "imgui_temp.zip" 2>nul
        rmdir /s /q "imgui-1.90.4" 2>nul
    )
)

REM Direct file fallback if zip extraction failed
if not exist "vendor\\imgui\\imgui.h" (
    echo [Fallback] Downloading standalone header files directly...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$wc = New-Object System.Net.WebClient; " ^
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor 3072; " ^
        "$base = 'https://raw.githubusercontent.com/ocornut/imgui/v1.90.4/'; " ^
        "$files = @('imgui.h','imgui.cpp','imgui_draw.cpp','imgui_tables.cpp','imgui_widgets.cpp','imconfig.h','imgui_internal.h','imstb_rectpack.h','imstb_textedit.h','imstb_truetype.h'); " ^
        "foreach($f in $files) { $wc.DownloadFile($base + $f, 'vendor\\imgui\\' + $f); Copy-Item ('vendor\\imgui\\' + $f) '..\\vendor\\imgui\\' -ErrorAction SilentlyContinue }; " ^
        "$wc.DownloadFile($base + 'backends/imgui_impl_win32.h', 'vendor\\imgui\\imgui_impl_win32.h'); " ^
        "$wc.DownloadFile($base + 'backends/imgui_impl_win32.cpp', 'vendor\\imgui\\imgui_impl_win32.cpp'); " ^
        "$wc.DownloadFile($base + 'backends/imgui_impl_dx11.h', 'vendor\\imgui\\imgui_impl_dx11.h'); " ^
        "$wc.DownloadFile($base + 'backends/imgui_impl_dx11.cpp', 'vendor\\imgui\\imgui_impl_dx11.cpp'); " ^
        "Copy-Item 'vendor\\imgui\\imgui_impl_*' 'vendor\\imgui\\backends\\' -ErrorAction SilentlyContinue; " ^
        "Copy-Item 'vendor\\imgui\\imgui_impl_*' '..\\vendor\\imgui\\' -ErrorAction SilentlyContinue; " ^
        "Copy-Item 'vendor\\imgui\\imgui_impl_*' '..\\vendor\\imgui\\backends\\' -ErrorAction SilentlyContinue;"
)

echo [3/3] Verification:
if exist "vendor\\imgui\\imgui.h" (
    echo.
    echo =====================================================================
    echo [SUCCESS] Dear ImGui successfully installed to:
    echo   %CD%\\vendor\\imgui\\imgui.h
    echo =====================================================================
) else (
    echo.
    echo =====================================================================
    echo [ATTENTION] Automatic download could not reach GitHub.
    echo Please run the following command in PowerShell:
    echo   vcpkg install imgui[win32-binding,dx11-binding]:x64-windows
    echo   vcpkg integrate install
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
