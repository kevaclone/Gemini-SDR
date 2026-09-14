import React, { useState } from 'react';
import { DemodMode, DemodSettings, FrequencyBand } from '../types';
import { FREQUENCY_BANDS } from '../data/bands';
import { TuningDial } from './TuningDial';
import { Volume2, VolumeX, Play, Square, Radio, Sliders, ChevronDown, Bookmark, Hash, CornerDownLeft, Delete } from 'lucide-react';

interface Props {
  tunedFreqHz: number;
  onTuneFrequency: (freqHz: number) => void;
  demodSettings: DemodSettings;
  onDemodSettingsChange: (settings: DemodSettings) => void;
  isStreaming: boolean;
  onToggleStream: () => void;
  onOpenHardwareModal: () => void;
  onOpenMemoryBanks: () => void;
  snrDb: number;
}

export const SdrControlPanel: React.FC<Props> = ({
  tunedFreqHz,
  onTuneFrequency,
  demodSettings,
  onDemodSettingsChange,
  isStreaming,
  onToggleStream,
  onOpenHardwareModal,
  onOpenMemoryBanks,
  snrDb,
}) => {
  const [directFreqInput, setDirectFreqInput] = useState<string>('');
  const [isEditingFreq, setIsEditingFreq] = useState<boolean>(false);
  const [showKeypad, setShowKeypad] = useState<boolean>(true);

  // Split tuned frequency into MHz, kHz, Hz components
  const mhz = Math.floor(tunedFreqHz / 1e6);
  const khz = Math.floor((tunedFreqHz % 1e6) / 1e3);
  const hz = Math.floor(tunedFreqHz % 1e3);

  const stepFreq = (deltaHz: number) => {
    const next = Math.max(100000, Math.min(1800000000, tunedFreqHz + deltaHz));
    onTuneFrequency(next);
  };

  const handleKeypadPress = (val: string) => {
    if (val === 'CLR') {
      setDirectFreqInput('');
    } else if (val === 'BS') {
      setDirectFreqInput((prev) => prev.slice(0, -1));
    } else if (val === 'ENTER') {
      applyDirectFreq(directFreqInput);
    } else {
      if (directFreqInput.length < 12) {
        setDirectFreqInput((prev) => prev + val);
      }
    }
  };

  const applyDirectFreq = (inputStr: string) => {
    const val = parseFloat(inputStr);
    if (!isNaN(val) && val > 0) {
      // If user typed e.g. "101.1", convert MHz to Hz
      const hz = val < 2500 ? Math.round(val * 1e6) : Math.round(val);
      onTuneFrequency(hz);
    }
    setDirectFreqInput('');
    setIsEditingFreq(false);
  };

  const handleDirectFreqSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    applyDirectFreq(directFreqInput);
  };

  const handleSelectBand = (band: FrequencyBand) => {
    onTuneFrequency(band.freqHz);
    onDemodSettingsChange({
      ...demodSettings,
      mode: band.mode,
      bandwidthHz: band.bandwidthHz,
    });
  };

  const isSquelchOpen = snrDb > (demodSettings.squelchDb + 100);

  const modes: { mode: DemodMode; label: string; desc: string }[] = [
    { mode: 'WBFM', label: 'WBFM', desc: 'FM Broadcast (88-108 MHz)' },
    { mode: 'NBFM', label: 'NBFM', desc: 'Ham / Marine (12.5k / 25k)' },
    { mode: 'AM',   label: 'AM',   desc: 'Aviation / Shortwave' },
    { mode: 'USB',  label: 'USB',  desc: 'Upper Sideband (HF)' },
    { mode: 'LSB',  label: 'LSB',  desc: 'Lower Sideband (HF)' },
    { mode: 'CW',   label: 'CW',   desc: 'Morse Code (700Hz BFO)' },
  ];

  const bandwidthPresets = [
    { label: '180k FM', val: 180000 },
    { label: '150k', val: 150000 },
    { label: '25k NFM', val: 25000 },
    { label: '12.5k', val: 12500 },
    { label: '9k AM', val: 9000 },
    { label: '6k', val: 6000 },
    { label: '2.8k SSB', val: 2800 },
    { label: '500 CW', val: 500 },
  ];

  return (
    <div id="sdr-control-panel" className="bg-[#0b0f17] border-r border-slate-800 flex flex-col h-full w-80 shrink-0 text-slate-200 overflow-y-auto select-none">
      {/* 1. Master Start / Stop & Hardware Config Header */}
      <div className="p-3 border-b border-slate-800 flex items-center justify-between gap-2 bg-[#0e1420]">
        <button
          id="master-stream-toggle-btn"
          onClick={onToggleStream}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-md font-semibold text-sm transition-all shadow-md ${
            isStreaming
              ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-900/30'
              : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-900/30'
          }`}
        >
          {isStreaming ? (
            <>
              <Square className="w-4 h-4 fill-current" />
              <span>STOP SDR</span>
            </>
          ) : (
            <>
              <Play className="w-4 h-4 fill-current" />
              <span>START SDR</span>
            </>
          )}
        </button>

        <button
          id="open-hardware-settings-btn"
          onClick={onOpenHardwareModal}
          title="RTL2832U Dongle Hardware Config"
          className="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md transition-colors"
        >
          <Sliders className="w-4 h-4" />
        </button>
      </div>

      {/* 2. Frequency VFO Display */}
      <div className="p-3 border-b border-slate-800 bg-[#070a10]">
        <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
          <span className="font-semibold tracking-wider text-slate-300 flex items-center gap-1">
            <Radio className="w-3.5 h-3.5 text-emerald-400" />
            VFO TUNING
          </span>
          <span className="text-[11px] text-emerald-400 font-mono">RX READY</span>
        </div>

        {isEditingFreq ? (
          <form onSubmit={handleDirectFreqSubmit} className="my-1">
            <input
              type="text"
              autoFocus
              placeholder="e.g. 101.1 or 162550000"
              value={directFreqInput}
              onChange={(e) => setDirectFreqInput(e.target.value)}
              onBlur={() => setIsEditingFreq(false)}
              className="w-full bg-slate-900 border border-emerald-500 text-emerald-400 font-mono text-xl text-center py-1.5 rounded focus:outline-none"
            />
          </form>
        ) : (
          <div
            id="vfo-frequency-display"
            onClick={() => {
              setIsEditingFreq(true);
              setDirectFreqInput((tunedFreqHz / 1e6).toFixed(4));
            }}
            title="Click to enter frequency directly"
            className="cursor-pointer group bg-black/60 border border-slate-800 hover:border-emerald-500/60 rounded-md p-2 text-center transition-all"
          >
            <div className="font-mono text-2xl font-bold tracking-wider text-emerald-400 group-hover:text-emerald-300">
              <span>{String(mhz).padStart(3, ' ')}</span>
              <span className="text-slate-600">.</span>
              <span>{String(khz).padStart(3, '0')}</span>
              <span className="text-slate-600">.</span>
              <span className="text-xs text-emerald-600">{String(hz).padStart(3, '0')}</span>
              <span className="text-xs ml-1 text-slate-400">MHz</span>
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">Click to type direct frequency</div>
          </div>
        )}

        {/* Memory Banks & Keypad Toggle */}
        <div className="flex gap-1.5 mt-2.5">
          <button
            id="open-memory-banks-panel-btn"
            onClick={onOpenMemoryBanks}
            className="flex-1 flex items-center justify-between p-2 bg-gradient-to-r from-amber-950/60 via-slate-900 to-sky-950/60 hover:from-amber-900/60 hover:to-sky-900/60 border border-amber-500/50 hover:border-amber-400 rounded-lg text-xs font-semibold text-amber-200 shadow-md shadow-amber-950/30 transition-all cursor-pointer group"
          >
            <div className="flex items-center gap-1.5">
              <Bookmark className="w-3.5 h-3.5 text-amber-400 group-hover:scale-110 transition-transform" />
              <span className="font-bold tracking-wide">BANKS</span>
            </div>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold">
              AU/HF
            </span>
          </button>

          <button
            id="toggle-numeric-keypad-btn"
            onClick={() => setShowKeypad(!showKeypad)}
            title="Toggle Direct Frequency Keypad"
            className={`px-3 py-2 rounded-lg border text-xs font-bold flex items-center gap-1 transition-all ${
              showKeypad
                ? 'bg-sky-500/20 border-sky-400 text-sky-300'
                : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
          >
            <Hash className="w-3.5 h-3.5" />
            <span>KEYPAD</span>
          </button>
        </div>

        {/* DIRECT NUMERIC KEYPAD */}
        {showKeypad && (
          <div className="mt-2.5 p-2 bg-slate-950/90 border border-slate-800 rounded-lg">
            <div className="flex items-center justify-between mb-1.5 px-1 text-[11px] text-slate-400">
              <span className="font-semibold text-slate-300 flex items-center gap-1">
                <Hash className="w-3 h-3 text-sky-400" />
                DIRECT ENTRY
              </span>
              <span className="font-mono text-emerald-400 font-bold">
                {directFreqInput ? `${directFreqInput} MHz` : 'Type or click'}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-1 mb-1.5">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'BS'].map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => handleKeypadPress(k)}
                  className={`py-1.5 text-xs font-mono font-bold rounded transition-colors ${
                    k === 'BS'
                      ? 'bg-rose-950/60 hover:bg-rose-900/80 text-rose-300 border border-rose-800/40 flex items-center justify-center'
                      : 'bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 hover:border-slate-700'
                  }`}
                >
                  {k === 'BS' ? <Delete className="w-3.5 h-3.5" /> : k}
                </button>
              ))}
            </div>

            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => handleKeypadPress('CLR')}
                className="w-1/3 py-1.5 text-[11px] font-bold rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
              >
                CLEAR
              </button>
              <button
                type="button"
                onClick={() => handleKeypadPress('ENTER')}
                className="flex-1 py-1.5 text-xs font-bold rounded bg-sky-600 hover:bg-sky-500 text-white shadow-md shadow-sky-900/30 flex items-center justify-center gap-1.5"
              >
                <CornerDownLeft className="w-3.5 h-3.5" />
                <span>TUNE (ENTER)</span>
              </button>
            </div>

            {/* Quick Step Buttons */}
            <div className="grid grid-cols-4 gap-1 mt-1.5 pt-1.5 border-t border-slate-800/80">
              <button onClick={() => stepFreq(-1000000)} className="py-1 text-[10px] font-mono font-semibold rounded bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800">-1M</button>
              <button onClick={() => stepFreq(1000000)}  className="py-1 text-[10px] font-mono font-semibold rounded bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800">+1M</button>
              <button onClick={() => stepFreq(-100000)}  className="py-1 text-[10px] font-mono font-semibold rounded bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800">-100k</button>
              <button onClick={() => stepFreq(100000)}   className="py-1 text-[10px] font-mono font-semibold rounded bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800">+100k</button>
              <button onClick={() => stepFreq(-10000)}   className="py-1 text-[10px] font-mono font-semibold rounded bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800">-10k</button>
              <button onClick={() => stepFreq(10000)}    className="py-1 text-[10px] font-mono font-semibold rounded bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800">+10k</button>
              <button onClick={() => stepFreq(-1000)}    className="py-1 text-[10px] font-mono font-semibold rounded bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800">-1k</button>
              <button onClick={() => stepFreq(1000)}     className="py-1 text-[10px] font-mono font-semibold rounded bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800">+1k</button>
            </div>
          </div>
        )}

        {/* Rotary Tuning Dial with UP & DOWN buttons */}
        <TuningDial
          tunedFreqHz={tunedFreqHz}
          onTuneFrequency={onTuneFrequency}
          disabled={!isStreaming}
        />
      </div>

      {/* 3. Demodulation Modes */}
      <div className="p-3 border-b border-slate-800">
        <div className="text-xs font-semibold tracking-wider text-slate-400 mb-2">DEMODULATION MODE</div>
        <div className="grid grid-cols-3 gap-1.5">
          {modes.map((m) => (
            <button
              key={m.mode}
              id={`mode-btn-${m.mode.toLowerCase()}`}
              title={m.desc}
              onClick={() => {
                let defaultBw = demodSettings.bandwidthHz;
                if (m.mode === 'WBFM') defaultBw = 180000;
                else if (m.mode === 'NBFM') defaultBw = 12500;
                else if (m.mode === 'AM') defaultBw = 10000;
                else if (m.mode === 'USB' || m.mode === 'LSB') defaultBw = 2800;
                else if (m.mode === 'CW') defaultBw = 500;

                onDemodSettingsChange({
                  ...demodSettings,
                  mode: m.mode,
                  bandwidthHz: defaultBw,
                });
              }}
              className={`py-1.5 text-xs font-bold rounded transition-colors ${
                demodSettings.mode === m.mode
                  ? 'bg-sky-500 text-white shadow-sm shadow-sky-500/30'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Filter Bandwidth */}
        <div className="mt-3">
          <div className="flex justify-between text-xs text-slate-400 mb-1">
            <span>Filter Bandwidth</span>
            <span className="font-mono text-cyan-400 font-bold">
              {(demodSettings.bandwidthHz / 1000).toFixed(1)} kHz
            </span>
          </div>
          <input
            type="range"
            min={200}
            max={demodSettings.mode === 'WBFM' ? 250000 : 30000}
            step={demodSettings.mode === 'WBFM' ? 5000 : 200}
            value={demodSettings.bandwidthHz}
            onChange={(e) =>
              onDemodSettingsChange({
                ...demodSettings,
                bandwidthHz: Number(e.target.value),
              })
            }
            className="w-full accent-cyan-400 h-1 bg-slate-700 rounded-lg cursor-pointer"
          />

          {/* Quick Bandwidth Presets */}
          <div className="grid grid-cols-4 gap-1 mt-2">
            {bandwidthPresets.map((bp) => (
              <button
                key={bp.label}
                type="button"
                onClick={() =>
                  onDemodSettingsChange({
                    ...demodSettings,
                    bandwidthHz: bp.val,
                  })
                }
                className={`py-0.5 px-1 text-[10px] font-mono rounded transition-colors ${
                  Math.abs(demodSettings.bandwidthHz - bp.val) < 200
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                {bp.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 4. Squelch & Signal Gate */}
      <div className="p-3 border-b border-slate-800">
        <div className="flex items-center justify-between text-xs mb-1">
          <span className="font-semibold text-slate-400">RF SQUELCH</span>
          <div className="flex items-center gap-1.5 font-mono">
            <span
              className={`w-2 h-2 rounded-full ${
                isSquelchOpen ? 'bg-emerald-400 shadow-sm shadow-emerald-400' : 'bg-rose-500'
              }`}
            />
            <span className={`text-[11px] ${isSquelchOpen ? 'text-emerald-400' : 'text-rose-400'}`}>
              {isSquelchOpen ? 'GATE OPEN' : 'MUTED'}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
          <span>Threshold</span>
          <span className="font-mono text-amber-400">{demodSettings.squelchDb} dBFS</span>
        </div>
        <input
          type="range"
          min={-100}
          max={-10}
          step={1}
          value={demodSettings.squelchDb}
          onChange={(e) =>
            onDemodSettingsChange({
              ...demodSettings,
              squelchDb: Number(e.target.value),
            })
          }
          className="w-full accent-amber-400 h-1 bg-slate-700 rounded-lg cursor-pointer"
        />
      </div>

      {/* 5. Audio Output & Volume */}
      <div className="p-3 border-b border-slate-800">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-400 mb-2">
          <span>AUDIO OUTPUT</span>
          <button
            onClick={() =>
              onDemodSettingsChange({
                ...demodSettings,
                isMuted: !demodSettings.isMuted,
              })
            }
            className={`p-1 rounded ${
              demodSettings.isMuted
                ? 'bg-rose-500/20 text-rose-400'
                : 'hover:bg-slate-800 text-slate-300'
            }`}
          >
            {demodSettings.isMuted ? (
              <VolumeX className="w-4 h-4" />
            ) : (
              <Volume2 className="w-4 h-4" />
            )}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={demodSettings.volume}
            onChange={(e) =>
              onDemodSettingsChange({
                ...demodSettings,
                volume: Number(e.target.value),
              })
            }
            className="w-full accent-sky-400 h-1 bg-slate-700 rounded-lg cursor-pointer"
          />
          <span className="text-xs font-mono text-sky-400 w-9 text-right">
            {Math.round(demodSettings.volume * 100)}%
          </span>
        </div>
      </div>

      {/* 6. Frequency Band Presets */}
      <div className="p-3 flex-1">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-400 mb-2">
          <span>STANDARD PRESETS</span>
          <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
        </div>
        <div className="space-y-1">
          {FREQUENCY_BANDS.map((band) => (
            <button
              key={band.id}
              onClick={() => handleSelectBand(band)}
              className="w-full text-left p-2 rounded bg-slate-800/40 hover:bg-slate-800 border border-slate-800/60 hover:border-slate-700 transition-colors flex items-center justify-between"
            >
              <div>
                <div className="text-xs font-medium text-slate-200">{band.name}</div>
                <div className="text-[10px] text-slate-500">{band.category}</div>
              </div>
              <span className="text-[11px] font-mono text-cyan-400 bg-cyan-950/40 px-1.5 py-0.5 rounded border border-cyan-800/40">
                {band.mode}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
