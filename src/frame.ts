// Shape of the "frame" event the Rust capture thread emits ~60x a second.
export interface Frame {
  l: number[]; // 1024 samples, u8 centered on 128
  r: number[];
  spec: number[]; // 512 bins, 0..255 over a -70..0 dB range
}

export interface CaptureInfo {
  device: string;
  sample_rate: number;
  channels: number;
}
