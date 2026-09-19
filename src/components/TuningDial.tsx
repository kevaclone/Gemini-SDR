import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  ChevronUp,
  ChevronDown,
  Lock,
  Unlock,
  Zap,
  RotateCcw,
} from 'lucide-react';

interface Props {
  tunedFreqHz: number;
  onTuneFrequency: (freqHz: number) => void;
  disabled?: boolean;
}

const STEP_OPTIONS = [
  { label: '10 Hz', value: 10 },
  { label: '100 Hz', value: 100 },
  { label: '1 kHz', value: 1000 },
  { label: '5 kHz', value: 5000 },
  { label: '6.25k', value: 6250 },
  { label: '10 kHz', value: 10000 },
  { label: '12.5k', value: 12500 }, // UHF CB & VHF standard
  { label: '25 kHz', value: 25000 }, // Airband & Marine standard
  { label: '100k', value: 100000 },
  { label: '1 MHz', value: 1000000 },
];

export const TuningDial: React.FC<Props> = ({
  tunedFreqHz,
  onTuneFrequency,
  disabled = false,
}) => {
  const [stepSizeHz, setStepSizeHz] = useState<number>(10000); // Default 10 kHz
  const [isFastMode, setIsFastMode] = useState<boolean>(false);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [rotationAngle, setRotationAngle] = useState<number>(0);
  const [isTickActive, setIsTickActive] = useState<boolean>(false);

  // References for drag rotation
  const dialRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const lastAngleRef = useRef<number>(0);
  const accumulatedDeltaRef = useRef<number>(0);

  // Auto-repeat timers for UP and DOWN buttons
  const repeatTimerRef = useRef<NodeJS.Timeout | null>(null);
  const repeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const repeatSpeedRef = useRef<number>(120);

  const effectiveStep = isFastMode ? stepSizeHz * 10 : stepSizeHz;

  // Trigger brief visual tick indicator
  const triggerTickAnimation = useCallback(() => {
    setIsTickActive(true);
    setTimeout(() => setIsTickActive(false), 50);
  }, []);

  // Single step frequency change
  const applyStep = useCallback(
    (direction: 1 | -1) => {
      if (isLocked || disabled) return;
      const delta = direction * effectiveStep;
      const next = Math.max(100000, Math.min(1800000000, tunedFreqHz + delta));
      onTuneFrequency(next);

      // Rotate dial visually
      setRotationAngle((prev) => (prev + direction * 15) % 360);
      triggerTickAnimation();
    },
    [isLocked, disabled, effectiveStep, tunedFreqHz, onTuneFrequency, triggerTickAnimation]
  );

  // Mouse wheel tuning on dial
  const handleWheel = (e: React.WheelEvent) => {
    if (isLocked || disabled) return;
    e.preventDefault();
    const direction = e.deltaY < 0 ? 1 : -1;
    applyStep(direction);
  };

  // Start continuous hold-to-repeat
  const startContinuousStep = (direction: 1 | -1) => {
    if (isLocked || disabled) return;
    applyStep(direction);

    stopContinuousStep();
    repeatSpeedRef.current = 120;

    // After initial delay of 250ms, start stepping rapidly
    repeatTimerRef.current = setTimeout(() => {
      let count = 0;
      repeatIntervalRef.current = setInterval(() => {
        applyStep(direction);
        count++;
        // Accelerate progressively after 8 steps
        if (count > 8 && repeatSpeedRef.current > 30) {
          repeatSpeedRef.current = Math.max(25, repeatSpeedRef.current - 15);
          if (repeatIntervalRef.current) {
            clearInterval(repeatIntervalRef.current);
            repeatIntervalRef.current = setInterval(() => {
              applyStep(direction);
            }, repeatSpeedRef.current);
          }
        }
      }, repeatSpeedRef.current);
    }, 250);
  };

  const stopContinuousStep = () => {
    if (repeatTimerRef.current) {
      clearTimeout(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
    }
  };

  // Drag interaction for rotary dial
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isLocked || disabled) return;
    if (!dialRef.current) return;

    isDraggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const rect = dialRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const currentAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);
    lastAngleRef.current = currentAngle;
    accumulatedDeltaRef.current = 0;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || isLocked || disabled || !dialRef.current) return;

    const rect = dialRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const currentAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);

    let deltaAngle = currentAngle - lastAngleRef.current;
    if (deltaAngle > 180) deltaAngle -= 360;
    if (deltaAngle < -180) deltaAngle += 360;

    lastAngleRef.current = currentAngle;
    accumulatedDeltaRef.current += deltaAngle;

    setRotationAngle((prev) => (prev + deltaAngle) % 360);

    // Each 9 degrees of rotation triggers 1 frequency step
    const degreesPerStep = 9;
    if (Math.abs(accumulatedDeltaRef.current) >= degreesPerStep) {
      const steps = Math.trunc(accumulatedDeltaRef.current / degreesPerStep);
      accumulatedDeltaRef.current -= steps * degreesPerStep;
      const deltaHz = steps * effectiveStep;
      const next = Math.max(100000, Math.min(1800000000, tunedFreqHz + deltaHz));
      onTuneFrequency(next);
      triggerTickAnimation();
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    isDraggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore if not captured
    }
  };

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      stopContinuousStep();
    };
  }, []);

  // Generate 24 tick markers around the dial perimeter
  const ticks = Array.from({ length: 24 }, (_, i) => i * 15);

  return (
    <div id="tuning-dial-panel" className="bg-[#090d15] border border-slate-800/90 rounded-lg p-2.5 mt-2">
      {/* Header with Lock, Fast Mode & Step info */}
      <div className="flex items-center justify-between text-xs mb-2">
        <div className="flex items-center gap-1.5">
          <span className="font-mono font-bold text-slate-300 text-[11px] uppercase tracking-wider flex items-center gap-1">
            <RotateCcw className="w-3 h-3 text-cyan-400" />
            VFO Optical Dial
          </span>
          <span
            className={`w-1.5 h-1.5 rounded-full transition-colors ${
              isTickActive ? 'bg-cyan-300 shadow-sm shadow-cyan-300' : 'bg-slate-700'
            }`}
          />
        </div>

        <div className="flex items-center gap-1">
          {/* Fast Step Mode 10x */}
          <button
            onClick={() => setIsFastMode(!isFastMode)}
            title="Fast Step 10x Multiplier"
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold flex items-center gap-0.5 transition-colors cursor-pointer border ${
              isFastMode
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-sm shadow-amber-500/20'
                : 'bg-slate-800 text-slate-400 border-slate-700/60 hover:text-slate-200'
            }`}
          >
            <Zap className="w-2.5 h-2.5" />
            <span>FAST</span>
          </button>

          {/* Dial Lock */}
          <button
            onClick={() => setIsLocked(!isLocked)}
            title={isLocked ? 'VFO Dial Locked (Click to unlock)' : 'Lock VFO Dial'}
            className={`p-1 rounded transition-colors cursor-pointer border ${
              isLocked
                ? 'bg-rose-500/20 text-rose-400 border-rose-500/40'
                : 'bg-slate-800 text-slate-400 border-slate-700/60 hover:text-slate-200'
            }`}
          >
            {isLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Center Tuning Section: [DOWN Button] - [Rotary Dial Wheel] - [UP Button] */}
      <div className="flex items-center justify-between gap-2 px-1">
        {/* DOWN Button */}
        <button
          id="vfo-step-down-btn"
          disabled={isLocked || disabled}
          onMouseDown={() => startContinuousStep(-1)}
          onMouseUp={stopContinuousStep}
          onMouseLeave={stopContinuousStep}
          onTouchStart={() => startContinuousStep(-1)}
          onTouchEnd={stopContinuousStep}
          title="Step Frequency Down (Click or Hold to scan down)"
          className={`flex-1 h-28 rounded-lg flex flex-col items-center justify-center gap-1.5 transition-all border select-none cursor-pointer ${
            isLocked
              ? 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed opacity-50'
              : 'bg-gradient-to-b from-[#131b2c] to-[#0a0f19] hover:from-[#1c273e] hover:to-[#101726] active:from-cyan-950 active:to-[#080d16] border-slate-700/80 text-slate-200 shadow-lg shadow-black/50 active:scale-[0.98]'
          }`}
        >
          <ChevronDown className="w-6 h-6 text-cyan-400 transition-transform group-hover:translate-y-0.5" />
          <span className="text-xs font-mono font-extrabold tracking-widest text-cyan-300">DOWN</span>
          <span className="text-[11px] font-mono font-extrabold text-amber-300 bg-amber-950/60 px-2 py-0.5 rounded border border-amber-700/50 shadow-inner">
            -{effectiveStep >= 1000000 ? `${effectiveStep / 1000000}M` : effectiveStep >= 1000 ? `${effectiveStep / 1000}k` : `${effectiveStep}Hz`}
          </span>
        </button>

        {/* Rotary Dial Center Wheel (Large 112px) */}
        <div
          ref={dialRef}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          title="Scroll mouse wheel or click and drag to spin tuning dial"
          className={`relative w-28 h-28 rounded-full flex items-center justify-center cursor-grab active:cursor-grabbing transition-transform select-none touch-none shrink-0 ${
            isLocked ? 'cursor-not-allowed opacity-60' : ''
          }`}
          style={{
            background: 'radial-gradient(circle, #1e283d 0%, #0e1422 65%, #060912 100%)',
            boxShadow: '0 6px 20px rgba(0,0,0,0.7), inset 0 2px 4px rgba(255,255,255,0.12), inset 0 -4px 8px rgba(0,0,0,0.85), 0 0 0 2px #2a3b56',
          }}
        >
          {/* Tick marks ring */}
          <div
            className="absolute inset-0 rounded-full pointer-events-none transition-transform"
            style={{ transform: `rotate(${rotationAngle}deg)` }}
          >
            {ticks.map((tickAngle) => (
              <div
                key={tickAngle}
                className="absolute top-0 left-1/2 -translate-x-1/2 w-0.5 h-2.5"
                style={{
                  transformOrigin: '50% 56px',
                  transform: `rotate(${tickAngle}deg)`,
                  backgroundColor: tickAngle % 45 === 0 ? '#38bdf8' : '#64748b',
                }}
              />
            ))}
          </div>

          {/* Inner Knob Texture & Finger Dimple */}
          <div
            className="w-20 h-20 rounded-full flex items-center justify-center relative transition-transform"
            style={{
              transform: `rotate(${rotationAngle}deg)`,
              background: 'radial-gradient(circle, #293855 0%, #172133 70%, #0c121e 100%)',
              boxShadow: 'inset 0 2px 5px rgba(255,255,255,0.18), 0 3px 10px rgba(0,0,0,0.75)',
              border: '1.5px solid #3b4d6b',
            }}
          >
            {/* Optical Finger Dimple Indicator */}
            <div
              className="absolute top-2.5 w-4 h-4 rounded-full shadow-inner border border-sky-600/40"
              style={{
                background: 'radial-gradient(circle, #0c1422 30%, #1e2b40 100%)',
                boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.95), 0 0 6px rgba(56, 189, 248, 0.6)',
              }}
            >
              <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 mx-auto mt-1 shadow-sm shadow-cyan-300" />
            </div>

            {/* Center Cap with Needle */}
            <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-[#0a0f18] to-[#1e293b] border border-slate-600/80 flex items-center justify-center shadow-md">
              <div className="w-2 h-2 rounded-full bg-cyan-400 shadow-sm shadow-cyan-400" />
            </div>
          </div>
        </div>

        {/* UP Button */}
        <button
          id="vfo-step-up-btn"
          disabled={isLocked || disabled}
          onMouseDown={() => startContinuousStep(1)}
          onMouseUp={stopContinuousStep}
          onMouseLeave={stopContinuousStep}
          onTouchStart={() => startContinuousStep(1)}
          onTouchEnd={stopContinuousStep}
          title="Step Frequency Up (Click or Hold to scan up)"
          className={`flex-1 h-28 rounded-lg flex flex-col items-center justify-center gap-1.5 transition-all border select-none cursor-pointer ${
            isLocked
              ? 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed opacity-50'
              : 'bg-gradient-to-b from-[#131b2c] to-[#0a0f19] hover:from-[#1c273e] hover:to-[#101726] active:from-cyan-950 active:to-[#080d16] border-slate-700/80 text-slate-200 shadow-lg shadow-black/50 active:scale-[0.98]'
          }`}
        >
          <ChevronUp className="w-6 h-6 text-cyan-400 transition-transform group-hover:-translate-y-0.5" />
          <span className="text-xs font-mono font-extrabold tracking-widest text-cyan-300">UP</span>
          <span className="text-[11px] font-mono font-extrabold text-emerald-300 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-700/50 shadow-inner">
            +{effectiveStep >= 1000000 ? `${effectiveStep / 1000000}M` : effectiveStep >= 1000 ? `${effectiveStep / 1000}k` : `${effectiveStep}Hz`}
          </span>
        </button>
      </div>

      {/* Step Size Selector Tabs */}
      <div className="mt-3 pt-2.5 border-t border-slate-800/80">
        <div className="flex items-center justify-between text-[11px] text-slate-300 mb-1.5 font-medium">
          <span className="font-semibold uppercase tracking-wider text-slate-400">Step Resolution</span>
          <span className="font-mono text-cyan-400 font-bold">
            {effectiveStep >= 1000000
              ? `${(effectiveStep / 1000000).toFixed(1)} MHz`
              : effectiveStep >= 1000
              ? `${(effectiveStep / 1000).toFixed(effectiveStep % 1000 !== 0 ? 2 : 0)} kHz`
              : `${effectiveStep} Hz`}
            {isFastMode && <span className="text-amber-400 ml-1">(10x)</span>}
          </span>
        </div>

        <div className="grid grid-cols-5 gap-1.5 text-[11px] font-mono">
          {STEP_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStepSizeHz(opt.value)}
              disabled={isLocked}
              className={`py-1.5 rounded text-center font-bold transition-all border cursor-pointer ${
                stepSizeHz === opt.value
                  ? 'bg-gradient-to-r from-sky-600 to-cyan-600 text-white border-sky-400 shadow-md shadow-sky-900/40'
                  : 'bg-slate-900/90 hover:bg-slate-800 text-cyan-300 hover:text-white border-slate-800 hover:border-cyan-500/40'
              } ${isLocked ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
