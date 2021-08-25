import { CanvasVideoFrameBuffer, VideoFrameBuffer, VideoFrameProcessor } from 'amazon-chime-sdk-js';
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

export default class CWTSegmentationProcessor implements VideoFrameProcessor {
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

  private worker: Worker;

  private mask$ = new DeferredObservable<ImageData>();

  private isReady: Boolean;
  private scaledCanvas: HTMLCanvasElement;
  
  constructor(strength: number = 7) {
    this.blurAmount = strength; // in px
    this.isReady = false;

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

    this.worker = new Worker('/cwt/worker.js');
    this.worker.addEventListener('message', (ev) => this.handleWorkerEvent(ev));
    this.worker.postMessage({msg: 'initialize', payload: {
          pathPrefix: "/cwt/"
      }
    });
  }

  handleWorkerEvent(evt: MessageEvent<any>) {
    var msg = evt.data;
    switch (msg.msg) {
        case 'initialize':
            if (!msg.payload) {
                console.error("failed to initialize module");
                return;
            }
            this.worker.postMessage({msg: 'loadModel', payload: {
                    modelUrl: "/cwt/selfie_segmentation_landscape.tflite",
                    inputHeight: 144,
                    inputWidth: 256,
                    inputChannels: 4,
                    modelRangeMin: 0,
                    modelRangeMax: 1
                  }});
            break;
        case 'loadModel':
            if (msg.payload != 2) {
                console.error("failed to load model! status: " + msg.payload);
                return;
            }
            this.isReady = msg.payload == 2;

            break;
        case 'predict':
            this.mask$.next(msg.payload as ImageData);
            break;
    }
  }

  createCanvas(w: number, h: number) {
    let canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h; 
    // document.body.appendChild(canvas);
    return canvas;

  }

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

    // const doScale = this.scaleFactor !== 1;

    try {
      let mask = this.mask$.value;

      if (this.runningCount === this.reduceFactor) {
        this.runningCount = this.runningCount % 1;

        const hscale = 256 / inputCanvas.width;
        const vscale = 144 / inputCanvas.height;

        if (this.scaledCanvas === undefined) {
          this.scaledCanvas = document.createElement('canvas');
          this.scaledCanvas.width = inputCanvas.width * hscale;
          this.scaledCanvas.height = inputCanvas.height * vscale;
        }

        const scaledCtx = this.scaledCanvas.getContext('2d');
        scaledCtx.save();
        scaledCtx.scale(hscale, vscale);
        scaledCtx.drawImage(inputCanvas, 0, 0);
        scaledCtx.restore();

        // Object.assign(window, { inputCanvas, this.scaledCanvas });

        const imageData = scaledCtx.getImageData(0, 0, this.scaledCanvas.width, this.scaledCanvas.height);
        
        const maskPromise = this.mask$.whenNext();

        // process frame...
        this.worker.postMessage({msg: 'predict', payload: imageData}, [imageData.data.buffer]);

        mask = await maskPromise;

        scaledCtx.putImageData(mask, 0, 0);
        this.frames++;
      }

      this.runningCount += 1;
      if (mask) {
        const { canvasCtx, targetCanvas } = this;
        const { width, height } = targetCanvas;

        // draw the mask
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, width, height);
        canvasCtx.drawImage(this.scaledCanvas, 0, 0, width, height);

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
    this.worker.postMessage({msg: 'destroy'});
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
