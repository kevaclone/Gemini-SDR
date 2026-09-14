import React from 'react';
import {
  ExternalLink,
  Usb,
  FolderArchive,
  Terminal,
  PlayCircle,
  HelpCircle,
  ShieldAlert,
} from 'lucide-react';
import { downloadVisualStudioProjectZip } from '../services/zipExporter';

export const VisualStudioSetupGuide: React.FC = () => {
  return (
    <div id="vs-setup-guide" className="h-full w-full bg-[#090d16] text-slate-200 overflow-y-auto p-6 select-text">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header Title */}
        <div className="border-b border-slate-800 pb-5">
          <div className="flex items-center gap-2 text-xs font-mono text-purple-400 mb-1">
            <span>MICROSOFT VISUAL STUDIO 2022 &bull; MSVC v143 &bull; C++20</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100">
            Building &amp; Running the RTL-SDR C++ GUI in Visual Studio
          </h1>
          <p className="text-sm text-slate-400 mt-2 leading-relaxed">
            Follow this step-by-step walkthrough to extract, configure, build, and debug your standalone
            DirectX 11 + Dear ImGui RTL-SDR receiver natively in Visual Studio.
          </p>
        </div>

        {/* Step 1: Download & Extract */}
        <div className="bg-[#0f1523] border border-slate-800 rounded-lg p-5">
          <div className="flex items-center gap-3 mb-3">
            <span className="w-7 h-7 rounded-full bg-purple-600/30 text-purple-400 font-mono font-bold flex items-center justify-center text-sm border border-purple-500/30">
              1
            </span>
            <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <FolderArchive className="w-5 h-5 text-purple-400" />
              Download &amp; Extract the Visual Studio Solution
            </h2>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed mb-4">
            Click below to download the pre-packaged Visual Studio project archive containing the solution
            (<code className="text-purple-300 bg-slate-900 px-1 py-0.5 rounded">RtlSdrGui.sln</code>),
            MSBuild configuration (<code className="text-purple-300 bg-slate-900 px-1 py-0.5 rounded">RtlSdrGui.vcxproj</code>),
            and all C++ source files.
          </p>
          <button
            onClick={() => downloadVisualStudioProjectZip()}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded font-medium text-xs shadow-md transition-colors cursor-pointer"
          >
            Download RTL-SDR C++ Visual Studio Project (.ZIP)
          </button>
        </div>

        {/* Step 2: Zadig Driver Installation */}
        <div className="bg-[#0f1523] border border-slate-800 rounded-lg p-5">
          <div className="flex items-center gap-3 mb-3">
            <span className="w-7 h-7 rounded-full bg-sky-600/30 text-sky-400 font-mono font-bold flex items-center justify-center text-sm border border-sky-500/30">
              2
            </span>
            <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <Usb className="w-5 h-5 text-sky-400" />
              Install WinUSB Drivers with Zadig (Required for RTL2832U)
            </h2>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed mb-3">
            Windows by default binds the RTL2832U USB chip to its built-in Windows DVB-T television tuner driver.
            To allow librtlsdr to stream raw IQ radio samples, you must replace the default driver with <strong className="text-sky-300">WinUSB</strong>.
          </p>
          <div className="bg-slate-950 p-4 rounded-md border border-slate-800 space-y-2 text-xs font-mono text-slate-300">
            <div>1. Plug your RTL2832U USB dongle into a USB 2.0/3.0 port on your PC.</div>
            <div>2. Download and run <strong className="text-amber-400">Zadig</strong> from <span className="text-sky-400 underline">https://zadig.akeo.ie</span>.</div>
            <div>3. In the Zadig top menu, click <strong className="text-slate-100">Options &rarr; List All Devices</strong>.</div>
            <div>4. In the dropdown, select <strong className="text-emerald-400">Bulk-In, Interface (Interface 0)</strong> or <strong className="text-emerald-400">RTL2832U</strong>.</div>
            <div>5. Ensure the target driver box says <strong className="text-sky-400">WinUSB (v6.1.7600.16385)</strong>.</div>
            <div>6. Click <strong className="text-amber-400">Replace Driver</strong> (takes ~15-30 seconds).</div>
          </div>
        </div>

        {/* Step 3: Dependencies with setup_dependencies.bat or vcpkg */}
        <div className="bg-[#0f1523] border border-slate-800 rounded-lg p-5">
          <div className="flex items-center gap-3 mb-3">
            <span className="w-7 h-7 rounded-full bg-emerald-600/30 text-emerald-400 font-mono font-bold flex items-center justify-center text-sm border border-emerald-500/30">
              3
            </span>
            <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <Terminal className="w-5 h-5 text-emerald-400" />
              Resolve Dependencies (Fix for &quot;Cannot open include file: &apos;imgui.h&apos;&quot;)
            </h2>
          </div>

          <div className="p-3 mb-3 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-200 leading-relaxed">
            <strong>Getting Error C1083: Cannot open include file: &apos;imgui.h&apos;?</strong>
            <br />
            Visual Studio needs the Dear ImGui DirectX11 UI library. Choose either of the two fast solutions below:
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            {/* Option A */}
            <div className="p-3.5 bg-slate-950/80 rounded border border-slate-800 space-y-2">
              <div className="font-semibold text-emerald-400 flex items-center gap-1.5">
                <span>Option A (Recommended &bull; 1-Click Script)</span>
              </div>
              <p className="text-slate-300">
                Inside your extracted project folder, simply double-click:
              </p>
              <div className="bg-slate-900 px-2.5 py-1.5 rounded font-mono text-amber-300 font-bold">
                setup_dependencies.bat
              </div>
              <p className="text-[11px] text-slate-400">
                This automated script will download Dear ImGui and its DirectX 11 + Win32 backend headers straight into <code className="text-slate-300">vendor\imgui\</code> in ~5 seconds without needing Git!
              </p>
            </div>

            {/* Option B */}
            <div className="p-3.5 bg-slate-950/80 rounded border border-slate-800 space-y-2">
              <div className="font-semibold text-sky-400 flex items-center gap-1.5">
                <span>Option B (Microsoft vcpkg Integration)</span>
              </div>
              <p className="text-slate-300">
                If you use vcpkg, run in PowerShell or Command Prompt:
              </p>
              <div className="bg-slate-900 p-2 rounded font-mono text-[11px] text-sky-300 space-y-1">
                <div>vcpkg install imgui[win32-binding,dx11-binding]:x64-windows</div>
                <div>vcpkg integrate install</div>
              </div>
              <p className="text-[11px] text-slate-400">
                After running integrate install, Visual Studio automatically links ImGui for all C++ projects.
              </p>
            </div>
          </div>
        </div>

        {/* Step 4: Build & Run in Visual Studio */}
        <div className="bg-[#0f1523] border border-slate-800 rounded-lg p-5">
          <div className="flex items-center gap-3 mb-3">
            <span className="w-7 h-7 rounded-full bg-amber-600/30 text-amber-400 font-mono font-bold flex items-center justify-center text-sm border border-amber-500/30">
              4
            </span>
            <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <PlayCircle className="w-5 h-5 text-amber-400" />
              Open, Compile, and Run in Visual Studio
            </h2>
          </div>
          <div className="space-y-2 text-xs text-slate-300">
            <p>
              1. Open Visual Studio 2019 or 2022.
            </p>
            <p>
              2. Go to <strong className="text-slate-100">File &rarr; Open &rarr; Project/Solution</strong> and select <code className="text-amber-300">RtlSdrGui.sln</code>.
            </p>
            <p>
              3. Set the build configuration to <strong className="text-slate-100">Release</strong> and architecture to <strong className="text-slate-100">x64</strong> in the top toolbar.
            </p>
            <p>
              4. Press <strong className="text-amber-400">Ctrl + Shift + B</strong> to compile.
            </p>
            <p>
              5. Press <strong className="text-emerald-400">F5</strong> or <strong className="text-emerald-400">Ctrl + F5</strong> to launch your standalone SDR GUI!
            </p>
          </div>
        </div>

        {/* Troubleshooting & FAQ */}
        <div className="bg-[#0f1523] border border-slate-800 rounded-lg p-5 space-y-3">
          <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
            <HelpCircle className="w-5 h-5 text-sky-400" />
            Troubleshooting &amp; Developer Tips
          </h2>

          <div className="space-y-3 text-xs">
            <div className="p-3 bg-slate-900/80 rounded border border-slate-800">
              <div className="font-semibold text-slate-200 mb-1 flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4 text-amber-400" />
                "rtlsdr_open failed (-1)" or No Devices Found
              </div>
              <p className="text-slate-400 leading-relaxed">
                Ensure Zadig replaced Interface 0 with WinUSB, not Interface 1 (which is the IR remote control sensor). Also verify no other SDR software (like SDR# or CubicSDR) is currently running and locking the USB device.
              </p>
            </div>

            <div className="p-3 bg-slate-900/80 rounded border border-slate-800">
              <div className="font-semibold text-slate-200 mb-1">
                Zero USB Dongle Plugged In? Simulated Mode Engaged!
              </div>
              <p className="text-slate-400 leading-relaxed">
                The provided C++ code features an automatic RF simulation engine in <code className="text-sky-300">sdr_device.cpp</code> that generates synthetic FM broadcast stations and noise when no physical dongle is detected. You can test and refine the UI anytime without hardware plugged in.
              </p>
            </div>

            <div className="p-3 bg-slate-900/80 rounded border border-slate-800">
              <div className="font-semibold text-slate-200 mb-1">
                Optimal Sample Rate for RTL2832U
              </div>
              <p className="text-slate-400 leading-relaxed">
                The sweet spot sample rate for RTL2832U USB 2.0 is <strong>2.048 MSPS (2048000 Hz)</strong> or <strong>2.400 MSPS</strong>. Avoid exceeding 2.56 MSPS to prevent USB FIFO buffer dropouts and sample drops on standard controllers.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
