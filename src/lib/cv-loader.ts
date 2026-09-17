// 客户端按需加载 OpenCV（@techstark/opencv-js，wasm 已内联，无需外部文件）。
//
// 该包是 Emscripten MODULARIZE 构建，在不同打包器/浏览器下 import() 拿到的可能是：
//   1) 一个 async function（需调用后 await）
//   2) 一个已启动的 Promise
//   3) 一个带 default 的对象
// 必须三种情况都兜住，否则会出现 "Cannot read properties of undefined (reading 'Mat')"。
// 这段逻辑来自 custom-v8 的实测经验（当时为此修过一个 bug），保留原样。

let cvPromise: Promise<any> | null = null;

export async function loadOpenCV(): Promise<any> {
  if (cvPromise) return cvPromise;

  cvPromise = (async () => {
    let mod: any = await import("@techstark/opencv-js");

    // Webpack/Next.js 可能把 UMD 包解析成 { default: ... }
    if (mod?.default) {
      mod = mod.default;
    }

    let cv: any = mod;

    // 情况 A：async function，调用后得到 Promise，再 await 出真实模块
    if (typeof cv === "function") {
      try {
        cv = await cv();
      } catch {
        // 有些构建调用 factory 会抛"需环境参数"，继续下面的兜底
      }
    }

    // 情况 B：import 直接拿到 Promise
    if (cv && typeof cv.then === "function") {
      cv = await cv;
    }

    // 情况 C：Promise resolve 后仍不是真实模块（MODULARIZE + onRuntimeInitialized 模式）
    if (!cv || !cv.Mat) {
      await new Promise<void>((resolve, reject) => {
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            reject(new Error("OpenCV 初始化超时（30 秒）"));
          }
        }, 30000);
        if (cv && typeof cv === "object") {
          cv.onRuntimeInitialized = () => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve();
            }
          };
        }
      });
    }

    if (!cv || !cv.Mat) {
      throw new Error("OpenCV 加载失败：无法获取 cv.Mat");
    }

    // 挂到 window 便于调试；本版本不再依赖 jscanify，仅为排查方便
    if (typeof window !== "undefined") {
      (window as any).cv = cv;
    }
    return cv;
  })();

  return cvPromise;
}
