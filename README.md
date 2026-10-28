# 奶蛙混淆

本地浏览器图片混淆、还原与幻影坦克工具，支持黑白/彩色幻影、手动亮度对比度调整和已有透明幻影图显形。幻影坦克默认使用 Mirage_Cloak 的固定成像映射，不会自动搜索或改动源图参数。静态图、GIF、纠错、幻影坦克和 ZIP 均在本机处理；应用使用原生 ES 模块，无构建步骤或第三方前端依赖。

## 运行

在仓库根目录启动静态服务器：

```powershell
python -m http.server 4173
```

打开 <http://127.0.0.1:4173/>。完整功能说明见[使用指南](docs/user-guide.md)。

## 项目结构

| 路径 | 内容 |
|---|---|
| `index.html`, `styles.css` | 页面入口和样式 |
| `src/` | 图片算法、页面逻辑、GIF 编解码、Worker 和下载模块 |
| `assets/images/` | 应用内置静态及动画参考图 |
| `tests/` | Node.js 自测、浏览器测试和评测脚本 |
| `tests/fixtures/` | 测试图片及样本清单，不参与应用运行 |
| `docs/` | 使用指南、架构说明、开发说明和性能记录 |
| `reports/` | 本地评测生成的报告输出 |

页面通过 `src/app.mjs` 组织界面和任务；混淆与还原由 `src/engine-worker.mjs` 在 Worker 中执行，幻影坦克算法位于 `src/phantom-tank.mjs`。生成、还原和 GIF 处理流程见[架构说明](docs/architecture.md)。

## 算法来源

幻影坦克的像素合成公式参考并改写自 [TankFactory/Mirage_Cloak](https://github.com/TankFactory/Mirage_Cloak) 的 v4 黑白与 v5 彩色实现；本项目于 2026-10-28 适配修改。上游以 GPL-3.0 发布，源码位于 [GitHub 项目页](https://github.com/TankFactory/Mirage_Cloak)。

## 验证

```powershell
node tests/selftest.mjs
node tests/gif-selftest.mjs
```

更多兼容性、浏览器和性能测试命令见[开发与测试](docs/development.md)。测试与评测采用的指标和已验证性能见[性能记录](docs/PERFORMANCE.md)。
