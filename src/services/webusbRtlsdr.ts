export interface WebUsbStatus {
  isSupported: boolean;
  isConnected: boolean;
  deviceName: string;
  errorMessage?: string;
}

// WebUSB API type definitions for browsers
interface USBDeviceConfig {
  vendorId?: number;
  productId?: number;
}

interface USBInTransferResult {
  data?: {
    buffer: ArrayBuffer;
  };
  status?: string;
}

interface USBDeviceInternal {
  opened: boolean;
  productName?: string;
  configuration: unknown;
  open(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
  close(): Promise<void>;
}

interface USBNavigator {
  usb?: {
    requestDevice(options: { filters: USBDeviceConfig[] }): Promise<USBDeviceInternal>;
  };
}

export class WebUsbSdrManager {
  private device: USBDeviceInternal | null = null;
  private isReading: boolean = false;

  public static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'usb' in navigator;
  }

  public async requestAndConnect(
    onStatusChange: (status: WebUsbStatus) => void,
    onSamples?: (iqBytes: Uint8Array) => void
  ): Promise<boolean> {
    if (!WebUsbSdrManager.isSupported()) {
      onStatusChange({
        isSupported: false,
        isConnected: false,
        deviceName: 'WebUSB Not Supported in this browser',
        errorMessage: 'WebUSB API requires Google Chrome, Microsoft Edge, or Opera over HTTPS.',
      });
      return false;
    }

    try {
      const nav = navigator as unknown as USBNavigator;
      if (!nav.usb) throw new Error('WebUSB not available');

      // Known RTL2832U Vendor and Product IDs
      const device = await nav.usb.requestDevice({
        filters: [
          { vendorId: 0x0bda, productId: 0x2838 }, // RTL2832U / RTL2838
          { vendorId: 0x0bda, productId: 0x2832 }, // Realtek DVB-T
          { vendorId: 0x0413, productId: 0x6680 }, // Leadtek WinFast DTV Dongle
          { vendorId: 0x1d19, productId: 0x1101 }, // Dexatek DK DVB-T
          { vendorId: 0x1d19, productId: 0x1102 }, // Terratec Cinergy T Stick
        ],
      });

      this.device = device;
      await this.device.open();
      if (this.device.configuration === null) {
        await this.device.selectConfiguration(1);
      }
      await this.device.claimInterface(0);

      onStatusChange({
        isSupported: true,
        isConnected: true,
        deviceName: device.productName || 'RTL2832U Dongle',
      });

      this.startAsyncReader(onSamples);
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onStatusChange({
        isSupported: true,
        isConnected: false,
        deviceName: 'Connection Cancelled',
        errorMessage: errorMsg,
      });
      return false;
    }
  }

  private async startAsyncReader(onSamples?: (iqBytes: Uint8Array) => void): Promise<void> {
    if (!this.device || !this.device.opened) return;
    this.isReading = true;

    while (this.isReading && this.device && this.device.opened) {
      try {
        // Bulk read endpoint 1 (16KB typical transfer)
        const result = await this.device.transferIn(1, 16384);
        if (result.data && result.data.buffer && onSamples) {
          onSamples(new Uint8Array(result.data.buffer));
        }
      } catch {
        // Break on disconnect or abort
        break;
      }
    }
    this.isReading = false;
  }

  public async disconnect(): Promise<void> {
    this.isReading = false;
    if (this.device && this.device.opened) {
      try {
        await this.device.releaseInterface(0);
        await this.device.close();
      } catch {
        // ignore
      }
    }
    this.device = null;
  }
}

export const webUsbManager = new WebUsbSdrManager();
