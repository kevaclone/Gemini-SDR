import { DemodMode } from '../types';

class SdrAudioEngine {
  private ctx: AudioContext | null = null;
  private isRunning: boolean = false;
  private masterGain: GainNode | null = null;
  private noiseNode: AudioBufferSourceNode | null = null;
  private noiseGain: GainNode | null = null;
  private toneOsc: OscillatorNode | null = null;
  private toneGain: GainNode | null = null;
  private bpfFilter: BiquadFilterNode | null = null;
  private cwTimer: number | null = null;
  private airbandTimer: number | null = null;

  public async start(): Promise<void> {
    if (this.isRunning && this.ctx) return;

    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioContextClass();

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.5, this.ctx.currentTime);
    this.masterGain.connect(this.ctx.destination);

    // Audio bandpass filter matching SDR demodulation bandwidth
    this.bpfFilter = this.ctx.createBiquadFilter();
    this.bpfFilter.type = 'bandpass';
    this.bpfFilter.frequency.setValueAtTime(2500, this.ctx.currentTime);
    this.bpfFilter.Q.setValueAtTime(1.0, this.ctx.currentTime);
    this.bpfFilter.connect(this.masterGain);

    // RF static noise buffer generator
    const bufferSize = this.ctx.sampleRate * 2;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = (Math.random() * 2 - 1) * 0.15;
    }

    this.noiseNode = this.ctx.createBufferSource();
    this.noiseNode.buffer = noiseBuffer;
    this.noiseNode.loop = true;

    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.setValueAtTime(0.2, this.ctx.currentTime);

    this.noiseNode.connect(this.noiseGain);
    this.noiseGain.connect(this.bpfFilter);
    this.noiseNode.start();

    // Secondary carrier/tone oscillator
    this.toneOsc = this.ctx.createOscillator();
    this.toneOsc.type = 'sine';
    this.toneOsc.frequency.setValueAtTime(700, this.ctx.currentTime);

    this.toneGain = this.ctx.createGain();
    this.toneGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

    this.toneOsc.connect(this.toneGain);
    this.toneGain.connect(this.masterGain);
    this.toneOsc.start();

    this.isRunning = true;
  }

  public stop(): void {
    if (!this.isRunning || !this.ctx) return;
    if (this.cwTimer) window.clearInterval(this.cwTimer);
    if (this.airbandTimer) window.clearInterval(this.airbandTimer);

    try {
      this.noiseNode?.stop();
      this.toneOsc?.stop();
      this.ctx.close();
    } catch {
      // ignore
    }

    this.ctx = null;
    this.isRunning = false;
  }

  public updateParameters(params: {
    freqHz: number;
    mode: DemodMode;
    bandwidthHz: number;
    volume: number;
    isMuted: boolean;
    squelchDb: number;
    snrDb: number;
  }): void {
    if (!this.isRunning || !this.ctx || !this.masterGain || !this.noiseGain || !this.toneGain || !this.bpfFilter) return;

    const t = this.ctx.currentTime;

    // Volume & Mute
    const targetVol = params.isMuted ? 0 : Math.max(0, Math.min(1, params.volume));
    this.masterGain.gain.setTargetAtTime(targetVol, t, 0.05);

    // Squelch evaluation
    const isSignalOpen = params.snrDb > (params.squelchDb + 100);

    // Configure filter based on mode
    if (params.mode === 'WBFM') {
      this.bpfFilter.frequency.setTargetAtTime(7500, t, 0.05);
      this.bpfFilter.Q.setTargetAtTime(0.5, t, 0.05);
      if (isSignalOpen) {
        // Broadcast audio profile (clean melodic tones + stereo carrier)
        this.noiseGain.gain.setTargetAtTime(0.04, t, 0.05);
        this.toneOsc?.frequency.setTargetAtTime(440, t, 0.05);
        this.toneGain.gain.setTargetAtTime(0.12, t, 0.05);
      } else {
        // High static noise
        this.noiseGain.gain.setTargetAtTime(0.35, t, 0.05);
        this.toneGain.gain.setTargetAtTime(0, t, 0.05);
      }
    } else if (params.mode === 'CW') {
      this.bpfFilter.frequency.setTargetAtTime(700, t, 0.05);
      this.bpfFilter.Q.setTargetAtTime(5.0, t, 0.05);
      this.noiseGain.gain.setTargetAtTime(isSignalOpen ? 0.02 : 0.2, t, 0.05);

      if (isSignalOpen) {
        this.toneOsc?.frequency.setTargetAtTime(700, t, 0.05);
        // Morse dits and dahs simulation
        if (!this.cwTimer) {
          let step = 0;
          const morsePattern = [1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 0, 0];
          this.cwTimer = window.setInterval(() => {
            if (this.toneGain && this.ctx) {
              const val = morsePattern[step % morsePattern.length] ? 0.25 : 0.0;
              this.toneGain.gain.setValueAtTime(val, this.ctx.currentTime);
              step++;
            }
          }, 120);
        }
      } else {
        if (this.cwTimer) {
          window.clearInterval(this.cwTimer);
          this.cwTimer = null;
        }
        this.toneGain.gain.setTargetAtTime(0, t, 0.05);
      }
    } else if (params.mode === 'NBFM') {
      this.bpfFilter.frequency.setTargetAtTime(2200, t, 0.05);
      this.bpfFilter.Q.setTargetAtTime(1.5, t, 0.05);
      if (this.cwTimer) {
        window.clearInterval(this.cwTimer);
        this.cwTimer = null;
      }

      if (isSignalOpen) {
        // Clean speech presence
        this.noiseGain.gain.setTargetAtTime(0.015, t, 0.05);
        this.toneGain.gain.setTargetAtTime(0.08, t, 0.05);
        this.toneOsc?.frequency.setTargetAtTime(320, t, 0.05);
      } else {
        // Squelched quiet or full hiss
        this.noiseGain.gain.setTargetAtTime(params.squelchDb < -90 ? 0.25 : 0.0, t, 0.05);
        this.toneGain.gain.setTargetAtTime(0, t, 0.05);
      }
    } else {
      // AM / SSB
      this.bpfFilter.frequency.setTargetAtTime(1800, t, 0.05);
      this.bpfFilter.Q.setTargetAtTime(2.0, t, 0.05);
      if (this.cwTimer) {
        window.clearInterval(this.cwTimer);
        this.cwTimer = null;
      }
      this.noiseGain.gain.setTargetAtTime(isSignalOpen ? 0.06 : 0.25, t, 0.05);
      this.toneGain.gain.setTargetAtTime(isSignalOpen ? 0.07 : 0, t, 0.05);
      this.toneOsc?.frequency.setTargetAtTime(params.mode === 'USB' ? 1200 : 800, t, 0.05);
    }
  }
}

export const sdrAudioEngine = new SdrAudioEngine();
