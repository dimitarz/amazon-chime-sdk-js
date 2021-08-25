import { CanvasVideoFrameBuffer, VideoFrameBuffer, VideoFrameProcessor } from 'amazon-chime-sdk-js';
import { SelfieSegmentation, GpuBuffer } from '@mediapipe/selfie_segmentation';
import DeferredObservable from './DeferredObservable';

const IS_DEV = process.env.NODE_ENV === 'development';
const LogUtils = 
{
  error: (message?: any, ...optionalParams: any[]) => {
    console.info('ERROR', message, ...optionalParams);
  },

  info: (message?: any, ...optionalParams: any[]) => {
      console.info('INFO', message, ...optionalParams);
  }
};

export default class SelfieSegmentationProcessor implements VideoFrameProcessor {
  private targetCanvas: HTMLCanvasElement = document.createElement('canvas') as HTMLCanvasElement;
  private canvasCtx = this.targetCanvas.getContext('2d');

  private canvasVideoFrameBuffer = new CanvasVideoFrameBuffer(this.targetCanvas);
  private sourceWidth = 0;
  private sourceHeight = 0;
  private blurAmount: number;
  private frames = 0;
  private time = 0;
  private fps = 0;
  private fpsTimer: number;

  /** segment every reduceFactor frames */
  private reduceFactor = 1;
  private runningCount = this.reduceFactor; // force a run on first process

  /** scale down source canvas before segmentation */
  private scaleFactor = 1;

  private selfieSegmentation = new SelfieSegmentation({
    locateFile: (file) => {
      // TODO: load files through Chime CDN
      return `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`;
    },
  });

  private isReady: Boolean;

  constructor(strength: number = 7) {
    this.blurAmount = strength; // in px
    this.isReady = false;
    this.selfieSegmentation.setOptions({ modelSelection: 1 });
    this.selfieSegmentation.onResults(({ segmentationMask }) => {
      this.mask$.next(segmentationMask)
      //console.log(segmentationMask)
    });
    this.selfieSegmentation.initialize().then(() => {this.isReady = true;});

    if (IS_DEV) Object.assign(window, { selfie: this });

    this.fpsTimer = window.setInterval(() => {
      if (this.time > 0) {
        let d = performance.now() - this.time;
        if (d > 0) {
          this.fps = this.frames * 1000 / d; 
          this.frames = 0;
        }
      }
      this.time = performance.now();
    }, 2000)
  }

  createCanvas(w: number, h: number) {
    let canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h; 
    // document.body.appendChild(canvas);
    return canvas;

  }

  private mask$ = new DeferredObservable<GpuBuffer>();

  async process(buffers: VideoFrameBuffer[]): Promise<VideoFrameBuffer[]> {
    if (!this.isReady) {
      return buffers;
    }

    const inputCanvas = buffers[0].asCanvasElement();
    if (!inputCanvas) {
      LogUtils.error('SegmentationFilter::process input canvas is already destroyed');
      return buffers;
    }

    const frameWidth = inputCanvas.width;
    const frameHeight = inputCanvas.height;
    if (frameWidth === 0 || frameHeight === 0) {
      return buffers;
    }

    if (this.sourceWidth !== frameWidth || this.sourceHeight !== frameHeight) {
      this.sourceWidth = frameWidth;
      this.sourceHeight = frameHeight;

      // update target canvas size to match the frame size
      this.targetCanvas.width = this.sourceWidth;
      this.targetCanvas.height = this.sourceHeight;
    }

    const doScale = this.scaleFactor !== 1;

    try {
      let mask = this.mask$.value;
      if (this.runningCount === this.reduceFactor) {
        this.runningCount = this.runningCount % 1;

        let scaledCanvas = inputCanvas as HTMLCanvasElement;
        if (doScale) {
          scaledCanvas = document.createElement('canvas');
          scaledCanvas.width = inputCanvas.width * this.scaleFactor;
          scaledCanvas.height = inputCanvas.height * this.scaleFactor;

          const scaledCtx = scaledCanvas.getContext('2d');
          scaledCtx.scale(this.scaleFactor, this.scaleFactor);
          scaledCtx.drawImage(inputCanvas, 0, 0);
          scaledCtx.restore();
        }

        Object.assign(window, { inputCanvas, scaledCanvas });

        const maskPromise = this.mask$.whenNext();

        // process frame...
        let t = performance.now();
        this.selfieSegmentation.send({ image: scaledCanvas }).catch((err) => {
          LogUtils.error('SelfieSegmentationProcessor::selfieSegmentation', err);
        });

        // ...and wait for onResults to finish
        mask = await maskPromise;
        console.log(performance.now() - t);
        this.frames++;
      }

      this.runningCount += 1;
      if (mask) {
        const { canvasCtx, targetCanvas } = this;
        const { width, height } = targetCanvas;

        // draw the mask
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, width, height);
        if (doScale) {
          canvasCtx.drawImage(mask, 0, 0, width, height);
        } else {
          canvasCtx.drawImage(mask, 0, 0, width, height);
        }

        // Only overwrite existing pixels.
        canvasCtx.globalCompositeOperation = 'source-in';
        // draw image over mask...
        canvasCtx.drawImage(inputCanvas, 0, 0, width, height);

        // draw under person
        canvasCtx.globalCompositeOperation = 'destination-over';
        if (this.blurAmount > 0) canvasCtx.filter = `blur(${this.blurAmount}px)`;
        canvasCtx.drawImage(inputCanvas, 0, 0, targetCanvas.width, targetCanvas.height);
        canvasCtx.restore();

        canvasCtx.font = '12px serif';
        canvasCtx.fillText(Math.round(this.fps) + " FPS", 20, 20);
      }
    } catch (error) {
      LogUtils.info('SegmentationFilter::process failed', error);
      return buffers;
    }

    buffers[0] = this.canvasVideoFrameBuffer;

    return buffers;
  }

  async destroy() {
    this.canvasVideoFrameBuffer?.destroy();
    this.selfieSegmentation?.close();
    this.selfieSegmentation = undefined;
    this.targetCanvas?.remove();
    this.targetCanvas = undefined;
    window.clearInterval(this.fpsTimer);
    if (IS_DEV) (window as any).selfie = undefined;
  }

  updateScaleFactor(scale: number) {
    this.scaleFactor = scale;
    LogUtils.info('SelfieSegmentationProcessor::updateScaleFactor', {
      scaleFactor: this.scaleFactor,
      width: this.targetCanvas.width * this.scaleFactor,
      height: this.targetCanvas.height * this.scaleFactor,
    });
  }
}
