import { DemodMode } from '../types';

export interface AudioStreamStatus {
  status: 'idle' | 'buffering' | 'playing' | 'fallback' | 'error';
  serviceName?: string;
  streamUrl?: string;
  sourceType: 'live_stream' | 'custom_url' | 'file' | 'synth';
  error?: string;
  bitrateKbps?: number;
}

export type StatusListener = (status: AudioStreamStatus) => void;
export type LevelListener = (levels: { leftRms: number; rightRms: number; peakDb: number }) => void;

class SdrAudioEngine {
  private ctx: AudioContext | null = null;
  private isRunning: boolean = false;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private noiseNode: AudioBufferSourceNode | null = null;
  private noiseGain: GainNode | null = null;
  private toneOsc: OscillatorNode | null = null;
  private toneGain: GainNode | null = null;
  private bpfFilter: BiquadFilterNode | null = null;
  private cwTimer: number | null = null;

  // Live Stream Decoding Engine
  private streamAudio: HTMLAudioElement | null = null;
  private streamSourceNode: MediaElementAudioSourceNode | null = null;
  private streamGain: GainNode | null = null;
  private currentStreamUrl: string = '';
  private currentDabService: string = '';
  private customStreamUrl: string = '';
  private isCustomStreamActive: boolean = false;
  private isPlayingFile: boolean = false;

  // Level & Status Monitoring
  private statusListeners: Set<StatusListener> = new Set();
  private levelListeners: Set<LevelListener> = new Set();
  private currentStatus: AudioStreamStatus = {
    status: 'idle',
    sourceType: 'none' as any,
  };
  private meterInterval: number | null = null;

  // Recording Subsystem
  private recorderDestination: MediaStreamAudioDestinationNode | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private isRecordingActive: boolean = false;
  private recordingStopResolver: ((blob: Blob | null) => void) | null = null;

  // Speech Announcement Debounce
  private lastSpokenStation: string = '';
  private speechUtterance: SpeechSynthesisUtterance | null = null;

  public async start(): Promise<void> {
    if (this.isRunning && this.ctx) {
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      return;
    }

    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

    this.ctx = new AudioContextClass({ latencyHint: 'playback' });

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    // Audio Output Limiter / Compressor
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.setValueAtTime(-12.0, this.ctx.currentTime);
    this.compressor.knee.setValueAtTime(6.0, this.ctx.currentTime);
    this.compressor.ratio.setValueAtTime(4.0, this.ctx.currentTime);
    this.compressor.attack.setValueAtTime(0.005, this.ctx.currentTime);
    this.compressor.release.setValueAtTime(0.1, this.ctx.currentTime);
    this.compressor.connect(this.ctx.destination);

    // Audio Analyser for VU & Level Metering
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;
    this.analyser.connect(this.compressor);

    // Master Gain
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.4, this.ctx.currentTime);
    this.masterGain.connect(this.analyser);

    // Bandpass filter for analog SDR demodulation
    this.bpfFilter = this.ctx.createBiquadFilter();
    this.bpfFilter.type = 'bandpass';
    this.bpfFilter.frequency.setValueAtTime(2500, this.ctx.currentTime);
    this.bpfFilter.Q.setValueAtTime(1.0, this.ctx.currentTime);
    this.bpfFilter.connect(this.masterGain);

    // RF static noise buffer generator (for analog modes AM/FM/SSB)
    const bufferSize = this.ctx.sampleRate * 2;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = (Math.random() * 2 - 1) * 0.08;
    }

    this.noiseNode = this.ctx.createBufferSource();
    this.noiseNode.buffer = noiseBuffer;
    this.noiseNode.loop = true;

    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

    this.noiseNode.connect(this.noiseGain);
    this.noiseGain.connect(this.bpfFilter);
    this.noiseNode.start();

    // Sidetone oscillator (reserved exclusively for CW Morse code)
    this.toneOsc = this.ctx.createOscillator();
    this.toneOsc.type = 'sine';
    this.toneOsc.frequency.setValueAtTime(700, this.ctx.currentTime);

    this.toneGain = this.ctx.createGain();
    this.toneGain.gain.setValueAtTime(0.0, this.ctx.currentTime);
    this.toneOsc.connect(this.toneGain);
    this.toneGain.connect(this.masterGain);
    this.toneOsc.start();

    // Initialize HTML5 Audio Streaming Element
    this.setupStreamAudioElement();

    // Start Level Monitoring loop
    this.startLevelMonitoring();

    this.isRunning = true;
  }

  private setupStreamAudioElement(): void {
    if (this.streamAudio) return;

    this.streamAudio = new Audio();
    this.streamAudio.crossOrigin = 'anonymous';
    this.streamAudio.preload = 'auto';

    this.streamAudio.addEventListener('loadstart', () => {
      this.updateStatus({
        status: 'buffering',
        serviceName: this.currentDabService,
        streamUrl: this.currentStreamUrl,
        sourceType: this.isCustomStreamActive ? 'custom_url' : 'live_stream',
      });
    });

    this.streamAudio.addEventListener('canplay', () => {
      this.updateStatus({
        status: 'playing',
        serviceName: this.currentDabService,
        streamUrl: this.currentStreamUrl,
        sourceType: this.isCustomStreamActive ? 'custom_url' : 'live_stream',
      });
    });

    this.streamAudio.addEventListener('playing', () => {
      this.updateStatus({
        status: 'playing',
        serviceName: this.currentDabService,
        streamUrl: this.currentStreamUrl,
        sourceType: this.isCustomStreamActive ? 'custom_url' : 'live_stream',
      });
    });

    this.streamAudio.addEventListener('waiting', () => {
      this.updateStatus({
        status: 'buffering',
        serviceName: this.currentDabService,
        streamUrl: this.currentStreamUrl,
        sourceType: this.isCustomStreamActive ? 'custom_url' : 'live_stream',
      });
    });

    this.streamAudio.addEventListener('error', (e) => {
      console.warn('Audio stream error or network block:', e);
      this.handleStreamFallback('Stream network or CORS restriction');
    });

    // Attempt to route through WebAudio if AudioContext is available
    if (this.ctx && this.masterGain) {
      try {
        this.streamGain = this.ctx.createGain();
        this.streamGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
        this.streamSourceNode = this.ctx.createMediaElementSource(this.streamAudio);
        this.streamSourceNode.connect(this.streamGain);
        this.streamGain.connect(this.masterGain);
      } catch (err) {
        // Fallback: If createMediaElementSource is blocked by CORS, stream plays directly via HTMLAudioElement
        console.log('Audio element direct routing mode (CORS-safe fallback active)');
      }
    }
  }

  private startLevelMonitoring(): void {
    if (this.meterInterval) return;

    const dataArray = new Uint8Array(64);
    this.meterInterval = window.setInterval(() => {
      if (!this.analyser || this.levelListeners.size === 0) return;

      this.analyser.getByteFrequencyData(dataArray);

      let sum = 0;
      let max = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const val = dataArray[i] / 255;
        sum += val * val;
        if (val > max) max = val;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      const peakDb = max > 0 ? 20 * Math.log10(max) : -60;

      // When stream is playing directly through HTMLAudioElement:
      let leftLevel = rms;
      let rightLevel = rms * 0.95;

      if (this.currentStatus.status === 'playing') {
        leftLevel = Math.max(0.18, leftLevel);
        rightLevel = Math.max(0.16, rightLevel);
      }

      this.levelListeners.forEach((listener) => {
        listener({
          leftRms: Math.min(1.0, leftLevel),
          rightRms: Math.min(1.0, rightLevel),
          peakDb: Math.max(-60, peakDb),
        });
      });
    }, 80);
  }

  public subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  public subscribeLevels(listener: LevelListener): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  private updateStatus(status: AudioStreamStatus): void {
    this.currentStatus = status;
    this.statusListeners.forEach((listener) => listener(status));
  }

  private handleStreamFallback(reason: string): void {
    this.updateStatus({
      status: 'fallback',
      serviceName: this.currentDabService,
      streamUrl: this.currentStreamUrl,
      sourceType: 'synth',
      error: reason,
    });

    // Provide clear spoken station confirmation if available
    if (
      'speechSynthesis' in window &&
      this.currentDabService &&
      this.lastSpokenStation !== this.currentDabService
    ) {
      this.lastSpokenStation = this.currentDabService;
      try {
        window.speechSynthesis.cancel();
        const text = `Tuned to ${this.currentDabService}, Brisbane Digital Radio DAB Plus.`;
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.05;
        utterance.pitch = 1.0;
        utterance.volume = 0.6;
        window.speechSynthesis.speak(utterance);
      } catch {
        // ignore speech error
      }
    }
  }

  public stop(): void {
    if (!this.isRunning || !this.ctx) return;

    if (this.cwTimer) {
      window.clearInterval(this.cwTimer);
      this.cwTimer = null;
    }

    if (this.meterInterval) {
      window.clearInterval(this.meterInterval);
      this.meterInterval = null;
    }

    if (this.streamAudio) {
      this.streamAudio.pause();
      this.streamAudio.src = '';
    }

    try {
      this.noiseNode?.stop();
      this.toneOsc?.stop();
      this.ctx.close();
    } catch {
      // ignore
    }

    this.ctx = null;
    this.isRunning = false;
    this.updateStatus({ status: 'idle', sourceType: 'none' as any });
  }

  public updateParameters(params: {
    freqHz: number;
    mode: DemodMode;
    bandwidthHz: number;
    volume: number;
    isMuted: boolean;
    squelchDb: number;
    snrDb: number;
    dabService?: {
      name: string;
      genre: string;
      bitrateKbps: number;
      streamUrl?: string;
      codec?: string;
    };
  }): void {
    if (!this.isRunning || !this.ctx || !this.masterGain || !this.noiseGain || !this.toneGain || !this.bpfFilter) {
      return;
    }

    const t = this.ctx.currentTime;
    const isSignalOpen = params.snrDb > params.squelchDb + 100;
    const targetVol = params.isMuted ? 0 : Math.max(0, Math.min(1, params.volume)) * 0.75;

    // Apply master volume
    this.masterGain.gain.setTargetAtTime(targetVol, t, 0.04);
    if (this.streamAudio) {
      this.streamAudio.volume = params.isMuted ? 0 : Math.max(0, Math.min(1, params.volume));
    }

    // -------------------------------------------------------------
    // DAB+ Mode - Real Decoded Broadcast Stream
    // -------------------------------------------------------------
    if (params.mode === 'DAB+') {
      // Mute all test tones and noise oscillators
      this.noiseGain.gain.setTargetAtTime(0, t, 0.02);
      this.toneGain.gain.setTargetAtTime(0, t, 0.02);
      if (this.cwTimer) {
        window.clearInterval(this.cwTimer);
        this.cwTimer = null;
      }

      if (!isSignalOpen) {
        // Digital Squelch Mute
        if (this.streamAudio && !this.streamAudio.paused) {
          this.streamAudio.pause();
        }
        this.updateStatus({
          status: 'idle',
          serviceName: params.dabService?.name,
          sourceType: 'live_stream',
        });
        return;
      }

      // Signal is locked and active DAB+ service is selected
      const service = params.dabService;
      if (service) {
        const streamToPlay = this.customStreamUrl || service.streamUrl;
        const serviceName = service.name;

        if (this.currentDabService !== serviceName || this.currentStreamUrl !== streamToPlay) {
          this.currentDabService = serviceName;
          this.currentStreamUrl = streamToPlay || '';

          if (streamToPlay && this.streamAudio) {
            try {
              this.streamAudio.src = streamToPlay;
              this.streamAudio.play().catch((err) => {
                console.log('Stream auto-play waiting for user interaction:', err);
              });
              this.updateStatus({
                status: 'buffering',
                serviceName: serviceName,
                streamUrl: streamToPlay,
                sourceType: this.isCustomStreamActive ? 'custom_url' : 'live_stream',
                bitrateKbps: service.bitrateKbps,
              });
            } catch (err) {
              this.handleStreamFallback('Unable to load broadcast URL');
            }
          } else {
            this.handleStreamFallback('No broadcast URL configured for this service');
          }
        } else if (this.streamAudio && this.streamAudio.paused && streamToPlay) {
          this.streamAudio.play().catch(() => {});
        }
      }
      return;
    }

    // -------------------------------------------------------------
    // Non-DAB+ Modes (WBFM, NBFM, AM, SSB, CW)
    // -------------------------------------------------------------
    // Pause DAB+ stream when leaving DAB+
    if (this.streamAudio && !this.streamAudio.paused && !this.isCustomStreamActive) {
      this.streamAudio.pause();
      this.currentDabService = '';
    }

    this.bpfFilter.type = 'bandpass';

    if (params.mode === 'CW') {
      this.bpfFilter.frequency.setTargetAtTime(700, t, 0.05);
      this.bpfFilter.Q.setTargetAtTime(4.0, t, 0.05);
      this.noiseGain.gain.setTargetAtTime(isSignalOpen ? 0.02 : 0.18, t, 0.05);

      if (isSignalOpen) {
        this.toneOsc?.frequency.setTargetAtTime(700, t, 0.05);
        if (!this.cwTimer) {
          let step = 0;
          const morsePattern = [1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 0, 0];
          this.cwTimer = window.setInterval(() => {
            if (this.toneGain && this.ctx) {
              const val = morsePattern[step % morsePattern.length] ? 0.2 : 0.0;
              this.toneGain.gain.setTargetAtTime(val, this.ctx.currentTime, 0.008);
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
    } else if (params.mode === 'WBFM') {
      // Clean FM broadcast band filter
      this.bpfFilter.frequency.setTargetAtTime(8000, t, 0.05);
      this.bpfFilter.Q.setTargetAtTime(0.5, t, 0.05);
      if (this.cwTimer) {
        window.clearInterval(this.cwTimer);
        this.cwTimer = null;
      }
      this.toneGain.gain.setTargetAtTime(0, t, 0.05);

      if (isSignalOpen) {
        this.noiseGain.gain.setTargetAtTime(0.01, t, 0.05);
      } else {
        this.noiseGain.gain.setTargetAtTime(0.24, t, 0.05);
      }
    } else if (params.mode === 'NBFM') {
      this.bpfFilter.frequency.setTargetAtTime(2200, t, 0.05);
      this.bpfFilter.Q.setTargetAtTime(1.5, t, 0.05);
      if (this.cwTimer) {
        window.clearInterval(this.cwTimer);
        this.cwTimer = null;
      }
      this.toneGain.gain.setTargetAtTime(0, t, 0.05);

      if (isSignalOpen) {
        this.noiseGain.gain.setTargetAtTime(0.02, t, 0.05);
      } else {
        this.noiseGain.gain.setTargetAtTime(params.squelchDb < -90 ? 0.22 : 0.0, t, 0.05);
      }
    } else {
      // AM / SSB
      this.bpfFilter.frequency.setTargetAtTime(1800, t, 0.05);
      this.bpfFilter.Q.setTargetAtTime(2.0, t, 0.05);
      if (this.cwTimer) {
        window.clearInterval(this.cwTimer);
        this.cwTimer = null;
      }
      this.toneGain.gain.setTargetAtTime(0, t, 0.05);
      this.noiseGain.gain.setTargetAtTime(isSignalOpen ? 0.05 : 0.2, t, 0.05);
    }
  }

  // -----------------------------------------------------------------
  // User Stream / Audio File Injection Capabilities
  // -----------------------------------------------------------------
  public setCustomStreamUrl(url: string): void {
    this.customStreamUrl = url.trim();
    this.isCustomStreamActive = !!this.customStreamUrl;

    if (this.streamAudio) {
      if (this.isCustomStreamActive) {
        this.streamAudio.src = this.customStreamUrl;
        this.streamAudio.play().catch(() => {});
        this.updateStatus({
          status: 'buffering',
          serviceName: 'Custom Audio Stream',
          streamUrl: this.customStreamUrl,
          sourceType: 'custom_url',
        });
      } else {
        this.streamAudio.pause();
        this.currentStreamUrl = '';
      }
    }
  }

  public async playAudioFile(file: File): Promise<void> {
    await this.start();
    const objectUrl = URL.createObjectURL(file);
    this.isPlayingFile = true;
    this.isCustomStreamActive = true;
    this.customStreamUrl = objectUrl;

    if (this.streamAudio) {
      this.streamAudio.src = objectUrl;
      this.streamAudio.play().catch(() => {});
      this.updateStatus({
        status: 'playing',
        serviceName: file.name,
        streamUrl: objectUrl,
        sourceType: 'file',
      });
    }
  }

  // -----------------------------------------------------------------
  // Built-in Audio Output Recorder (Save 10s clip to WAV/WebM)
  // -----------------------------------------------------------------
  public startRecording(): boolean {
    if (!this.ctx || !this.masterGain || this.isRecordingActive) return false;

    try {
      this.recorderDestination = this.ctx.createMediaStreamDestination();
      this.masterGain.connect(this.recorderDestination);

      // If streamAudio is playing directly (fallback mode), add it to recorder stream
      if (this.streamAudio && !this.streamSourceNode) {
        try {
          const streamAudioNode = this.ctx.createMediaElementSource(this.streamAudio);
          streamAudioNode.connect(this.recorderDestination);
        } catch {
          // already connected or restricted
        }
      }

      this.recordedChunks = [];
      const options = MediaRecorder.isTypeSupported('audio/webm')
        ? { mimeType: 'audio/webm' }
        : undefined;

      this.mediaRecorder = new MediaRecorder(this.recorderDestination.stream, options);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const mime = this.mediaRecorder?.mimeType || 'audio/webm';
        const blob = new Blob(this.recordedChunks, { type: mime });
        if (this.recordingStopResolver) {
          this.recordingStopResolver(blob);
          this.recordingStopResolver = null;
        }
      };

      this.mediaRecorder.start(200);
      this.isRecordingActive = true;
      return true;
    } catch (err) {
      console.error('Failed to start audio recorder:', err);
      return false;
    }
  }

  public stopRecording(): Promise<Blob | null> {
    return new Promise((resolve) => {
      if (!this.isRecordingActive || !this.mediaRecorder) {
        resolve(null);
        return;
      }

      this.recordingStopResolver = resolve;
      this.mediaRecorder.stop();
      this.isRecordingActive = false;
    });
  }

  public getIsRecording(): boolean {
    return this.isRecordingActive;
  }

  public getCurrentStatus(): AudioStreamStatus {
    return this.currentStatus;
  }
}

export const sdrAudioEngine = new SdrAudioEngine();
