import React, { useState } from 'react';
import { CPP_PROJECT_FILES } from '../data/cppProjectFiles';
import { CppProjectFile } from '../types';
import { downloadVisualStudioProjectZip } from '../services/zipExporter';
import {
  FileCode,
  FolderGit2,
  Download,
  Copy,
  Check,
  Code2,
  Layers,
  Terminal,
  FileText,
} from 'lucide-react';

export const VisualStudioProjectViewer: React.FC = () => {
  const [selectedFile, setSelectedFile] = useState<CppProjectFile>(CPP_PROJECT_FILES[0]);
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [isExportingZip, setIsExportingZip] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number>(0);

  const handleCopyCode = () => {
    navigator.clipboard.writeText(selectedFile.content);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleDownloadZip = async () => {
    setIsExportingZip(true);
    setExportProgress(10);
    try {
      await downloadVisualStudioProjectZip((percent) => setExportProgress(percent));
    } catch (err) {
      console.error('ZIP export failed:', err);
    } finally {
      setIsExportingZip(false);
      setExportProgress(0);
    }
  };

  const getFileCategoryIcon = (category: CppProjectFile['category']) => {
    switch (category) {
      case 'source':
      case 'header':
        return <FileCode className="w-4 h-4 text-sky-400 shrink-0" />;
      case 'vs_project':
        return <Layers className="w-4 h-4 text-purple-400 shrink-0" />;
      case 'build_script':
        return <Terminal className="w-4 h-4 text-emerald-400 shrink-0" />;
      case 'docs':
      default:
        return <FileText className="w-4 h-4 text-amber-400 shrink-0" />;
    }
  };

  return (
    <div id="vs-project-viewer" className="flex flex-col h-full w-full bg-[#080b11] text-slate-200 overflow-hidden">
      {/* Top Banner with Download Button and Solution Info */}
      <div className="bg-[#0f1422] border-b border-slate-800 p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-purple-600/20 border border-purple-500/30 rounded-lg text-purple-400">
            <FolderGit2 className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-slate-100">
                Visual Studio 2022/2019 C++ Solution
              </h2>
              <span className="text-[11px] px-2 py-0.5 rounded bg-purple-900/40 text-purple-300 border border-purple-700/50 font-mono">
                C++20 &bull; DirectX 11 &bull; ImGui
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Standalone C++ GUI for RTL-SDR / RTL2832U with native Win32 windowing, 60 FPS waterfall, and multi-mode DSP.
            </p>
          </div>
        </div>

        {/* 1-Click Download Visual Studio Solution (.zip) */}
        <button
          id="download-vs-solution-btn"
          onClick={handleDownloadZip}
          disabled={isExportingZip}
          className="flex items-center gap-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:bg-purple-800 text-white rounded-md font-semibold text-xs shadow-lg shadow-purple-900/30 transition-all cursor-pointer"
        >
          <Download className="w-4 h-4" />
          <span>
            {isExportingZip
              ? `Packaging Project ZIP (${exportProgress}%)...`
              : 'Download Complete Visual Studio Project (.ZIP)'}
          </span>
        </button>
      </div>

      {/* Main Workspace: Left File Tree + Right Code Editor */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Solution Explorer / File Tree */}
        <div className="w-72 bg-[#0a0e17] border-r border-slate-800 flex flex-col shrink-0">
          <div className="px-3 py-2 border-b border-slate-800/80 text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
            <span>Solution Explorer</span>
            <span className="text-[10px] text-slate-500 font-mono">
              {CPP_PROJECT_FILES.length} Files
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            <div className="text-[11px] font-semibold text-purple-400 px-2 pt-1 pb-0.5 uppercase tracking-wider">
              Visual Studio Build Files
            </div>
            {CPP_PROJECT_FILES.filter((f) => f.category === 'vs_project' || f.category === 'build_script').map(
              (file) => (
                <button
                  key={file.path}
                  onClick={() => setSelectedFile(file)}
                  className={`w-full text-left px-2.5 py-1.5 rounded text-xs flex items-center gap-2 transition-colors cursor-pointer ${
                    selectedFile.path === file.path
                      ? 'bg-purple-950/60 text-purple-300 border border-purple-800/60 font-medium'
                      : 'text-slate-400 hover:bg-slate-850 hover:text-slate-200'
                  }`}
                >
                  {getFileCategoryIcon(file.category)}
                  <span className="truncate font-mono">{file.path}</span>
                </button>
              )
            )}

            <div className="text-[11px] font-semibold text-sky-400 px-2 pt-3 pb-0.5 uppercase tracking-wider">
              C++ Source &amp; Headers
            </div>
            {CPP_PROJECT_FILES.filter((f) => f.category === 'source' || f.category === 'header').map(
              (file) => (
                <button
                  key={file.path}
                  onClick={() => setSelectedFile(file)}
                  className={`w-full text-left px-2.5 py-1.5 rounded text-xs flex items-center gap-2 transition-colors cursor-pointer ${
                    selectedFile.path === file.path
                      ? 'bg-sky-950/60 text-sky-300 border border-sky-800/60 font-medium'
                      : 'text-slate-400 hover:bg-slate-850 hover:text-slate-200'
                  }`}
                >
                  {getFileCategoryIcon(file.category)}
                  <span className="truncate font-mono">{file.path}</span>
                </button>
              )
            )}

            <div className="text-[11px] font-semibold text-amber-400 px-2 pt-3 pb-0.5 uppercase tracking-wider">
              Documentation &amp; Drivers
            </div>
            {CPP_PROJECT_FILES.filter((f) => f.category === 'docs').map((file) => (
              <button
                key={file.path}
                onClick={() => setSelectedFile(file)}
                className={`w-full text-left px-2.5 py-1.5 rounded text-xs flex items-center gap-2 transition-colors cursor-pointer ${
                  selectedFile.path === file.path
                    ? 'bg-amber-950/60 text-amber-300 border border-amber-800/60 font-medium'
                    : 'text-slate-400 hover:bg-slate-850 hover:text-slate-200'
                }`}
              >
                {getFileCategoryIcon(file.category)}
                <span className="truncate font-mono">{file.path}</span>
              </button>
            ))}
          </div>

          {/* Quick Info Box */}
          <div className="p-3 bg-slate-900/80 border-t border-slate-800 text-[11px] text-slate-400 space-y-1">
            <div className="font-semibold text-slate-300 flex items-center gap-1.5">
              <Code2 className="w-3.5 h-3.5 text-purple-400" />
              Target Architecture
            </div>
            <div>&bull; MSVC v143 / Visual Studio 2022</div>
            <div>&bull; Target: Windows x64 (DirectX 11)</div>
            <div>&bull; Standard: ISO C++20</div>
          </div>
        </div>

        {/* Right: Code Viewer */}
        <div className="flex-1 flex flex-col bg-[#05070c] overflow-hidden">
          {/* File Tab / Action Bar */}
          <div className="h-10 bg-[#0c1018] border-b border-slate-800 px-4 flex items-center justify-between text-xs text-slate-300">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sky-400 font-medium">{selectedFile.path}</span>
              <span className="text-slate-500">&mdash;</span>
              <span className="text-slate-400 text-[11px]">{selectedFile.description}</span>
            </div>

            <button
              id="copy-file-code-btn"
              onClick={handleCopyCode}
              className="flex items-center gap-1.5 px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs transition-colors cursor-pointer"
            >
              {isCopied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Code</span>
                </>
              )}
            </button>
          </div>

          {/* Code Text with Line Numbers */}
          <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed select-text bg-[#07090f]">
            <pre className="text-slate-300 whitespace-pre">
              <code>{selectedFile.content}</code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
