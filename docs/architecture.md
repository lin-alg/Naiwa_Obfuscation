# 项目架构

## 目录

```text
index.html                 浏览器入口
styles.css                 页面样式
src/                       浏览器端 ES 模块与处理 Worker
assets/images/             内置静态和 GIF 参考图
tests/                     Node.js 自测、浏览器测试和评测脚本
tests/fixtures/             仅供测试使用的图片和清单
docs/                      使用、架构、开发和性能文档
reports/                   本地生成的评测报告
```

应用没有构建步骤或第三方前端依赖。页面由静态 HTTP 服务器提供；图片读取、处理和参考图存储均在浏览器本地完成。

## 处理流程

混淆时，`app.mjs` 收集原图、参考图和设置，将任务提交给 `worker-pool.mjs`。队列按任务内存估算控制并发，`engine-worker.mjs` 在后台完成图像解码、核心编码、JPG 导出和还原校验；GIF 的帧与嵌入原始数据由 `gif-codec.mjs` 处理。完成后页面提供预览、单项下载和 ZIP 下载。

还原时，Worker 从混淆图文件读取尺寸、分块及载体参数，再调用核心解码逻辑恢复图像。无需源图、参考图或手动输入参数。自定义参考图只保存在当前浏览器站点的本地存储中。

`preset-store.mjs` 使用 `naiwa-custom-presets` IndexedDB 数据库 v2：`presets` 存储自定义参考图，`builtin-presets` 按资源 URL 与缓存版本存储六张内置图的原始 Blob。首次下载后写入缓存，再次加载优先读缓存；存储不可用时回退到网络。缩略图使用同一 Blob 的对象 URL，避免缓存命中后仍向图片服务器发起请求；参考图选择标识继续使用稳定的资源路径。数据库升级保留 v1 已保存的自定义图片。

幻影坦克由 `phantom-tank.mjs` 在本机生成 RGBA PNG。黑白模式采用 Mirage_Cloak v4 的亮暗映射：内图亮度乘 0.5 作为黑底目标，外图亮度映射至 127–255 作为白底目标，再由两目标之差求 alpha。彩色模式采用 v5 的 RGB alpha 求解公式、0.3/0.6 两侧压缩系数及 0.5/0.5 颜色权重，因此黑底下的内图默认整体变暗。亮度与对比度默认均为 50，不运行自动参数搜索；用户可在折叠的高级设置中手动调整。界面显示输出与未经调节原图比较的双背景 SSIM，分辨率采样至最长边 512 px。“制作”和“显形”预览复用通用画布视口，默认适配容器并支持滚轮缩放、拖拽平移、适应和 1:1。算法公式参考并改写自 [Mirage_Cloak](https://github.com/TankFactory/Mirage_Cloak) v4 `Encoder_v4` 与 v5 `Encoder_v5`，源码位于 `src/scripts/workers/Encoder.worker.js`，默认参数见 `src/DefaultArgumentsConfig.json`。

幻影页默认黑白模式。参考图卡片为选择按钮与独立删除按钮的容器；删除共享自定义图调用混淆页现有的持久化删除与撤销逻辑，删除本次上传的内图则释放其对象 URL。删除已选内图后自动选第一张内置图并重新生成预览。

## 模块职责

| 模块 | 职责 |
|---|---|
| `src/app.mjs` | 页面交互、批量状态、参考图与下载流程 |
| `src/core.mjs` | 图像编码、还原、相似度及尺寸规划 |
| `src/engine-worker.mjs` | 在 Worker 中执行图像和 GIF 任务 |
| `src/worker-pool.mjs` | Worker 生命周期、排队、取消和并发限制 |
| `src/gif-codec.mjs` | GIF 解析、调色板索引、帧时序及原始数据封装 |
| `src/processing-settings.mjs`, `src/image-sizing.mjs` | 参数归一化和处理尺寸计算 |
| `src/phantom-tank.mjs` | 幻影坦克像素合成、图片适配及 PNG 预览导出 |
| `src/reed-solomon.mjs` | RS 纠错码和 CRC 校验 |
| `src/preset-store.mjs`, `src/preview-controller.mjs` | 参考图持久化和预览交互 |
| `src/zip-store.mjs` | 本地 ZIP 文件生成 |

模块使用原生 ES module。应用入口和样式在仓库根目录，所以浏览器资源 URL 相对网站根路径；Worker 脚本则由 `worker-pool.mjs` 相对自身模块创建。

## 文件格式

编码将块坐标和颜色信息写入 JPEG 载体，并使用 RS(255,159) 和 CRC 校验。当前写入格式 v6，同时读取 v5 和 v6。JPEG 有损压缩会造成像素误差；GIF 会在文件中嵌入原始字节，因此支持逐字节还原。
