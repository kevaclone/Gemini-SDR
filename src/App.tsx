import React, { useState, useEffect, useCallback } from 'react';
import {
  SdrDeviceState,
  DemodSettings,
  WaterfallSettings,
  DabService,
} from './types';
import { SdrSpectrumWaterfall } from './components/SdrSpectrumWaterfall';
import { SdrControlPanel } from './components/SdrControlPanel';
import { SdrMetricsBar } from './components/SdrMetricsBar';
import { SdrDeviceSettingsModal } from './components/SdrDeviceSettingsModal';
import { MemoryBankManagerModal } from './components/MemoryBankManagerModal';
import { VisualStudioProjectViewer } from './components/VisualStudioProjectViewer';
import { VisualStudioSetupGuide } from './components/VisualStudioSetupGuide';
import { DabDecoderPanel } from './components/DabDecoderPanel';
import { findDabEnsembleByFreq } from './data/dabChannels';
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

  // Active DAB+ Service selection
  const [activeDabService, setActiveDabService] = useState<DabService | null>(null);

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
      let currentSnr = 4.5 + Math.random() * 2;
      let currentRssi = -95 + Math.random() * 3;

      // 1. Check if in DAB+ mode or tuned to a DAB+ Band III Multiplex (174 - 240 MHz)
      const dabEnsemble = findDabEnsembleByFreq(deviceState.actualFreqHz);
      if (
        demodSettings.mode === 'DAB+' ||
        (deviceState.actualFreqHz >= 174000000 && deviceState.actualFreqHz <= 240000000)
      ) {
        if (dabEnsemble) {
          const dist = Math.abs(deviceState.actualFreqHz - dabEnsemble.freqHz);
          // DAB+ channel multiplex is ~1.536 MHz wide (+/- 768 kHz)
          if (dist <= 800000) {
            currentSnr = Math.max(14, 31.0 - (dist / 100000) * 1.5);
            currentRssi = -48.0 - (dist / 100000) * 1.8;
          }
        }
      } else {
        // 2. Analog Stations (FM 101.1, 97.3, 104.5; Airband 119.1; Marine 156.8; NOAA 162.55; Ham 146.52; HF 7.030)
        const analogFreqs = [
          101100000, 97300000, 104500000, 106900000, 119100000, 121500000,
          156800000, 162550000, 146520000, 7030000, 14225000, 444000000,
        ];
        let minDist = Infinity;
        for (const f of analogFreqs) {
          const d = Math.abs(deviceState.actualFreqHz - f);
          if (d < minDist) minDist = d;
        }
        const bw = demodSettings.bandwidthHz;
        if (minDist < bw * 0.9) {
          currentSnr = Math.max(12, 38 - (minDist / (bw || 10000)) * 22);
          currentRssi = -46 - (minDist / (bw || 10000)) * 25;
        }
      }

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
        dabService: activeDabService || undefined,
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
    activeDabService,
  ]);

  return (
    <div className="flex flex-col h-screen w-screen bg-[#070a0f] text-slate-100 font-sans select-none overflow-hidden">
      {/* Top Application Header */}
      <header id="main-header" className="h-14 bg-[#0a0e17] border-b border-slate-800 px-3 sm:px-4 flex items-center justify-between shrink-0 z-20 gap-2 min-w-0">
        {/* Brand & Chip Badge */}
        <div className="flex items-center gap-2.5 min-w-0 shrink">
          <div className="p-1.5 sm:p-2 bg-gradient-to-tr from-sky-600 to-emerald-500 rounded-md text-white shadow-md shadow-sky-900/20 shrink-0">
            <Radio className="w-4 h-4 sm:w-5 sm:h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <h1 className="text-xs sm:text-sm font-bold tracking-wide text-slate-100 uppercase truncate">
                RTL-SDR Visual Studio
              </h1>
              <span className="hidden sm:inline-block text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-400 border border-emerald-800/40 font-semibold shrink-0">
                RTL2832U
              </span>
            </div>
            <div className="hidden xl:block text-[11px] text-slate-400 truncate">
              C++ Standalone GUI &bull; DirectX 11 &bull; Dear ImGui Architecture
            </div>
          </div>
        </div>

        {/* Primary View Switcher Navigation */}
        <nav className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-lg border border-slate-800 text-xs font-medium shrink-0">
          <button
            id="tab-sdr-gui"
            onClick={() => setActiveTab('sdr_gui')}
            className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              activeTab === 'sdr_gui'
                ? 'bg-sky-600 text-white shadow-sm shadow-sky-900/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Interactive SDR GUI</span>
            <span className="sm:hidden">SDR</span>
          </button>

          <button
            id="tab-vs-project"
            onClick={() => setActiveTab('vs_project')}
            className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              activeTab === 'vs_project'
                ? 'bg-purple-600 text-white shadow-sm shadow-purple-900/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <FolderGit2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">C++ Visual Studio Solution</span>
            <span className="sm:hidden">C++ Code</span>
          </button>

          <button
            id="tab-vs-guide"
            onClick={() => setActiveTab('vs_guide')}
            className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              activeTab === 'vs_guide'
                ? 'bg-amber-600 text-white shadow-sm shadow-amber-900/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">VS &amp; Zadig Guide</span>
            <span className="sm:hidden">Guide</span>
          </button>
        </nav>

        {/* Quick Actions */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <button
            id="quick-dab-toggle-btn"
            onClick={() => {
              if (demodSettings.mode === 'DAB+') {
                setDemodSettings((prev) => ({ ...prev, mode: 'WBFM', bandwidthHz: 180000 }));
                handleTuneFrequency(101100000);
              } else {
                setDemodSettings((prev) => ({ ...prev, mode: 'DAB+', bandwidthHz: 1536000 }));
                handleTuneFrequency(202928000); // 9A Brisbane Comm 1
              }
            }}
            className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer border shadow-sm ${
              demodSettings.mode === 'DAB+'
                ? 'bg-cyan-600 text-white border-cyan-400 shadow-cyan-900/40'
                : 'bg-slate-800 hover:bg-slate-700 text-cyan-300 border-slate-700/60'
            }`}
            title="Toggle DAB+ Digital Radio Multiplex Mode (Band III 9A 202.928 MHz)"
          >
            <Radio className="w-3.5 h-3.5 text-cyan-400" />
            <span>DAB+</span>
          </button>

          <button
            id="open-memory-banks-header-btn"
            onClick={() => setIsMemoryModalOpen(true)}
            className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 bg-gradient-to-r from-amber-600/30 to-amber-700/40 hover:from-amber-600/50 hover:to-amber-700/60 text-amber-200 rounded-md text-xs font-semibold transition-all cursor-pointer border border-amber-500/40 shadow-sm"
            title="Open Frequency Memory Banks (DAB+ Multiplexes, Brisbane Air, UHF CB, Outback RFDS, Marine/AIS, Ham)"
          >
            <Bookmark className="w-3.5 h-3.5 text-amber-400" />
            <span>Memory Banks</span>
          </button>

          <button
            id="open-hardware-modal-header-btn"
            onClick={() => setIsHardwareModalOpen(true)}
            className="hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md text-xs transition-colors cursor-pointer border border-slate-700/60"
            title="Configure RTL2832U Gain & Sample Rate"
          >
            <Sliders className="w-3.5 h-3.5 text-sky-400" />
            <span>Hardware</span>
          </button>

          <button
            id="quick-download-zip-btn"
            onClick={() => downloadVisualStudioProjectZip()}
            className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-md text-xs font-semibold shadow-md shadow-purple-900/30 transition-all cursor-pointer"
            title="Download full C++ project ready to open in Visual Studio"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Download .ZIP</span>
            <span className="sm:hidden">.ZIP</span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex overflow-hidden relative min-h-0 min-w-0">
        {activeTab === 'sdr_gui' && (
          <div className="flex-1 flex flex-col h-full overflow-hidden min-h-0 min-w-0">
            <div className="flex-1 flex overflow-hidden min-h-0 min-w-0">
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
              <div className="flex-1 flex flex-col h-full overflow-hidden min-h-0 min-w-0">
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
                  isInteractionDisabled={isMemoryModalOpen || isHardwareModalOpen}
                />

                {/* Live DAB+ Digital Radio Decoder Panel when DAB+ mode is active or tuned to Band III */}
                {(demodSettings.mode === 'DAB+' ||
                  (deviceState.actualFreqHz >= 174000000 && deviceState.actualFreqHz <= 240000000)) && (
                  <DabDecoderPanel
                    tunedFreqHz={deviceState.actualFreqHz}
                    onTuneFrequency={(freq) => {
                      handleTuneFrequency(freq);
                      setDemodSettings((prev) => ({
                        ...prev,
                        mode: 'DAB+',
                        bandwidthHz: 1536000,
                      }));
                    }}
                    snrDb={snrDb}
                    isStreaming={deviceState.isStreaming}
                    onSelectService={setActiveDabService}
                  />
                )}
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
