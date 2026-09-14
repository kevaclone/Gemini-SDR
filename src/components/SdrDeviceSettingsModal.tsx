import React, { useState } from 'react';
import { SdrDeviceState } from '../types';
import { webUsbManager, WebUsbStatus } from '../services/webusbRtlsdr';
import { X, Usb, Cpu, Zap, AlertCircle, CheckCircle2 } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  deviceState: SdrDeviceState;
  onDeviceStateChange: (state: SdrDeviceState) => void;
}

// Discrete RTL2832U + R820T2 gain steps in tenths of a dB
const GAIN_STEPS_DB = [
  0.0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9,
  25.4, 28.0, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48.0, 49.6,
];

const SAMPLE_RATES_HZ = [
  { label: '0.250 MSPS (Narrowband)', val: 250000 },
  { label: '0.960 MSPS (Low Bandwidth)', val: 960000 },
  { label: '1.024 MSPS (Clean Spectrum)', val: 1024000 },
  { label: '1.400 MSPS (Aviation Band)', val: 1400000 },
  { label: '1.800 MSPS (General VHF)', val: 1800000 },
  { label: '2.048 MSPS (Recommended)', val: 2048000 },
  { label: '2.400 MSPS (Wideband FM)', val: 2400000 },
  { label: '2.560 MSPS (Max Safe RTL)', val: 2560000 },
];

export const SdrDeviceSettingsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  deviceState,
  onDeviceStateChange,
}) => {
  const [usbStatus, setUsbStatus] = useState<WebUsbStatus | null>(null);
  const [isConnectingUsb, setIsConnectingUsb] = useState<boolean>(false);

  if (!isOpen) return null;

  const handleConnectUsb = async () => {
    setIsConnectingUsb(true);
    await webUsbManager.requestAndConnect((status) => {
      setUsbStatus(status);
      if (status.isConnected) {
        onDeviceStateChange({
          ...deviceState,
          isWebUsb: true,
          deviceName: status.deviceName,
        });
      }
    });
    setIsConnectingUsb(false);
  };

  const handleDisconnectUsb = async () => {
    await webUsbManager.disconnect();
    setUsbStatus(null);
    onDeviceStateChange({
      ...deviceState,
      isWebUsb: false,
      deviceName: 'RTL2832U (Simulated RF)',
    });
  };

  return (
    <div id="sdr-hardware-modal" className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#0e131e] border border-slate-700 rounded-lg w-full max-w-xl text-slate-200 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-[#090d15]">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-sky-400" />
            <span className="font-semibold text-base text-slate-100">
              RTL-SDR / RTL2832U Hardware Configuration
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-100 rounded hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto">
          {/* Physical USB Dongle Detection Card */}
          <div className="p-3.5 bg-slate-900/90 rounded-md border border-slate-800 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Usb className="w-4 h-4 text-emerald-400" />
                <span className="text-sm font-semibold text-slate-200">
                  Physical WebUSB Connection
                </span>
              </div>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                VID: 0x0BDA / PID: 0x2838
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Plug in your real RTL-SDR USB dongle (RTL2832U / R820T2) to stream live RF signals
              directly via WebUSB. If unplugged, the built-in simulated RF generator will engage automatically.
            </p>

            <div className="flex items-center gap-3 mt-1">
              {deviceState.isWebUsb ? (
                <button
                  onClick={handleDisconnectUsb}
                  className="px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded text-xs font-semibold transition-colors"
                >
                  Disconnect USB Dongle
                </button>
              ) : (
                <button
                  onClick={handleConnectUsb}
                  disabled={isConnectingUsb}
                  className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded text-xs font-semibold transition-colors flex items-center gap-1.5"
                >
                  <Usb className="w-3.5 h-3.5" />
                  <span>{isConnectingUsb ? 'Connecting...' : 'Connect RTL-SDR USB Dongle'}</span>
                </button>
              )}

              {usbStatus && (
                <div className="flex items-center gap-1 text-xs">
                  {usbStatus.isConnected ? (
                    <span className="text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Connected: {usbStatus.deviceName}
                    </span>
                  ) : (
                    <span className="text-amber-400 flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5" />
                      {usbStatus.errorMessage || 'Dongle not selected'}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Gain Controls */}
          <div className="space-y-3">
            <div className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
              RF Gain Stages
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 p-2.5 bg-slate-850 rounded border border-slate-800 cursor-pointer hover:bg-slate-800">
                <input
                  type="checkbox"
                  checked={deviceState.gainMode === 'auto'}
                  onChange={(e) =>
                    onDeviceStateChange({
                      ...deviceState,
                      gainMode: e.target.checked ? 'auto' : 'manual',
                    })
                  }
                  className="accent-sky-500 rounded"
                />
                <span className="text-xs font-medium">Tuner AGC (Automatic)</span>
              </label>

              <label className="flex items-center gap-2 p-2.5 bg-slate-850 rounded border border-slate-800 cursor-pointer hover:bg-slate-800">
                <input
                  type="checkbox"
                  checked={deviceState.rtlAgc}
                  onChange={(e) =>
                    onDeviceStateChange({
                      ...deviceState,
                      rtlAgc: e.target.checked,
                    })
                  }
                  className="accent-sky-500 rounded"
                />
                <span className="text-xs font-medium">RTL2832 Hardware AGC</span>
              </label>
            </div>

            {deviceState.gainMode === 'manual' && (
              <div className="p-3 bg-slate-900 rounded border border-slate-800">
                <div className="flex justify-between text-xs text-slate-300 mb-1.5">
                  <span>Manual Tuner Gain (LNA/Mixer/VGA)</span>
                  <span className="font-mono text-emerald-400 font-bold">
                    {deviceState.tunerGainDb.toFixed(1)} dB
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={GAIN_STEPS_DB.length - 1}
                  step={1}
                  value={GAIN_STEPS_DB.indexOf(deviceState.tunerGainDb)}
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    onDeviceStateChange({
                      ...deviceState,
                      tunerGainDb: GAIN_STEPS_DB[idx],
                    });
                  }}
                  className="w-full accent-emerald-500 h-1.5 bg-slate-700 rounded-lg cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-500 mt-1">
                  <span>0.0 dB</span>
                  <span>25.4 dB</span>
                  <span>49.6 dB</span>
                </div>
              </div>
            )}
          </div>

          {/* Sample Rate */}
          <div>
            <label className="block text-xs font-semibold tracking-wider text-slate-400 uppercase mb-1.5">
              Sample Rate (RF Bandwidth)
            </label>
            <select
              value={deviceState.sampleRateHz}
              onChange={(e) =>
                onDeviceStateChange({
                  ...deviceState,
                  sampleRateHz: Number(e.target.value),
                })
              }
              className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-md px-3 py-2 focus:outline-none focus:border-sky-500"
            >
              {SAMPLE_RATES_HZ.map((sr) => (
                <option key={sr.val} value={sr.val}>
                  {sr.label}
                </option>
              ))}
            </select>
          </div>

          {/* PPM Frequency Correction */}
          <div>
            <div className="flex justify-between text-xs text-slate-300 mb-1">
              <span className="font-semibold uppercase tracking-wider text-slate-400">
                Frequency Correction (PPM Offset)
              </span>
              <span className="font-mono text-cyan-400 font-bold">
                {deviceState.ppmCorrection > 0 ? `+${deviceState.ppmCorrection}` : deviceState.ppmCorrection} PPM
              </span>
            </div>
            <input
              type="range"
              min={-150}
              max={150}
              step={1}
              value={deviceState.ppmCorrection}
              onChange={(e) =>
                onDeviceStateChange({
                  ...deviceState,
                  ppmCorrection: Number(e.target.value),
                })
              }
              className="w-full accent-cyan-500 h-1.5 bg-slate-700 rounded-lg cursor-pointer"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Calibrate oscillator drift (standard RTL-SDR v3 dongles have 1 PPM TCXO).
            </p>
          </div>

          {/* Direct Sampling & Bias-T */}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div>
              <label className="block text-xs font-semibold tracking-wider text-slate-400 uppercase mb-1">
                Direct Sampling (HF 0-30 MHz)
              </label>
              <select
                value={deviceState.directSampling}
                onChange={(e) =>
                  onDeviceStateChange({
                    ...deviceState,
                    directSampling: e.target.value as SdrDeviceState['directSampling'],
                  })
                }
                className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-md px-2.5 py-1.5 focus:outline-none"
              >
                <option value="disabled">Disabled (VHF/UHF Tuner)</option>
                <option value="I-branch">I-Branch (Direct)</option>
                <option value="Q-branch">Q-Branch (RTL-SDR v3 HF)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold tracking-wider text-slate-400 uppercase mb-1">
                4.5V Bias-Tee Power
              </label>
              <button
                onClick={() =>
                  onDeviceStateChange({
                    ...deviceState,
                    biasT: !deviceState.biasT,
                  })
                }
                className={`w-full py-1.5 px-3 rounded text-xs font-medium border transition-colors flex items-center justify-center gap-1.5 ${
                  deviceState.biasT
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-slate-900 text-slate-400 border-slate-700 hover:bg-slate-800'
                }`}
              >
                <Zap className="w-3.5 h-3.5" />
                <span>{deviceState.biasT ? 'Bias-T ON (4.5V Active)' : 'Bias-T OFF'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-[#090d15] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded text-xs font-semibold transition-colors"
          >
            Apply & Close
          </button>
        </div>
      </div>
    </div>
  );
};
