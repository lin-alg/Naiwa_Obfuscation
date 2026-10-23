# 项目架构

## 目录

```text
index.html                 浏览器入口
styles.css                 页面样式
src/                       浏览器端 ES 模块与处理 Worker
assets/images/             内置静态和 GIF 预设
tests/                     Node.js 自测、浏览器测试和评测脚本
tests/fixtures/             仅供测试使用的图片和清单
docs/                      使用、架构、开发和性能文档
reports/                   本地生成的评测报告
```

应用没有构建步骤或第三方前端依赖。页面由静态 HTTP 服务器提供；图片读取、处理和预设存储均在浏览器本地完成。

## 处理流程

混淆时，`app.mjs` 收集图片、预设和设置，将任务提交给 `worker-pool.mjs`。队列按任务内存估算控制并发，`engine-worker.mjs` 在后台完成图像解码、核心编码、JPG 导出和还原校验；GIF 的帧与嵌入原始数据由 `gif-codec.mjs` 处理。完成后页面提供预览、单项下载和 ZIP 下载。

还原时，Worker 从混淆图文件读取尺寸、分块及载体参数，再调用核心解码逻辑恢复图像。无需源图、预设或手动输入参数。自定义预设只保存在当前浏览器站点的本地存储中。

## 模块职责

| 模块 | 职责 |
|---|---|
| `src/app.mjs` | 页面交互、批量状态、预设与下载流程 |
| `src/core.mjs` | 图像编码、还原、相似度及尺寸规划 |
| `src/engine-worker.mjs` | 在 Worker 中执行图像和 GIF 任务 |
| `src/worker-pool.mjs` | Worker 生命周期、排队、取消和并发限制 |
| `src/gif-codec.mjs` | GIF 解析、调色板索引、帧时序及原始数据封装 |
| `src/processing-settings.mjs`, `src/image-sizing.mjs` | 参数归一化和处理尺寸计算 |
| `src/reed-solomon.mjs` | RS 纠错码和 CRC 校验 |
| `src/preset-store.mjs`, `src/preview-controller.mjs` | 预设持久化和预览交互 |
| `src/zip-store.mjs` | 本地 ZIP 文件生成 |

模块使用原生 ES module。应用入口和样式在仓库根目录，所以浏览器资源 URL 相对网站根路径；Worker 脚本则由 `worker-pool.mjs` 相对自身模块创建。

## 文件格式

编码将块坐标和颜色信息写入 JPEG 载体，并使用 RS(255,159) 和 CRC 校验。当前写入格式 v6，同时读取 v5 和 v6。JPEG 有损压缩会造成像素误差；GIF 会在文件中嵌入原始字节，因此支持逐字节还原。
