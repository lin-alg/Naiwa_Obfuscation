# 开发与测试

## 环境

- Node.js：运行 `.mjs` 自测、评测和辅助工具。
- Python：`zip-selftest.mjs` 使用 Python 标准库验证 ZIP 内容。
- Chrome：运行浏览器测试；可通过 `CHROME_EXECUTABLE` 指定可执行文件。
- FFmpeg：运行命令行图像评测。

应用由仓库根目录的静态 HTTP 服务器提供。启动 `python -m http.server 4173` 后，可在另一终端运行浏览器测试。

## 测试

快速验证算法、GIF、兼容性和 ZIP：

```powershell
node tests/selftest.mjs
node tests/gif-selftest.mjs
node tests/compatibility.mjs
node tests/zip-selftest.mjs
```

`browser-smoke.mjs` 覆盖新手引导及其本地记录、参考图共享与独立参数、圆环单张处理、图片生成与还原、预览、下载、参考图、GIF、ZIP 和响应式布局。追加 `--tutorial-only` 可只验证新手引导；追加 `--background` 可后台运行；追加 `--reports` 会检查交互式评测页面。

```powershell
node tests/browser-smoke.mjs
node tests/browser-performance.mjs --background
```

浏览器性能测试应单独运行，避免与其他重负载任务争用资源。它比较 Git 基准版本与当前版本；兼容性和性能对比脚本依赖仓库历史中存在的基准提交 `b5d2b4f`。

## 评测

批量评测需要 FFmpeg。可先缩小图片筛选参数，再对入选配置做原尺寸测试：

```powershell
node --expose-gc tests/benchmark.mjs --count=4 --tiles=8 --scales=2,3 --steps=16,24 --gains=0.5,0.75 --presets=0,1,2,3 --max-side=768 --report=screening
node --expose-gc tests/benchmark.mjs --count=4 --profiles=2:16:0.5,2:16:0.75,3:16:0.75,3:24:0.75 --presets=0,1,2,3 --report=native
```

`--qualities=95,85,75,65,55`、`--threshold=0.5`、`--fit=contain|cover|stretch`、`--color-adapt=no`、`--color-gain=0.75` 和 `--edges=no` 可控制评测参数；`--background` 可保存后台日志。

其他工具：

| 命令 | 用途 |
|---|---|
| `node tests/performance-samples.mjs --max-side=768` | 检查四张样本的默认参数耗时和效果 |
| `node tests/compact-benchmark.mjs` | 比较常用分块和倍率组合 |
| `node tests/edge-benchmark.mjs` | 评测透明图、窄图和边界尺寸等案例 |
| `node tests/preview.mjs` | 导出单张算法预览图 |
| `node tests/profile-summary.mjs` | 汇总已有性能剖析数据 |

评测脚本读取 `tests/fixtures/` 中的样本，内置参考图来自 `assets/images/`。临时日志、下载和浏览器配置保存在被忽略的 `.test-artifacts/`；长期 HTML、JSON、CSV 和曲线报告写入被忽略的 `reports/`。

评测主要比较 JPG 文件大小、还原 SSIM 和混淆图与参考图的相似度。SSIM 使用互不重叠的 8×8 局部窗口；恢复分数在最长边约 512 px 的亮度图上计算，参考图轮廓分数在最长边约 64 px 的 RGB 图上计算，参考图细节分数在最长边约 512 px 的 RGB 图上计算。缩图评测以缩小后 JPEG-95 文件大小为基准，不应与原图分辨率结果直接比较。

评测报告页面可通过 `reports/index.html` 查看；浏览器测试检查评测页面时需要本地已有报告文件。历史性能数据与复测步骤见[性能记录](PERFORMANCE.md)。
