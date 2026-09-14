import JSZip from 'jszip';
import { CPP_PROJECT_FILES } from '../data/cppProjectFiles';

export async function downloadVisualStudioProjectZip(onProgress?: (percent: number) => void): Promise<void> {
  const zip = new JSZip();

  // Root solution folder
  const rootFolder = zip.folder('RtlSdr_VisualStudio_Cpp_GUI');
  if (!rootFolder) throw new Error('Failed to create zip folder');

  // Add all C++ sources, headers, project files, and docs
  for (const file of CPP_PROJECT_FILES) {
    rootFolder.file(file.path, file.content);
  }

  // Add helper scripts and vendor README
  rootFolder.file('vendor/README_DEPENDENCIES.txt', `RTL-SDR Standalone C++ GUI Vendor Directory
===========================================
This project uses Dear ImGui (v1.90+) with DirectX 11 + Win32 backend,
and miniaudio.h for cross-platform audio.

To automatically acquire dependencies using vcpkg (recommended):
  vcpkg install rtl-sdr:x64-windows imgui[win32-binding,dx11-binding]:x64-windows
  vcpkg integrate install

Or download pre-compiled Windows binaries for librtlsdr from:
  https://osmocom.org/projects/rtl-sdr/wiki/Rtl-sdr
Place 'rtlsdr.dll' and 'rtlsdr.lib' inside the 'lib/x64' folder.
`);

  rootFolder.file('vcpkg.json', JSON.stringify({
    name: 'rtl-sdr-gui',
    version: '1.0.0',
    description: 'Standalone C++ GUI for RTL-SDR dongles on Windows',
    dependencies: [
      'rtl-sdr',
      {
        name: 'imgui',
        features: ['win32-binding', 'dx11-binding']
      }
    ]
  }, null, 2));

  // Generate ZIP blob with progress callback
  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } },
    (metadata) => {
      if (onProgress) {
        onProgress(Math.round(metadata.percent));
      }
    }
  );

  // Trigger browser download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'RTL-SDR_VisualStudio_Cpp_GUI.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
