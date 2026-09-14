import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  MemoryBank,
  MemoryChannel,
  DemodMode,
} from '../types';
import { DEFAULT_MEMORY_BANKS } from '../data/memoryBanks';
import {
  X,
  Search,
  Radio,
  Bookmark,
  Plus,
  Play,
  Pause,
  Trash2,
  Edit3,
  Download,
  Upload,
  RotateCcw,
  Plane,
  RadioTower,
  Anchor,
  HeartPulse,
  CloudRain,
  Train,
  Satellite,
  Check,
  Tag,
  Volume2,
} from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentFreqHz: number;
  currentMode: DemodMode;
  currentBandwidthHz: number;
  onTuneChannel: (freqHz: number, mode: DemodMode, bandwidthHz: number) => void;
}

const STORAGE_KEY = 'rtlsdr_memory_banks_v1';

export const MemoryBankManagerModal: React.FC<Props> = ({
  isOpen,
  onClose,
  currentFreqHz,
  currentMode,
  currentBandwidthHz,
  onTuneChannel,
}) => {
  // Load banks from localStorage or initialize with DEFAULT_MEMORY_BANKS
  const [banks, setBanks] = useState<MemoryBank[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (e) {
      console.warn('Failed to load memory banks from localStorage:', e);
    }
    return DEFAULT_MEMORY_BANKS;
  });

  const [selectedBankId, setSelectedBankId] = useState<string>('brisbane-air');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanIndex, setScanIndex] = useState<number>(0);

  // New / Edit Channel Modal State
  const [isAddModalOpen, setIsAddModalOpen] = useState<boolean>(false);
  const [editingChannel, setEditingChannel] = useState<MemoryChannel | null>(null);
  const [targetBankId, setTargetBankId] = useState<string>(selectedBankId);
  const [inputName, setInputName] = useState<string>('');
  const [inputFreqMhz, setInputFreqMhz] = useState<string>('');
  const [inputMode, setInputMode] = useState<DemodMode>('NBFM');
  const [inputBandwidthKhz, setInputBandwidthKhz] = useState<string>('12.5');
  const [inputLocation, setInputLocation] = useState<string>('');
  const [inputNotes, setInputNotes] = useState<string>('');
  const [inputTags, setInputTags] = useState<string>('');

  // Status notification
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // Persist banks whenever updated
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(banks));
    } catch (e) {
      console.warn('Failed to save memory banks to localStorage:', e);
    }
  }, [banks]);

  // Current selected bank object
  const activeBank = useMemo(() => {
    return banks.find((b) => b.id === selectedBankId) || banks[0];
  }, [banks, selectedBankId]);

  // Filtered channels within current bank or all banks if searching
  const displayedChannels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return activeBank ? activeBank.channels : [];
    }

    // If search active, search through all banks
    const results: MemoryChannel[] = [];
    banks.forEach((bank) => {
      bank.channels.forEach((ch) => {
        const freqMhzStr = (ch.freqHz / 1e6).toFixed(4);
        const freqKhzStr = (ch.freqHz / 1e3).toFixed(1);
        const match =
          ch.name.toLowerCase().includes(q) ||
          freqMhzStr.includes(q) ||
          freqKhzStr.includes(q) ||
          ch.mode.toLowerCase().includes(q) ||
          (ch.locationOrService && ch.locationOrService.toLowerCase().includes(q)) ||
          (ch.notes && ch.notes.toLowerCase().includes(q)) ||
          (ch.tags && ch.tags.some((t) => t.toLowerCase().includes(q))) ||
          bank.name.toLowerCase().includes(q);
        if (match) {
          results.push(ch);
        }
      });
    });
    return results;
  }, [banks, activeBank, searchQuery]);

  // Scanner loop
  const scanTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!isScanning) {
      if (scanTimerRef.current) clearInterval(scanTimerRef.current);
      return;
    }

    if (displayedChannels.length === 0) {
      setIsScanning(false);
      return;
    }

    scanTimerRef.current = setInterval(() => {
      setScanIndex((prevIdx) => {
        const nextIdx = (prevIdx + 1) % displayedChannels.length;
        const target = displayedChannels[nextIdx];
        if (target) {
          onTuneChannel(target.freqHz, target.mode, target.bandwidthHz);
        }
        return nextIdx;
      });
    }, 1800);

    return () => {
      if (scanTimerRef.current) clearInterval(scanTimerRef.current);
    };
  }, [isScanning, displayedChannels, onTuneChannel]);

  // Quick action: Save current VFO
  const handleOpenSaveCurrentVfo = () => {
    setEditingChannel(null);
    setTargetBankId(selectedBankId);
    setInputName(`VFO ${(currentFreqHz / 1e6).toFixed(3)} MHz`);
    setInputFreqMhz((currentFreqHz / 1e6).toFixed(4));
    setInputMode(currentMode);
    setInputBandwidthKhz((currentBandwidthHz / 1e3).toFixed(1));
    setInputLocation('Tuned from VFO receiver');
    setInputNotes(`Saved ${new Date().toLocaleDateString()}`);
    setInputTags('Custom, VFO');
    setIsAddModalOpen(true);
  };

  // Open Edit Channel
  const handleOpenEdit = (ch: MemoryChannel) => {
    setEditingChannel(ch);
    setTargetBankId(ch.bankId);
    setInputName(ch.name);
    setInputFreqMhz((ch.freqHz / 1e6).toFixed(4));
    setInputMode(ch.mode);
    setInputBandwidthKhz((ch.bandwidthHz / 1e3).toFixed(1));
    setInputLocation(ch.locationOrService || '');
    setInputNotes(ch.notes || '');
    setInputTags(ch.tags ? ch.tags.join(', ') : '');
    setIsAddModalOpen(true);
  };

  // Save Channel Submit
  const handleSaveChannelSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const freqMhz = parseFloat(inputFreqMhz);
    if (isNaN(freqMhz) || freqMhz <= 0) {
      alert('Please enter a valid frequency in MHz');
      return;
    }

    const freqHz = Math.round(freqMhz * 1e6);
    const bwKhz = parseFloat(inputBandwidthKhz);
    const bandwidthHz = isNaN(bwKhz) ? 12500 : Math.round(bwKhz * 1e3);

    const tagsArray = inputTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const newChannel: MemoryChannel = {
      id: editingChannel ? editingChannel.id : `ch-custom-${Date.now()}`,
      bankId: targetBankId,
      name: inputName.trim() || `Channel ${(freqHz / 1e6).toFixed(3)} MHz`,
      freqHz,
      mode: inputMode,
      bandwidthHz,
      locationOrService: inputLocation.trim() || undefined,
      notes: inputNotes.trim() || undefined,
      tags: tagsArray.length > 0 ? tagsArray : undefined,
      isCustom: true,
    };

    setBanks((prevBanks) => {
      return prevBanks.map((b) => {
        if (editingChannel && b.id === editingChannel.bankId && editingChannel.bankId !== targetBankId) {
          // Channel moved to a different bank: remove from old bank
          return {
            ...b,
            channels: b.channels.filter((c) => c.id !== editingChannel.id),
          };
        }
        if (b.id === targetBankId) {
          if (editingChannel) {
            // Updating existing channel
            const exists = b.channels.some((c) => c.id === editingChannel.id);
            if (exists) {
              return {
                ...b,
                channels: b.channels.map((c) => (c.id === editingChannel.id ? newChannel : c)),
              };
            } else {
              return {
                ...b,
                channels: [newChannel, ...b.channels],
              };
            }
          } else {
            // New channel
            return {
              ...b,
              channels: [newChannel, ...b.channels],
            };
          }
        }
        return b;
      });
    });

    setIsAddModalOpen(false);
    showToast(`Channel "${newChannel.name}" saved!`);
  };

  // Delete Channel
  const handleDeleteChannel = (ch: MemoryChannel) => {
    if (!confirm(`Are you sure you want to delete "${ch.name}"?`)) return;
    setBanks((prev) =>
      prev.map((b) =>
        b.id === ch.bankId ? { ...b, channels: b.channels.filter((c) => c.id !== ch.id) } : b
      )
    );
    showToast(`Channel "${ch.name}" removed`);
  };

  // Restore Defaults
  const handleRestoreDefaults = () => {
    if (confirm('Reset all frequency memory banks to default Australian & international presets?')) {
      setBanks(DEFAULT_MEMORY_BANKS);
      localStorage.removeItem(STORAGE_KEY);
      showToast('All memory banks reset to standard presets');
    }
  };

  // Export JSON
  const handleExportJson = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(banks, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `rtlsdr_memory_banks_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showToast('Memory banks exported as JSON file');
  };

  // Import JSON
  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileReader = new FileReader();
    if (e.target.files && e.target.files[0]) {
      fileReader.readAsText(e.target.files[0], 'UTF-8');
      fileReader.onload = (event) => {
        try {
          const parsed = JSON.parse(event.target?.result as string);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setBanks(parsed);
            showToast('Memory banks successfully imported!');
          } else {
            alert('Invalid JSON memory banks format');
          }
        } catch {
          alert('Failed to parse JSON file');
        }
      };
    }
  };

  // Icon selector helper
  const getBankIcon = (iconName?: string) => {
    switch (iconName) {
      case 'Plane':
        return <Plane className="w-4 h-4 text-sky-400" />;
      case 'RadioTower':
        return <RadioTower className="w-4 h-4 text-amber-400" />;
      case 'Anchor':
        return <Anchor className="w-4 h-4 text-cyan-400" />;
      case 'HeartPulse':
        return <HeartPulse className="w-4 h-4 text-rose-400" />;
      case 'CloudRain':
        return <CloudRain className="w-4 h-4 text-blue-400" />;
      case 'Train':
        return <Train className="w-4 h-4 text-emerald-400" />;
      case 'Satellite':
        return <Satellite className="w-4 h-4 text-purple-400" />;
      default:
        return <Radio className="w-4 h-4 text-emerald-400" />;
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 select-text">
      <div
        id="memory-bank-modal"
        className="bg-[#0c101a] border border-slate-700/80 rounded-xl w-full max-w-5xl h-[85vh] flex flex-col shadow-2xl shadow-black/80 overflow-hidden"
      >
        {/* Top Window Header */}
        <div className="bg-[#111726] border-b border-slate-800 px-5 py-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-tr from-amber-600 to-sky-600 rounded-lg text-white shadow-md">
              <Bookmark className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-100">
                  Frequency Memory Bank Manager
                </h2>
                <span className="text-[11px] font-mono bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded border border-amber-500/30 font-semibold">
                  {banks.reduce((acc, b) => acc + b.channels.length, 0)} Presets Loaded
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Aviation, UHF CB, Outback RFDS, Marine/AIS, Amateur Radio &amp; HF Utilities
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Quick Save Current VFO Button */}
            <button
              id="save-current-vfo-btn"
              onClick={handleOpenSaveCurrentVfo}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md text-xs font-semibold shadow-md shadow-emerald-900/30 transition-all cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Save Current VFO ({(currentFreqHz / 1e6).toFixed(3)} MHz)</span>
            </button>

            {/* Close Button */}
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Action Toolbar & Search Bar */}
        <div className="bg-[#0d131f] border-b border-slate-800/80 px-5 py-2.5 flex items-center justify-between gap-4 shrink-0">
          {/* Search Box */}
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search frequency, name, airport, channel (e.g. Tower, Ch 40, RFDS, 120.5)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-1.5 bg-slate-950 border border-slate-700/80 rounded-lg text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 text-xs"
              >
                Clear
              </button>
            )}
          </div>

          {/* Scanner & Utility Controls */}
          <div className="flex items-center gap-2">
            {/* Scan Current Bank */}
            <button
              id="memory-scanner-toggle-btn"
              onClick={() => setIsScanning(!isScanning)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer border ${
                isScanning
                  ? 'bg-rose-600 text-white border-rose-500 animate-pulse shadow-rose-900/40'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
              }`}
            >
              {isScanning ? (
                <>
                  <Pause className="w-3.5 h-3.5" />
                  <span>Scanning... (Index {scanIndex + 1})</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  <span>Scan Bank</span>
                </>
              )}
            </button>

            {/* Export / Backup */}
            <button
              onClick={handleExportJson}
              title="Export all banks as JSON"
              className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md text-xs border border-slate-700 transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export</span>
            </button>

            {/* Import JSON */}
            <label
              title="Import memory banks JSON"
              className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md text-xs border border-slate-700 transition-colors cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Import</span>
              <input type="file" accept=".json" onChange={handleImportJson} className="hidden" />
            </label>

            {/* Restore Defaults */}
            <button
              onClick={handleRestoreDefaults}
              title="Reset banks to default presets"
              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 rounded-md border border-slate-700 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Toast Notification Alert */}
        {toastMessage && (
          <div className="bg-emerald-950 border-b border-emerald-800 px-4 py-1.5 text-xs text-emerald-300 flex items-center justify-between animate-fadeIn">
            <span className="flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              {toastMessage}
            </span>
          </div>
        )}

        {/* Main Body: Left Bank Sidebar + Right Channel Table */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Banks List */}
          <div className="w-64 bg-[#080c14] border-r border-slate-800/90 flex flex-col shrink-0 overflow-y-auto p-2.5 space-y-1">
            <div className="text-[11px] font-mono text-slate-400 font-bold px-2 py-1 uppercase tracking-wider">
              Memory Banks
            </div>
            {banks.map((bank) => {
              const isSelected = !searchQuery && selectedBankId === bank.id;
              return (
                <button
                  key={bank.id}
                  onClick={() => {
                    setSelectedBankId(bank.id);
                    setSearchQuery('');
                  }}
                  className={`w-full text-left p-2 rounded-lg flex items-center justify-between transition-all cursor-pointer group ${
                    isSelected
                      ? 'bg-sky-600/20 text-sky-200 border border-sky-500/40 shadow-sm'
                      : 'hover:bg-slate-800/60 text-slate-300 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2.5 truncate">
                    {getBankIcon(bank.iconName)}
                    <div className="truncate">
                      <div className="text-xs font-medium leading-tight truncate group-hover:text-slate-100">
                        {bank.name}
                      </div>
                      <div className="text-[10px] text-slate-500 truncate leading-tight">
                        {bank.channels.length} channels
                      </div>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 group-hover:bg-slate-700">
                    {bank.channels.length}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Right Channels Table */}
          <div className="flex-1 flex flex-col bg-[#0a0e18] overflow-hidden">
            {/* Active Bank Header Details */}
            {!searchQuery && activeBank && (
              <div className="px-5 py-3 bg-[#0d121e] border-b border-slate-800/80 flex items-center justify-between shrink-0">
                <div>
                  <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                    {getBankIcon(activeBank.iconName)}
                    <span>{activeBank.name}</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">{activeBank.description}</p>
                </div>
                <button
                  onClick={() => {
                    setEditingChannel(null);
                    setTargetBankId(activeBank.id);
                    setInputName('');
                    setInputFreqMhz('');
                    setInputMode('NBFM');
                    setInputBandwidthKhz('12.5');
                    setInputLocation('');
                    setInputNotes('');
                    setInputTags('');
                    setIsAddModalOpen(true);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-md text-xs font-semibold shadow transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Channel</span>
                </button>
              </div>
            )}

            {searchQuery && (
              <div className="px-5 py-2.5 bg-slate-900 border-b border-slate-800 text-xs text-slate-300">
                Found <strong className="text-cyan-400">{displayedChannels.length}</strong> matching
                channels across all memory banks for "{searchQuery}"
              </div>
            )}

            {/* Channels Scrollable List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {displayedChannels.length === 0 ? (
                <div className="h-48 flex flex-col items-center justify-center text-slate-500 text-xs">
                  <Bookmark className="w-8 h-8 text-slate-600 mb-2 opacity-60" />
                  <p>No frequencies found matching your criteria</p>
                  <button
                    onClick={handleOpenSaveCurrentVfo}
                    className="mt-3 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs"
                  >
                    Save Current VFO Here
                  </button>
                </div>
              ) : (
                displayedChannels.map((ch) => {
                  const isCurrent = Math.abs(currentFreqHz - ch.freqHz) < 1000;
                  const freqMhz = ch.freqHz / 1e6;
                  const isHf = ch.freqHz < 30000000;

                  return (
                    <div
                      key={ch.id}
                      className={`p-3 rounded-lg border transition-all flex items-start justify-between gap-3 group ${
                        isCurrent
                          ? 'bg-sky-950/40 border-sky-500/60 shadow-md shadow-sky-950/40'
                          : 'bg-slate-900/60 hover:bg-slate-800/70 border-slate-800/80 hover:border-slate-700'
                      }`}
                    >
                      {/* Left Channel Information */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="font-semibold text-slate-100 text-sm">{ch.name}</span>
                          {isCurrent && (
                            <span className="flex items-center gap-1 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                              <Volume2 className="w-2.5 h-2.5" />
                              ACTIVE RX
                            </span>
                          )}
                          {ch.isCustom && (
                            <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-purple-900/40 text-purple-300 border border-purple-700/40">
                              Custom
                            </span>
                          )}
                        </div>

                        {ch.locationOrService && (
                          <div className="text-xs text-slate-300 mb-1">{ch.locationOrService}</div>
                        )}

                        {ch.notes && (
                          <div className="text-[11px] text-slate-400 leading-relaxed mb-1.5">
                            {ch.notes}
                          </div>
                        )}

                        {/* Tags */}
                        {ch.tags && ch.tags.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap">
                            {ch.tags.map((tag) => (
                              <span
                                key={tag}
                                className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded flex items-center gap-1"
                              >
                                <Tag className="w-2.5 h-2.5 text-slate-500" />
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Right Frequency & Action Controls */}
                      <div className="flex flex-col items-end gap-2 shrink-0">
                        {/* Frequency Digits */}
                        <div className="text-right">
                          <div className="font-mono text-base font-bold text-cyan-400 tracking-wider">
                            {isHf ? `${(ch.freqHz / 1000).toFixed(1)} kHz` : `${freqMhz.toFixed(4)} MHz`}
                          </div>
                          <div className="flex items-center justify-end gap-1.5 mt-0.5">
                            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-sky-950/60 text-sky-300 border border-sky-800/40 font-bold">
                              {ch.mode}
                            </span>
                            <span className="text-[10px] font-mono text-slate-500">
                              {(ch.bandwidthHz / 1000).toFixed(1)}k BW
                            </span>
                          </div>
                        </div>

                        {/* Action Buttons */}
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => {
                              onTuneChannel(ch.freqHz, ch.mode, ch.bandwidthHz);
                              showToast(`Tuned to ${ch.name} (${(ch.freqHz / 1e6).toFixed(3)} MHz)`);
                            }}
                            className={`px-3 py-1 rounded text-xs font-bold transition-all cursor-pointer ${
                              isCurrent
                                ? 'bg-emerald-600 text-white shadow-emerald-900/30'
                                : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-cyan-900/30'
                            }`}
                          >
                            {isCurrent ? 'TUNED' : 'TUNE'}
                          </button>

                          <button
                            onClick={() => handleOpenEdit(ch)}
                            title="Edit channel details"
                            className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 rounded"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>

                          <button
                            onClick={() => handleDeleteChannel(ch)}
                            title="Delete channel"
                            className="p-1 text-slate-500 hover:text-rose-400 hover:bg-slate-700/60 rounded"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Footer info */}
        <div className="bg-[#090d16] border-t border-slate-800 px-5 py-2.5 flex items-center justify-between text-xs text-slate-500 shrink-0">
          <div>
            Active VFO: <span className="font-mono text-cyan-400 font-bold">{(currentFreqHz / 1e6).toFixed(4)} MHz</span> &bull; Mode: <span className="font-mono text-slate-300 font-semibold">{currentMode}</span>
          </div>
          <div className="text-[11px]">
            Data saved locally in browser &bull; Compatible with Visual Studio C++ export
          </div>
        </div>
      </div>

      {/* Edit / Add Channel Sub-Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-[#0f1523] border border-slate-700 rounded-xl w-full max-w-lg p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <Bookmark className="w-4 h-4 text-emerald-400" />
                <span>{editingChannel ? 'Edit Frequency Channel' : 'Save Channel to Memory Bank'}</span>
              </h3>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveChannelSubmit} className="space-y-3 text-xs">
              {/* Target Bank Dropdown */}
              <div>
                <label className="block text-slate-400 mb-1">Target Memory Bank</label>
                <select
                  value={targetBankId}
                  onChange={(e) => setTargetBankId(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-slate-200"
                >
                  {banks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Channel Name */}
              <div>
                <label className="block text-slate-400 mb-1">Channel / Station Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Brisbane Tower, UHF CB Ch 40, RFDS Night"
                  value={inputName}
                  onChange={(e) => setInputName(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-slate-200"
                />
              </div>

              {/* Frequency (MHz) & Mode */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Frequency (MHz)</label>
                  <input
                    type="number"
                    step="0.0001"
                    required
                    placeholder="e.g. 120.5 or 477.4"
                    value={inputFreqMhz}
                    onChange={(e) => setInputFreqMhz(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded p-2 font-mono text-cyan-400 font-bold"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Demodulation Mode</label>
                  <select
                    value={inputMode}
                    onChange={(e) => {
                      const m = e.target.value as DemodMode;
                      setInputMode(m);
                      if (m === 'WBFM') setInputBandwidthKhz('180');
                      else if (m === 'NBFM') setInputBandwidthKhz('12.5');
                      else if (m === 'AM') setInputBandwidthKhz('10');
                      else if (m === 'USB' || m === 'LSB') setInputBandwidthKhz('2.8');
                      else if (m === 'CW') setInputBandwidthKhz('0.5');
                    }}
                    className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-slate-200"
                  >
                    <option value="WBFM">WBFM (Broadcast)</option>
                    <option value="NBFM">NBFM (CB / Marine / Ham)</option>
                    <option value="AM">AM (Aviation / Shortwave)</option>
                    <option value="USB">USB (Outback RFDS / Marine HF)</option>
                    <option value="LSB">LSB (Ham 40m/80m HF)</option>
                    <option value="CW">CW (Morse Code)</option>
                  </select>
                </div>
              </div>

              {/* Filter Bandwidth */}
              <div>
                <label className="block text-slate-400 mb-1">Bandwidth (kHz)</label>
                <input
                  type="number"
                  step="0.1"
                  value={inputBandwidthKhz}
                  onChange={(e) => setInputBandwidthKhz(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 font-mono text-slate-200"
                />
              </div>

              {/* Location or Service Description */}
              <div>
                <label className="block text-slate-400 mb-1">Location / Service / Repeater Offset</label>
                <input
                  type="text"
                  placeholder="e.g. Brisbane Intl Runway Control, Mt Coot-tha (-600k)"
                  value={inputLocation}
                  onChange={(e) => setInputLocation(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-slate-200"
                />
              </div>

              {/* Notes & Comments */}
              <div>
                <label className="block text-slate-400 mb-1">Notes / Operating Procedures</label>
                <textarea
                  rows={2}
                  placeholder="Operational details, emergency guidelines, call signs..."
                  value={inputNotes}
                  onChange={(e) => setInputNotes(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-slate-200"
                />
              </div>

              {/* Tags */}
              <div>
                <label className="block text-slate-400 mb-1">Tags (comma separated)</label>
                <input
                  type="text"
                  placeholder="e.g. Brisbane, Emergency, Tower, Highway"
                  value={inputTags}
                  onChange={(e) => setInputTags(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-slate-200"
                />
              </div>

              {/* Buttons */}
              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded shadow-md"
                >
                  {editingChannel ? 'Update Channel' : 'Save Channel'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
