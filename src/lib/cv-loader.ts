// 客户端加载 OpenCV（通过 @techstark/opencv-js npm 包，wasm 已内联，无需外部文件）。
// 该包导出的是 Emscripten MODULARIZE 构建：default 可能是 Promise，或需等待 onRuntimeInitialized。
// jscanify 依赖全局 window.cv，所以加载完成后必须显式把真实模块挂到 window.cv。

let cvPromise: Promise<any> | null = null;

export async function loadOpenCV(): Promise<any> {
  if (cvPromise) return cvPromise;

  cvPromise = (async () => {
    const cvModule: any = (await import("@techstark/opencv-js")).default;
    let cv: any = cvModule;
    if (cv instanceof Promise) {
      cv = await cv;
    } else if (!cv.Mat) {
      await new Promise<void>((resolve) => {
        cv.onRuntimeInitialized = () => resolve();
      });
    }
    (window as any).cv = cv;
    return cv;
  })();

  return cvPromise;
}
