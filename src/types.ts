export type DemodMode = 'WBFM' | 'NBFM' | 'AM' | 'USB' | 'LSB' | 'CW';

export interface FrequencyBand {
  id: string;
  name: string;
  category: 'Broadcast' | 'Aviation' | 'Amateur' | 'Public Safety' | 'Marine' | 'Utility';
  freqHz: number;
  mode: DemodMode;
  bandwidthHz: number;
  description: string;
}

export interface SdrDeviceState {
  isConnected: boolean;
  isStreaming: boolean;
  deviceName: string;
  isWebUsb: boolean;
  tunerType: string;
  centerFreqHz: number;
  vfoOffsetHz: number;
  actualFreqHz: number;
  sampleRateHz: number;
  gainMode: 'auto' | 'manual';
  tunerGainDb: number;
  rtlAgc: boolean;
  directSampling: 'disabled' | 'I-branch' | 'Q-branch';
  ppmCorrection: number;
  biasT: boolean;
}

export interface DemodSettings {
  mode: DemodMode;
  bandwidthHz: number;
  squelchDb: number;
  volume: number;
  isMuted: boolean;
  audioFilter: boolean;
  deemphasisUs: 50 | 75 | 0;
  cwPitchHz: number;
  agcSpeed: 'fast' | 'medium' | 'slow' | 'off';
}

export interface WaterfallSettings {
  fftSize: number;
  fftRateFps: number;
  minDbm: number;
  maxDbm: number;
  colorMap: 'turbo' | 'viridis' | 'plasma' | 'fire' | 'sdr_classic';
  peakHold: boolean;
  smoothing: number;
  zoomLevel: number;
}

export interface CppProjectFile {
  path: string;
  title: string;
  category: 'source' | 'header' | 'vs_project' | 'build_script' | 'docs';
  description: string;
  content: string;
}

export interface MemoryChannel {
  id: string;
  name: string;
  freqHz: number;
  mode: DemodMode;
  bandwidthHz: number;
  locationOrService?: string;
  notes?: string;
  tags?: string[];
  bankId: string;
  isCustom?: boolean;
}

export interface MemoryBank {
  id: string;
  name: string;
  description: string;
  iconName?: string;
  channels: MemoryChannel[];
}
