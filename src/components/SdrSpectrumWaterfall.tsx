import React, { useRef, useEffect, useState, useCallback } from 'react';
import { WaterfallSettings, DemodMode } from '../types';
import { ZoomIn, ZoomOut, Palette } from 'lucide-react';

interface Props {
  centerFreqHz: number;
  tunedFreqHz: number;
  sampleRateHz: number;
  bandwidthHz: number;
  demodMode: DemodMode;
  settings: WaterfallSettings;
  onSettingsChange: (settings: WaterfallSettings) => void;
  onTuneFrequency: (freqHz: number) => void;
  isStreaming: boolean;
}

// Color palette maps for waterfall
const COLOR_MAPS: Record<WaterfallSettings['colorMap'], (t: number) => [number, number, number]> = {
  turbo: (t) => {
    // Turbo rainbow colormap approximation
    const r = Math.min(255, Math.max(0, 255 * (1.5 * t)));
    const g = Math.min(255, Math.max(0, 255 * (4 * t * (1 - t))));
    const b = Math.min(255, Math.max(0, 255 * (1.5 * (1 - t))));
    return [r, g, b];
  },
  viridis: (t) => {
    const r = Math.min(255, Math.max(0, 255 * (t > 0.5 ? 2 * (t - 0.5) : 0)));
    const g = Math.min(255, Math.max(0, 255 * Math.sin(t * Math.PI)));
    const b = Math.min(255, Math.max(0, 255 * (1 - t * 0.7)));
    return [r, g, b];
  },
  plasma: (t) => {
    const r = Math.min(255, Math.max(0, 255 * Math.sin(t * Math.PI * 0.8)));
    const g = Math.min(255, Math.max(0, 255 * Math.pow(t, 2)));
    const b = Math.min(255, Math.max(0, 255 * Math.cos(t * Math.PI * 0.5)));
    return [r, g, b];
  },
  fire: (t) => {
    const r = Math.min(255, Math.max(0, 255 * (t * 2)));
    const g = Math.min(255, Math.max(0, 255 * Math.max(0, t * 2 - 0.7)));
    const b = Math.min(255, Math.max(0, 255 * Math.max(0, t * 3 - 2)));
    return [r, g, b];
  },
  sdr_classic: (t) => {
    // Dark Navy -> Cyan -> Green -> Yellow -> Red
    if (t < 0.25) {
      return [0, Math.round(t * 4 * 180), Math.round(50 + t * 4 * 200)];
    } else if (t < 0.5) {
      const f = (t - 0.25) * 4;
      return [0, Math.round(180 + f * 75), Math.round(250 * (1 - f))];
    } else if (t < 0.75) {
      const f = (t - 0.5) * 4;
      return [Math.round(f * 255), 255, 0];
    } else {
      const f = (t - 0.75) * 4;
      return [255, Math.round(255 * (1 - f)), 0];
    }
  },
};

export const SdrSpectrumWaterfall: React.FC<Props> = ({
  centerFreqHz,
  tunedFreqHz,
  sampleRateHz,
  bandwidthHz,
  demodMode,
  settings,
  onSettingsChange,
  onTuneFrequency,
  isStreaming,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const spectrumCanvasRef = useRef<HTMLCanvasElement>(null);
  const waterfallCanvasRef = useRef<HTMLCanvasElement>(null);

  const [hoverFreq, setHoverFreq] = useState<number | null>(null);
  const [hoverDbm, setHoverDbm] = useState<number | null>(null);
  const [isHovering, setIsHovering] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // Buffer state
  const prevSpectrumRef = useRef<Float32Array | null>(null);
  const peakHoldRef = useRef<Float32Array | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const phaseRef = useRef<number>(0);

  // Calculate frequency corresponding to an X coordinate
  const getFreqFromX = useCallback(
    (x: number, width: number): number => {
      const span = sampleRateHz;
      const startFreq = centerFreqHz - span / 2;
      const ratio = Math.max(0, Math.min(1, x / width));
      return Math.round(startFreq + ratio * span);
    },
    [centerFreqHz, sampleRateHz]
  );

  // Calculate X coordinate for a frequency
  const getXFromFreq = useCallback(
    (freq: number, width: number): number => {
      const span = sampleRateHz;
      const startFreq = centerFreqHz - span / 2;
      const ratio = (freq - startFreq) / span;
      return ratio * width;
    },
    [centerFreqHz, sampleRateHz]
  );

  // Mouse interaction for tuning
  const handlePointerDown = (e: React.PointerEvent) => {
    if (!spectrumCanvasRef.current) return;
    const rect = spectrumCanvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const newFreq = getFreqFromX(x, rect.width);
    onTuneFrequency(newFreq);
    setIsDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!spectrumCanvasRef.current) return;
    const rect = spectrumCanvasRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const freq = getFreqFromX(x, rect.width);
    const dbm = settings.maxDbm - (y / rect.height) * (settings.maxDbm - settings.minDbm);

    setHoverFreq(freq);
    setHoverDbm(Math.round(dbm));

    if (isDragging) {
      onTuneFrequency(freq);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    setIsDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  // Main Render Loop for 60 FPS Spectrum & Waterfall
  useEffect(() => {
    const specCanvas = spectrumCanvasRef.current;
    const wfallCanvas = waterfallCanvasRef.current;
    if (!specCanvas || !wfallCanvas) return;

    const specCtx = specCanvas.getContext('2d');
    const wfallCtx = wfallCanvas.getContext('2d');
    if (!specCtx || !wfallCtx) return;

    const fftSize = settings.fftSize;
    if (!prevSpectrumRef.current || prevSpectrumRef.current.length !== fftSize) {
      prevSpectrumRef.current = new Float32Array(fftSize);
      peakHoldRef.current = new Float32Array(fftSize);
      for (let i = 0; i < fftSize; i++) {
        prevSpectrumRef.current[i] = -105;
        peakHoldRef.current[i] = -115;
      }
    }

    const currentFft = new Float32Array(fftSize);
    const colorFn = COLOR_MAPS[settings.colorMap];

    let lastTime = performance.now();

    const render = () => {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      phaseRef.current += dt * 3;

      const width = specCanvas.width;
      const height = specCanvas.height;
      const wWidth = wfallCanvas.width;
      const wHeight = wfallCanvas.height;

      // Generate realistic dynamic RF spectrum bins
      const baseNoise = -98;
      const span = sampleRateHz;
      const tunedOffset = tunedFreqHz - centerFreqHz;
      const tunedBin = Math.floor(((tunedOffset + span / 2) / span) * fftSize);

      for (let i = 0; i < fftSize; i++) {
        // Natural thermal noise variation
        let binVal = baseNoise + (Math.random() - 0.5) * 6;

        // Tuned station carrier signal
        const distFromTuned = Math.abs(i - tunedBin);
        const signalWidth = Math.max(3, Math.floor((bandwidthHz / span) * fftSize));
        if (distFromTuned < signalWidth) {
          const peakHeight = 55 + Math.sin(phaseRef.current * 2) * 2;
          const decay = Math.exp(-Math.pow(distFromTuned / (signalWidth * 0.5), 2));
          binVal += peakHeight * decay;
        }

        // Add 2-3 ambient broadcast or repeater stations across the band
        const ambient1Bin = Math.floor(fftSize * 0.25);
        const dist1 = Math.abs(i - ambient1Bin);
        if (dist1 < 8) {
          binVal += 45 * Math.exp(-Math.pow(dist1 / 4, 2));
        }

        const ambient2Bin = Math.floor(fftSize * 0.72);
        const dist2 = Math.abs(i - ambient2Bin);
        if (dist2 < 12) {
          binVal += (38 + Math.sin(phaseRef.current * 4) * 4) * Math.exp(-Math.pow(dist2 / 5, 2));
        }

        // DC Center spike (common in RTL2832U zero-IF tuners)
        const centerBin = Math.floor(fftSize / 2);
        if (Math.abs(i - centerBin) <= 1) {
          binVal += 18;
        }

        // Smoothing
        if (prevSpectrumRef.current) {
          const smooth = settings.smoothing;
          currentFft[i] = prevSpectrumRef.current[i] * smooth + binVal * (1 - smooth);
          prevSpectrumRef.current[i] = currentFft[i];
        } else {
          currentFft[i] = binVal;
        }

        // Peak Hold
        if (peakHoldRef.current) {
          peakHoldRef.current[i] = Math.max(currentFft[i], peakHoldRef.current[i] - 0.15);
        }
      }

      // -------------------------------------------------------------
      // 1. Draw Spectrum Canvas
      // -------------------------------------------------------------
      specCtx.fillStyle = '#0a0d14';
      specCtx.fillRect(0, 0, width, height);

      // Grid Lines & dB Scale
      specCtx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      specCtx.lineWidth = 1;
      specCtx.font = '10px monospace';
      specCtx.fillStyle = '#55657e';

      const minDb = settings.minDbm;
      const maxDb = settings.maxDbm;
      const dbRange = maxDb - minDb;

      // Horizontal dB lines (-10, -20, -30... dBm)
      for (let db = -120; db <= 0; db += 20) {
        if (db >= minDb && db <= maxDb) {
          const y = height - ((db - minDb) / dbRange) * height;
          specCtx.beginPath();
          specCtx.moveTo(0, y);
          specCtx.lineTo(width, y);
          specCtx.stroke();
          specCtx.fillText(`${db} dBm`, 8, y - 3);
        }
      }

      // Vertical Frequency lines (every 250 kHz or 500 kHz)
      const freqStep = span > 2000000 ? 500000 : 250000;
      const startFreq = centerFreqHz - span / 2;
      const firstGridFreq = Math.ceil(startFreq / freqStep) * freqStep;

      for (let f = firstGridFreq; f < centerFreqHz + span / 2; f += freqStep) {
        const x = getXFromFreq(f, width);
        specCtx.beginPath();
        specCtx.moveTo(x, 0);
        specCtx.lineTo(x, height);
        specCtx.stroke();

        const fMhz = (f / 1000000).toFixed(3);
        specCtx.fillText(`${fMhz} MHz`, x + 4, height - 6);
      }

      // Demodulation Bandpass Filter Highlight
      const tunedX = getXFromFreq(tunedFreqHz, width);
      const halfBwPx = ((bandwidthHz / 2) / span) * width;
      specCtx.fillStyle = 'rgba(16, 185, 129, 0.12)';
      specCtx.strokeStyle = 'rgba(16, 185, 129, 0.6)';
      specCtx.lineWidth = 1;
      specCtx.fillRect(tunedX - halfBwPx, 0, halfBwPx * 2, height);
      specCtx.strokeRect(tunedX - halfBwPx, 0, halfBwPx * 2, height);

      // Center Frequency Marker (red dashed line)
      const centerX = width / 2;
      specCtx.setLineDash([4, 4]);
      specCtx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
      specCtx.beginPath();
      specCtx.moveTo(centerX, 0);
      specCtx.lineTo(centerX, height);
      specCtx.stroke();
      specCtx.setLineDash([]);

      // Tuned VFO Marker (solid bright green line)
      specCtx.strokeStyle = '#10b981';
      specCtx.lineWidth = 1.5;
      specCtx.beginPath();
      specCtx.moveTo(tunedX, 0);
      specCtx.lineTo(tunedX, height);
      specCtx.stroke();

      // Peak Hold Curve
      if (settings.peakHold && peakHoldRef.current) {
        specCtx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
        specCtx.lineWidth = 1;
        specCtx.beginPath();
        for (let i = 0; i < fftSize; i++) {
          const x = (i / fftSize) * width;
          const y = height - ((peakHoldRef.current[i] - minDb) / dbRange) * height;
          if (i === 0) specCtx.moveTo(x, y);
          else specCtx.lineTo(x, y);
        }
        specCtx.stroke();
      }

      // Live Spectrum Trace Curve
      const gradient = specCtx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, 'rgba(56, 189, 248, 0.35)');
      gradient.addColorStop(1, 'rgba(56, 189, 248, 0.02)');

      specCtx.beginPath();
      specCtx.moveTo(0, height);
      for (let i = 0; i < fftSize; i++) {
        const x = (i / fftSize) * width;
        const y = height - ((currentFft[i] - minDb) / dbRange) * height;
        if (i === 0) specCtx.lineTo(x, y);
        else specCtx.lineTo(x, y);
      }
      specCtx.lineTo(width, height);
      specCtx.closePath();
      specCtx.fillStyle = gradient;
      specCtx.fill();

      // Spectrum trace outline
      specCtx.strokeStyle = '#38bdf8';
      specCtx.lineWidth = 1.8;
      specCtx.beginPath();
      for (let i = 0; i < fftSize; i++) {
        const x = (i / fftSize) * width;
        const y = height - ((currentFft[i] - minDb) / dbRange) * height;
        if (i === 0) specCtx.moveTo(x, y);
        else specCtx.lineTo(x, y);
      }
      specCtx.stroke();

      // -------------------------------------------------------------
      // 2. Draw Waterfall Spectrogram
      // -------------------------------------------------------------
      // Shift existing waterfall image down by 1 pixel
      wfallCtx.drawImage(wfallCanvas, 0, 0, wWidth, wHeight - 1, 0, 1, wWidth, wHeight - 1);

      // Create new top row of pixels
      const rowImgData = wfallCtx.createImageData(wWidth, 1);
      const data = rowImgData.data;

      for (let x = 0; x < wWidth; x++) {
        const binIdx = Math.floor((x / wWidth) * fftSize);
        const db = currentFft[binIdx];
        const norm = Math.max(0, Math.min(1, (db - minDb) / dbRange));
        const [r, g, b] = colorFn(norm);

        const idx = x * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
      wfallCtx.putImageData(rowImgData, 0, 0);

      // Tuned VFO overlay line on waterfall
      wfallCtx.fillStyle = 'rgba(16, 185, 129, 0.4)';
      wfallCtx.fillRect(tunedX - 1, 0, 2, wHeight);

      if (isStreaming) {
        animFrameRef.current = requestAnimationFrame(render);
      }
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [centerFreqHz, tunedFreqHz, sampleRateHz, bandwidthHz, demodMode, settings, isStreaming, getXFromFreq]);

  // Handle ResizeObserver to keep canvas resolution crisp
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          const specHeight = Math.floor(height * 0.45);
          const wfallHeight = Math.floor(height * 0.55);

          if (spectrumCanvasRef.current) {
            spectrumCanvasRef.current.width = Math.floor(width);
            spectrumCanvasRef.current.height = specHeight;
          }
          if (waterfallCanvasRef.current) {
            waterfallCanvasRef.current.width = Math.floor(width);
            waterfallCanvasRef.current.height = wfallHeight;
          }
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div id="spectrum-waterfall-container" className="flex flex-col h-full w-full bg-[#080a0f] relative select-none overflow-hidden">
      {/* Top Toolbar Overlay for Spectrum Settings */}
      <div id="spectrum-toolbar" className="flex items-center justify-between px-3 py-1.5 bg-[#0e131d]/90 border-b border-slate-800 text-xs text-slate-300 z-10">
        <div className="flex items-center gap-3">
          <span className="font-mono text-emerald-400 font-medium">
            CENTER: {(centerFreqHz / 1e6).toFixed(4)} MHz
          </span>
          <span className="text-slate-500">|</span>
          <span className="font-mono text-cyan-400 font-medium">
            SPAN: {(sampleRateHz / 1e6).toFixed(3)} MSPS
          </span>
          <span className="text-slate-500">|</span>
          <span className="font-mono text-amber-400">
            BW: {(bandwidthHz / 1e3).toFixed(1)} kHz
          </span>
          {hoverFreq && isHovering && (
            <span className="bg-slate-800 px-2 py-0.5 rounded text-sky-300 font-mono">
              {(hoverFreq / 1e6).toFixed(4)} MHz ({hoverDbm} dBm)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Colormap Selector */}
          <div className="flex items-center gap-1">
            <Palette className="w-3.5 h-3.5 text-slate-400" />
            <select
              id="waterfall-colormap-select"
              value={settings.colorMap}
              onChange={(e) => onSettingsChange({ ...settings, colorMap: e.target.value as WaterfallSettings['colorMap'] })}
              className="bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded px-1.5 py-0.5 focus:outline-none focus:border-sky-500 cursor-pointer"
            >
              <option value="turbo">Turbo Spectrum</option>
              <option value="sdr_classic">Classic SDR</option>
              <option value="viridis">Viridis</option>
              <option value="plasma">Plasma</option>
              <option value="fire">Fire Thermal</option>
            </select>
          </div>

          {/* Peak Hold Toggle */}
          <button
            id="toggle-peak-hold-btn"
            onClick={() => onSettingsChange({ ...settings, peakHold: !settings.peakHold })}
            className={`px-2 py-0.5 rounded text-xs transition-colors ${
              settings.peakHold ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' : 'bg-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            Peak Hold
          </button>

          {/* Zoom In/Out Sample Rate */}
          <button
            id="zoom-out-btn"
            title="Increase Span (Zoom Out)"
            onClick={() => {
              const rates = [250000, 1024000, 1800000, 2048000, 2400000, 2560000];
              const idx = rates.indexOf(sampleRateHz);
              if (idx < rates.length - 1) onSettingsChange({ ...settings, zoomLevel: idx + 1 });
            }}
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            id="zoom-in-btn"
            title="Narrow Span (Zoom In)"
            onClick={() => {
              const rates = [250000, 1024000, 1800000, 2048000, 2400000, 2560000];
              const idx = rates.indexOf(sampleRateHz);
              if (idx > 0) onSettingsChange({ ...settings, zoomLevel: idx - 1 });
            }}
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Dual Canvas Stage */}
      <div
        ref={containerRef}
        id="spectrum-canvas-stage"
        className="flex-1 flex flex-col relative cursor-crosshair overflow-hidden"
        onPointerEnter={() => setIsHovering(true)}
        onPointerLeave={() => {
          setIsHovering(false);
          setHoverFreq(null);
          setHoverDbm(null);
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Upper Spectrum Analyzer Canvas */}
        <canvas
          ref={spectrumCanvasRef}
          id="spectrum-fft-canvas"
          className="w-full flex-1"
        />

        {/* Divider bar */}
        <div className="h-1 bg-slate-800 w-full relative z-10 flex items-center justify-center">
          <div className="w-12 h-0.5 bg-slate-600 rounded-full" />
        </div>

        {/* Lower Waterfall Canvas */}
        <canvas
          ref={waterfallCanvasRef}
          id="waterfall-spectrogram-canvas"
          className="w-full flex-1"
        />

        {/* Hover tuning indicator line */}
        {isHovering && hoverFreq && containerRef.current && (
          <div
            className="absolute top-0 bottom-0 pointer-events-none border-l border-sky-400/40 z-20"
            style={{
              left: `${getXFromFreq(hoverFreq, containerRef.current.clientWidth)}px`,
            }}
          />
        )}
      </div>
    </div>
  );
};
