/** Tauri 侧能力封装：文件选择、读取、导出。 */
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { collectImagePaths, dirName, fileBaseName } from "./doc";

export interface LoadedDoc {
  /** 文档绝对路径。 */
  path: string;
  /** 文件名（不含扩展名）。 */
  name: string;
  /** 文档所在目录。 */
  dir: string;
  /** Markdown 原文。 */
  content: string;
  /** 图片原始路径 -> data URI。 */
  images: Record<string, string>;
  /** 未能读取到的图片路径。 */
  missingImages: string[];
}

export interface ExportPdfResult {
  browser: string;
  pdfPath: string;
}

/** 是否运行在 Tauri 宿主中（用于区分 `npm run dev` 的纯浏览器调试）。 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 弹出文件选择框，返回所选 Markdown 路径。 */
export async function pickMarkdownPath(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "选择 Markdown 文档",
    filters: [
      { name: "Markdown 文档", extensions: ["md", "markdown", "txt", "mdx"] },
      // 允许选择任意文件，避免文档扩展名与该列表不一致时"看不到文件"
      { name: "所有文件", extensions: ["*"] },
    ],
  });

  // 单文件选择时返回字符串；不同版本/配置下也可能返回数组，这里统一兼容。
  if (typeof selected === "string" && selected.length > 0) return selected;
  if (Array.isArray(selected) && typeof selected[0] === "string" && selected[0].length > 0) {
    return selected[0];
  }
  return null;
}

/** 读取 Markdown 内容，并把它引用的本地图片读成 data URI。 */
export async function loadDocument(path: string): Promise<LoadedDoc> {
  const content = await invoke<string>("read_text_file", { path });
  const dir = dirName(path);
  const imagePaths = collectImagePaths(content);

  const images = imagePaths.length
    ? await invoke<Record<string, string>>("read_images_base64", { dir, relPaths: imagePaths })
    : {};

  return {
    path,
    name: fileBaseName(path),
    dir,
    content,
    images,
    missingImages: imagePaths.filter((item) => !(item in images)),
  };
}

/** 弹出保存对话框，返回目标路径。 */
export async function pickSavePath(
  defaultPath: string,
  filterName: string,
  extensions: string[],
): Promise<string | null> {
  const selected = await save({
    defaultPath,
    title: "选择导出位置",
    filters: [{ name: filterName, extensions }],
  });

  return selected ?? null;
}

/** 调用本机 Chrome / Edge 把 HTML 打印为 PDF。 */
export function exportPdf(html: string, outPath: string): Promise<ExportPdfResult> {
  return invoke<ExportPdfResult>("export_pdf", { html, outPath });
}

/** 写出二进制文件（PNG 等）。 */
export async function writeBinaryFile(path: string, data: Uint8Array): Promise<void> {
  await invoke("write_binary_file", { path, data: Array.from(data) });
}

/** 返回可用的 Chrome / Edge 路径，未找到时为 null。 */
export function detectBrowser(): Promise<string | null> {
  return invoke<string | null>("detect_browser");
}

/** 在资源管理器中定位文件。 */
export async function revealPath(path: string): Promise<void> {
  await revealItemInDir(path);
}
