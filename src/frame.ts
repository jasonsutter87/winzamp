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

// Emitted by the macOS Now Playing bridge whenever the current track changes.
export interface NowPlaying {
  playing: boolean;
  title: string | null;
  artist: string | null;
  album: string | null;
  elapsed: number;
  duration: number;
  rate: number;
}
