declare module "butterchurn" {
  interface Visualizer {
    loadPreset(preset: object, blendSeconds: number): void;
    setRendererSize(width: number, height: number): void;
    render(opts?: {
      audioLevels?: {
        timeByteArray: Uint8Array;
        timeByteArrayL: Uint8Array;
        timeByteArrayR: Uint8Array;
      };
    }): void;
  }
  const butterchurn: {
    createVisualizer(
      ctx: AudioContext,
      canvas: HTMLCanvasElement,
      opts: { width: number; height: number; pixelRatio?: number },
    ): Visualizer;
  };
  export default butterchurn;
}

declare module "butterchurn-presets" {
  const presets: { getPresets(): Record<string, object> };
  export default presets;
}
