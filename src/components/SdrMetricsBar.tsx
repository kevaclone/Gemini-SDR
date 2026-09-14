import React from 'react';
import { Activity, Cpu, Usb, Zap } from 'lucide-react';

interface Props {
  snrDb: number;
  rssiDb: number;
  sampleRateHz: number;
  isStreaming: boolean;
  isWebUsb: boolean;
  deviceName: string;
}

export const SdrMetricsBar: React.FC<Props> = ({
  snrDb,
  rssiDb,
  sampleRateHz,
  isStreaming,
  isWebUsb,
  deviceName,
}) => {
  // S-meter calculation: S1 = -121 dBm, S9 = -73 dBm, S9+60 = -13 dBm
  // In dBFS, normalize between -100 and -20
  const normalizedPower = Math.max(0, Math.min(1, (rssiDb + 105) / 75));
  const sUnits = Math.min(9, Math.max(1, Math.floor(normalizedPower * 9)));
  const overNineDb = rssiDb > -73 ? Math.round(rssiDb - -73) : 0;

  return (
    <div id="sdr-metrics-bar" className="h-10 bg-[#070a10] border-t border-slate-800 px-3 flex items-center justify-between text-xs text-slate-400 select-none">
      {/* S-Meter & Signal Strength Indicator */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-emerald-400" />
          <span className="font-semibold text-slate-300">S-METER:</span>
          <span className="font-mono text-emerald-400 font-bold">
            {overNineDb > 0 ? `S9 +${overNineDb}dB` : `S${sUnits}`}
          </span>
        </div>

        {/* Segmented S-Meter Bar */}
        <div className="flex items-center gap-0.5 bg-slate-900 px-1.5 py-1 rounded border border-slate-800">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => (
            <div
              key={s}
              className={`w-1.5 h-3 rounded-xs ${
                s <= sUnits ? 'bg-emerald-500' : 'bg-slate-800'
              }`}
            />
          ))}
          {/* Over-9 dB segments */}
          {[10, 20, 30, 40, 50, 60].map((plus) => (
            <div
              key={plus}
              className={`w-1.5 h-3 rounded-xs ${
                overNineDb >= plus ? 'bg-rose-500' : 'bg-slate-800'
              }`}
            />
          ))}
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px]">
          <span>
            RSSI: <span className="text-cyan-400">{rssiDb.toFixed(1)} dBFS</span>
          </span>
          <span className="text-slate-600">|</span>
          <span>
            SNR: <span className="text-amber-400">{snrDb.toFixed(1)} dB</span>
          </span>
        </div>
      </div>

      {/* Hardware & Stream Throughput Status */}
      <div className="flex items-center gap-4 text-[11px]">
        <div className="flex items-center gap-1.5">
          <Cpu className="w-3.5 h-3.5 text-slate-500" />
          <span>SAMPLING:</span>
          <span className="font-mono text-slate-200">
            {(sampleRateHz / 1e6).toFixed(3)} MSPS ({(sampleRateHz * 2 / 1024 / 1024).toFixed(1)} MB/s)
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5 text-amber-400" />
          <span>GUI:</span>
          <span className="font-mono text-emerald-400">60.0 FPS</span>
        </div>

        {/* USB Device Status Badge */}
        <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded">
          <Usb className={`w-3 h-3 ${isWebUsb ? 'text-emerald-400' : 'text-sky-400'}`} />
          <span className={`font-mono text-[10px] ${isWebUsb ? 'text-emerald-300' : 'text-sky-300'}`}>
            {isStreaming ? (isWebUsb ? 'LIVE DONGLE' : 'RF SIMULATOR') : 'STANDBY'}
          </span>
        </div>
      </div>
    </div>
  );
};
