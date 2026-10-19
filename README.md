# Markdown 文档导出工具（md2pdf-app）

把 Markdown 文档按打印版式渲染，并导出为 **PDF** 或 **PNG** 图片的桌面小工具。
基于 Tauri 2 + React 19 + TypeScript + Tailwind CSS 4。

## 功能

- 打开（或拖入）本地 Markdown 文档，左侧实时预览 A4 纸张版式
- 文档中引用的本地图片（如 `assets/xxx.png`）自动读取并内联为 data URI，导出结果不依赖原文件
- 自动识别文件编码：UTF-8（含 BOM）优先，中文 Windows 常见的 GBK/ANSI 会自动转换
- 导出 PDF：调用本机 Chrome / Edge 的无头模式打印，输出为矢量 PDF，文字可复制、可检索
- 导出 PNG：前端截图整篇文档为一张长图（2 倍分辨率）
- 可调页面设置：上下／左右边距、图片最大高度、正文字号（纸张固定 A4）

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| Node.js | 22 及以上 |
| Rust | stable 工具链（含 `cargo`） |
| 构建工具 | Windows 需 MSVC（Visual Studio Build Tools 的「C++ 生成工具」） |
| WebView2 Runtime | Windows 10/11 一般已预装 |
| Chrome 或 Edge | 仅导出 PDF 时需要；缺省时仍可导出 PNG |

## 开发与构建

```shell
npm install            # 安装前端依赖
npm run tauri dev      # 开发模式启动桌面应用
npm run tauri build    # 打包安装程序（产物在 src-tauri/target/release/bundle）
npm run build          # 仅构建前端（tsc + vite build）
npm test               # 运行前端单元测试（vitest）
```

## 使用步骤

1. 点击「打开 Markdown」选择文档，或直接把 `.md` 文件拖进窗口。
2. 在右侧「页面设置」中按需调整边距与字号，左侧预览区即为最终版式。
3. 点击「导出 PDF」或「导出 PNG」，选择保存位置。
4. 导出成功后可点击「在文件夹中显示」定位产物。

载入与导出的结果会显示在预览区顶部的状态横幅上；若出现「有 N 张图片未找到」，
说明文档里引用的图片路径与文档实际所在目录不一致（例如把 `.md` 单独拷到了别处，
而 `assets/` 目录没有一起拷贝）。

### 通过 URL 参数打开（开发调试）

应用支持 `?file=<绝对路径>`（URL 编码）直接打开指定文档，便于开发调试与自动化验证：

```
http://localhost:1420/?file=C%3A%5Cdocs%5Cguide.md
```

## 实现说明

### 导出链路

- **PDF**：前端把渲染结果组装成一份自包含 HTML（内联全部 CSS 与图片数据），交给 Rust 侧；
  Rust 把 HTML 写入临时目录，调用 Chrome / Edge 执行
  `--headless --print-to-pdf`，完成后把 PDF 复制到用户选择的位置并清理临时文件。
- **PNG**：前端用 `html2canvas-pro` 对预览区截图（`scale: 2`），通过 Rust 的
  `write_binary_file` 命令写出字节流。

### 样式一致性

预览与 PDF 使用同一套样式的生成函数 `docStyles()`（`src/lib/doc.ts`），只切换选择器作用域：

- 预览：作用域为 `.doc-body`，注入到应用页面中
- PDF：作用域为全局，生成独立 HTML

因此「预览所见」与「PDF 所得」版式一致。分页由浏览器的打印引擎处理，`break-inside: avoid`
用于避免表格、图片、代码块被跨页切断。

## 已知限制

- PDF 不包含页脚页码：`--print-to-pdf` 命令行模式不支持自定义页脚（需要改用 CDP 的
  `Page.printToPDF` 才能带页码）。
- 文档内的原始 HTML 会被原样渲染，请只打开来源可信的 Markdown 文件。
- PNG 为整篇长图，超长文档可能触及浏览器 canvas 尺寸上限，建议长文档改用 PDF。
- 文件对话框由系统提供，窗口需处于激活状态才会显示；若点了「打开 Markdown」没有反应，
  请确认应用窗口在前台。

## 目录结构

```
src/
├─ App.tsx              # 界面与导出流程
├─ components/Preview.tsx  # A4 纸张预览
└─ lib/
   ├─ doc.ts            # Markdown 渲染、打印样式、HTML 组装
   ├─ doc.test.ts       # 上述纯逻辑的单元测试
   └─ api.ts            # Tauri 命令与插件封装
src-tauri/
├─ src/lib.rs           # 读取文件、内联图片、调用浏览器导出 PDF
└─ capabilities/default.json  # 插件权限（dialog / opener）
```
