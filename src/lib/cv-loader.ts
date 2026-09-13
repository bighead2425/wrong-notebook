// 客户端加载 OpenCV（通过 @techstark/opencv-js npm 包，wasm 已内联，无需外部文件）。
// 该包导出的是 Emscripten MODULARIZE 构建：在不同打包器/浏览器下，import() 拿到的可能是
//   1) 一个 async function（需调用并 await）
//   2) 一个已经启动的 Promise
//   3) 一个带 default 的对象
// jscanify 依赖全局 window.cv，所以加载完成后必须显式把真实模块挂到 window.cv。

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
      } catch (e) {
        // 有些构建调用 factory 会抛“需环境参数”，继续下面的兜底
      }
    }

    // 情况 B：import 直接拿到 Promise（UMD 在浏览器里 factory() 返回 Promise）
    if (cv && typeof cv.then === "function") {
      cv = await cv;
    }

    // 情况 C：Promise resolve 后仍不是真实模块（比如 MODULARIZE + onRuntimeInitialized 模式）
    if (!cv || !cv.Mat) {
      await new Promise<void>((resolve, reject) => {
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            reject(new Error("OpenCV 初始化超时（30 秒）"));
          }
        }, 30000);
        // 给 cv 对象挂上初始化回调；如果 cv 不是对象，这个分支不会被执行
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

    (window as any).cv = cv;
    return cv;
  })();

  return cvPromise;
}
