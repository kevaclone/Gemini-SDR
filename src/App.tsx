import React, { useState, useEffect, useCallback } from 'react';
import {
  SdrDeviceState,
  DemodSettings,
  WaterfallSettings,
} from './types';
import { SdrSpectrumWaterfall } from './components/SdrSpectrumWaterfall';
import { SdrControlPanel } from './components/SdrControlPanel';
import { SdrMetricsBar } from './components/SdrMetricsBar';
import { SdrDeviceSettingsModal } from './components/SdrDeviceSettingsModal';
import { MemoryBankManagerModal } from './components/MemoryBankManagerModal';
import { VisualStudioProjectViewer } from './components/VisualStudioProjectViewer';
import { VisualStudioSetupGuide } from './components/VisualStudioSetupGuide';
import { sdrAudioEngine } from './services/sdrAudioEngine';
import { downloadVisualStudioProjectZip } from './services/zipExporter';
import {
  Radio,
  FolderGit2,
  BookOpen,
  Download,
  Sliders,
  Sparkles,
  Bookmark,
} from 'lucide-react';

export default function App() {
  // Navigation view mode
  const [activeTab, setActiveTab] = useState<'sdr_gui' | 'vs_project' | 'vs_guide'>('sdr_gui');

  // SDR Device State
  const [deviceState, setDeviceState] = useState<SdrDeviceState>({
    isConnected: true,
    isStreaming: true,
    deviceName: 'RTL2832U USB (Simulated RF)',
    isWebUsb: false,
    tunerType: 'Rafael Micro R820T2',
    centerFreqHz: 101100000, // 101.100 MHz
    vfoOffsetHz: 0,
    actualFreqHz: 101100000,
    sampleRateHz: 2048000,   // 2.048 MSPS standard
    gainMode: 'auto',
    tunerGainDb: 32.8,
    rtlAgc: false,
    directSampling: 'disabled',
    ppmCorrection: 0,
    biasT: false,
  });

  // Demodulation & Audio Settings
  const [demodSettings, setDemodSettings] = useState<DemodSettings>({
    mode: 'WBFM',
    bandwidthHz: 180000,
    squelchDb: -65,
    volume: 0.7,
    isMuted: false,
    audioFilter: true,
    deemphasisUs: 75,
    cwPitchHz: 700,
    agcSpeed: 'medium',
  });

  // Waterfall & FFT Display Settings
  const [waterfallSettings, setWaterfallSettings] = useState<WaterfallSettings>({
    fftSize: 1024,
    fftRateFps: 60,
    minDbm: -110,
    maxDbm: -10,
    colorMap: 'turbo',
    peakHold: true,
    smoothing: 0.65,
    zoomLevel: 3,
  });

  // Hardware configuration modal state
  const [isHardwareModalOpen, setIsHardwareModalOpen] = useState<boolean>(false);
  // Memory bank manager modal state
  const [isMemoryModalOpen, setIsMemoryModalOpen] = useState<boolean>(false);

  // Dynamic Signal Metrics
  const [snrDb, setSnrDb] = useState<number>(38.4);
  const [rssiDb, setRssiDb] = useState<number>(-52.0);

  // Frequency tuning handler
  const handleTuneFrequency = useCallback((newFreqHz: number) => {
    setDeviceState((prev) => {
      // If tuned frequency drifts outside current bandwidth window, recenter
      const halfSpan = prev.sampleRateHz * 0.45;
      const offset = newFreqHz - prev.centerFreqHz;
      let newCenter = prev.centerFreqHz;
      if (Math.abs(offset) > halfSpan) {
        newCenter = newFreqHz;
      }
      return {
        ...prev,
        centerFreqHz: newCenter,
        actualFreqHz: newFreqHz,
        vfoOffsetHz: newFreqHz - newCenter,
      };
    });
  }, []);

  // Tune channel from Memory Bank with matching mode and filter bandwidth
  const handleTuneChannel = useCallback((freqHz: number, mode: any, bandwidthHz: number) => {
    handleTuneFrequency(freqHz);
    setDemodSettings((prev) => ({
      ...prev,
      mode,
      bandwidthHz,
    }));
  }, [handleTuneFrequency]);

  // Master Stream toggle
  const handleToggleStream = async () => {
    if (deviceState.isStreaming) {
      sdrAudioEngine.stop();
      setDeviceState((prev) => ({ ...prev, isStreaming: false }));
    } else {
      await sdrAudioEngine.start();
      setDeviceState((prev) => ({ ...prev, isStreaming: true }));
    }
  };

  // Sync audio engine with SDR state & tuning changes
  useEffect(() => {
    if (deviceState.isStreaming) {
      // Calculate realistic SNR based on tuning near station
      const distFromCarrier = Math.abs(deviceState.actualFreqHz - 101100000);
      const isNearStation = distFromCarrier < demodSettings.bandwidthHz / 2;
      const currentSnr = isNearStation ? 38 - (distFromCarrier / 10000) * 1.5 : 4.5 + Math.random() * 3;
      const currentRssi = isNearStation ? -48 - (distFromCarrier / 10000) * 2 : -96 + Math.random() * 4;

      setSnrDb(Math.max(2, currentSnr));
      setRssiDb(currentRssi);

      sdrAudioEngine.updateParameters({
        freqHz: deviceState.actualFreqHz,
        mode: demodSettings.mode,
        bandwidthHz: demodSettings.bandwidthHz,
        volume: demodSettings.volume,
        isMuted: demodSettings.isMuted,
        squelchDb: demodSettings.squelchDb,
        snrDb: currentSnr,
      });
    } else {
      setSnrDb(0);
      setRssiDb(-115);
    }
  }, [
    deviceState.isStreaming,
    deviceState.actualFreqHz,
    demodSettings.mode,
    demodSettings.bandwidthHz,
    demodSettings.volume,
    demodSettings.isMuted,
    demodSettings.squelchDb,
  ]);

  return (
    <div className="flex flex-col h-screen w-screen bg-[#070a0f] text-slate-100 font-sans select-none overflow-hidden">
      {/* Top Application Header */}
      <header id="main-header" className="h-14 bg-[#0a0e17] border-b border-slate-800 px-4 flex items-center justify-between shrink-0 z-20">
        {/* Brand & Chip Badge */}
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-tr from-sky-600 to-emerald-500 rounded-md text-white shadow-md shadow-sky-900/20">
            <Radio className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold tracking-wide text-slate-100 uppercase">
                RTL-SDR Visual Studio Studio
              </h1>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-400 border border-emerald-800/40 font-semibold">
                RTL2832U / R820T2
              </span>
            </div>
            <div className="text-[11px] text-slate-400">
              C++ Standalone GUI &bull; DirectX 11 &bull; Dear ImGui Architecture
            </div>
          </div>
        </div>

        {/* Primary View Switcher Navigation */}
        <nav className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-lg border border-slate-800 text-xs font-medium">
          <button
            id="tab-sdr-gui"
            onClick={() => setActiveTab('sdr_gui')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              activeTab === 'sdr_gui'
                ? 'bg-sky-600 text-white shadow-sm shadow-sky-900/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>Interactive SDR GUI</span>
          </button>

          <button
            id="tab-vs-project"
            onClick={() => setActiveTab('vs_project')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              activeTab === 'vs_project'
                ? 'bg-purple-600 text-white shadow-sm shadow-purple-900/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <FolderGit2 className="w-3.5 h-3.5" />
            <span>C++ Visual Studio Solution</span>
          </button>

          <button
            id="tab-vs-guide"
            onClick={() => setActiveTab('vs_guide')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              activeTab === 'vs_guide'
                ? 'bg-amber-600 text-white shadow-sm shadow-amber-900/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>VS &amp; Zadig Guide</span>
          </button>
        </nav>

        {/* Quick Actions */}
        <div className="flex items-center gap-2">
          <button
            id="open-memory-banks-header-btn"
            onClick={() => setIsMemoryModalOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gradient-to-r from-amber-600/30 to-amber-700/40 hover:from-amber-600/50 hover:to-amber-700/60 text-amber-200 rounded-md text-xs font-semibold transition-all cursor-pointer border border-amber-500/40 shadow-sm"
            title="Open Frequency Memory Banks (Brisbane Air, UHF CB, Outback RFDS, Marine/AIS, Ham)"
          >
            <Bookmark className="w-3.5 h-3.5 text-amber-400" />
            <span>Memory Banks</span>
          </button>

          <button
            id="open-hardware-modal-header-btn"
            onClick={() => setIsHardwareModalOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md text-xs transition-colors cursor-pointer border border-slate-700/60"
            title="Configure RTL2832U Gain & Sample Rate"
          >
            <Sliders className="w-3.5 h-3.5 text-sky-400" />
            <span>Hardware Config</span>
          </button>

          <button
            id="quick-download-zip-btn"
            onClick={() => downloadVisualStudioProjectZip()}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-md text-xs font-semibold shadow-md shadow-purple-900/30 transition-all cursor-pointer"
            title="Download full C++ project ready to open in Visual Studio"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download .ZIP</span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex overflow-hidden relative">
        {activeTab === 'sdr_gui' && (
          <div className="flex-1 flex flex-col h-full overflow-hidden">
            <div className="flex-1 flex overflow-hidden">
              {/* Left Control Panel */}
              <SdrControlPanel
                tunedFreqHz={deviceState.actualFreqHz}
                onTuneFrequency={handleTuneFrequency}
                demodSettings={demodSettings}
                onDemodSettingsChange={setDemodSettings}
                isStreaming={deviceState.isStreaming}
                onToggleStream={handleToggleStream}
                onOpenHardwareModal={() => setIsHardwareModalOpen(true)}
                onOpenMemoryBanks={() => setIsMemoryModalOpen(true)}
                snrDb={snrDb}
              />

              {/* Center Spectrum & Waterfall Display */}
              <div className="flex-1 flex flex-col h-full overflow-hidden">
                <SdrSpectrumWaterfall
                  centerFreqHz={deviceState.centerFreqHz}
                  tunedFreqHz={deviceState.actualFreqHz}
                  sampleRateHz={deviceState.sampleRateHz}
                  bandwidthHz={demodSettings.bandwidthHz}
                  demodMode={demodSettings.mode}
                  settings={waterfallSettings}
                  onSettingsChange={setWaterfallSettings}
                  onTuneFrequency={handleTuneFrequency}
                  isStreaming={deviceState.isStreaming}
                />
              </div>
            </div>

            {/* Bottom Status & S-Meter Bar */}
            <SdrMetricsBar
              snrDb={snrDb}
              rssiDb={rssiDb}
              sampleRateHz={deviceState.sampleRateHz}
              isStreaming={deviceState.isStreaming}
              isWebUsb={deviceState.isWebUsb}
              deviceName={deviceState.deviceName}
            />
          </div>
        )}

        {activeTab === 'vs_project' && <VisualStudioProjectViewer />}

        {activeTab === 'vs_guide' && <VisualStudioSetupGuide />}
      </main>

      {/* Hardware Settings Modal */}
      <SdrDeviceSettingsModal
        isOpen={isHardwareModalOpen}
        onClose={() => setIsHardwareModalOpen(false)}
        deviceState={deviceState}
        onDeviceStateChange={setDeviceState}
      />

      {/* Frequency Memory Banks Modal */}
      <MemoryBankManagerModal
        isOpen={isMemoryModalOpen}
        onClose={() => setIsMemoryModalOpen(false)}
        currentFreqHz={deviceState.actualFreqHz}
        currentMode={demodSettings.mode}
        currentBandwidthHz={demodSettings.bandwidthHz}
        onTuneChannel={handleTuneChannel}
      />
    </div>
  );
}
