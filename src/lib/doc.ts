/**
 * Markdown 渲染与打印样式。
 *
 * 预览与 PDF 导出共用同一套样式（`docStyles`），区别只在选择器作用域：
 * - 预览注入到应用页面，作用域为 `.doc-body`
 * - 导出 PDF 时生成独立 HTML，作用域为全局
 */
import { marked } from "marked";

/** 打印纸张固定为 A4（210mm × 297mm）。 */
export const PAGE_SIZE_MM = { width: 210, height: 297 } as const;

export interface DocOptions {
  /** 上边距（mm）。 */
  marginTop: number;
  /** 下边距（mm）。 */
  marginBottom: number;
  /** 左边距（mm）。 */
  marginLeft: number;
  /** 右边距（mm）。 */
  marginRight: number;
  /** 图片最大高度（mm），用于避免单张图占满整页。 */
  imageMaxHeight: number;
  /** 正文字号（pt）。 */
  fontSize: number;
}

export const DEFAULT_DOC_OPTIONS: DocOptions = {
  marginTop: 15,
  marginBottom: 16,
  marginLeft: 14,
  marginRight: 14,
  imageMaxHeight: 92,
  fontSize: 10.5,
};

/**
 * Markdown 图片语法。
 * 分组 2 为尖括号包裹的路径（可含空格），分组 3 为普通路径（不含空格），
 * 末尾允许出现 `"标题"`、`'标题'` 形式的可选标题。
 */
const IMAGE_RE = /!\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
/** 文档内直接书写的 <img> 标签。 */
const HTML_IMG_RE = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
/** 判断是否为 http(s)、data: 等绝对地址（这类地址不需要本地读取）。 */
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i;

/** 收集 Markdown 中引用的本地图片路径（保持出现顺序、去重）。 */
export function collectImagePaths(markdown: string): string[] {
  const found = new Set<string>();

  for (const match of markdown.matchAll(IMAGE_RE)) {
    const src = imageSourceOf(match);
    if (src && !ABSOLUTE_URL_RE.test(src) && !src.startsWith("//")) {
      found.add(src);
    }
  }

  for (const match of markdown.matchAll(HTML_IMG_RE)) {
    const src = match[1];
    if (src && !ABSOLUTE_URL_RE.test(src) && !src.startsWith("//")) {
      found.add(src);
    }
  }

  return [...found];
}

/** 从图片语法的匹配结果中取出路径（尖括号形式优先）。 */
function imageSourceOf(match: RegExpMatchArray): string | undefined {
  const src = (match[2] ?? match[3] ?? "").trim();
  return src.length > 0 ? src : undefined;
}

/**
 * 把 Markdown 渲染为 HTML。
 *
 * `images` 为「Markdown 中的原始路径 -> data URI」映射，命中的图片会被替换为内联数据，
 * 使预览与导出结果都不依赖外部文件。
 */
export function renderMarkdown(markdown: string, images: Record<string, string>): string {
  const withInlineImages = markdown.replace(
    IMAGE_RE,
    (whole, alt: string, bracketed: string | undefined, plain: string | undefined) => {
      const src = (bracketed ?? plain ?? "").trim();
      if (!src) return whole;

      const dataUri = lookupImage(images, src);
      return dataUri ? `![${alt}](${dataUri})` : whole;
    },
  );

  return marked.parse(withInlineImages, { gfm: true, async: false }) as string;
}

function lookupImage(images: Record<string, string>, src: string): string | undefined {
  if (images[src]) return images[src];

  try {
    return images[decodeURIComponent(src)];
  } catch {
    return undefined;
  }
}

/**
 * 生成文档样式。
 *
 * @param options 页面与字体参数
 * @param scope 选择器作用域；传空字符串表示用于独立 HTML（全局样式）
 */
export function docStyles(options: DocOptions, scope = ".doc-body"): string {
  const root = scope || "body";
  const s = scope ? `${scope} ` : "";

  return `
@page {
  size: A4;
  margin: ${options.marginTop}mm ${options.marginRight}mm ${options.marginBottom}mm ${options.marginLeft}mm;
}
${root} {
  box-sizing: border-box;
  font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Segoe UI", Arial, sans-serif;
  font-size: ${options.fontSize}pt;
  line-height: 1.75;
  color: #24292f;
  background: #ffffff;
}
${s}* { box-sizing: border-box; }
${s}h1 {
  font-size: 1.75em; font-weight: 700; text-align: center; margin: 0 0 4px;
  padding: 0 0 12px; border-bottom: 2px solid #1f4e79;
}
${s}h2 {
  font-size: 1.28em; font-weight: 700; margin: 22px 0 10px; padding: 5px 0 5px 9px;
  border-left: 4px solid #1f4e79; background: #f4f7fb; break-after: avoid;
}
${s}h3 { font-size: 1.1em; font-weight: 600; margin: 16px 0 8px; color: #1f3a5f; break-after: avoid; }
${s}h4 { font-size: 1em; font-weight: 600; margin: 14px 0 8px; color: #1f3a5f; break-after: avoid; }
${s}h5, ${s}h6 { font-size: 0.95em; font-weight: 600; margin: 12px 0 8px; color: #1f3a5f; }
${s}p { margin: 8px 0; }
${s}ul, ${s}ol { margin: 8px 0; padding-left: 22px; }
${s}ul { list-style: disc; }
${s}ol { list-style: decimal; }
${s}li { margin: 4px 0; }
${s}li > ul, ${s}li > ol { margin: 4px 0; }
${s}table {
  width: 100%; border-collapse: collapse; margin: 10px 0 14px;
  font-size: 0.95em; break-inside: avoid;
}
${s}th, ${s}td { border: 1px solid #c8d0da; padding: 5px 9px; text-align: left; vertical-align: top; }
${s}th { background: #eef3f9; font-weight: 600; white-space: nowrap; }
${s}code {
  font-family: Consolas, "Courier New", monospace; font-size: 0.92em;
  background: #f2f4f7; border: 1px solid #e1e4e8; border-radius: 3px;
  padding: 0 4px; color: #0a3069;
}
${s}pre {
  background: #f6f8fa; border: 1px solid #d8dee4; border-radius: 4px;
  padding: 8px 12px; overflow-x: auto; break-inside: avoid;
}
${s}pre code {
  background: none; border: none; padding: 0; color: #24292f;
  white-space: pre-wrap; word-break: break-all;
}
${s}blockquote {
  margin: 10px 0; padding: 7px 12px; background: #fff8e6;
  border-left: 4px solid #d9a406; color: #5c4400; break-inside: avoid;
}
${s}blockquote p { margin: 0; }
${s}img {
  display: block; max-width: 100%; max-height: ${options.imageMaxHeight}mm;
  width: auto; height: auto; margin: 8px auto;
  border: 1px solid #d8dee4; border-radius: 3px; break-inside: avoid;
}
${s}a { color: #0a58ca; text-decoration: underline; }
${s}hr { border: none; border-top: 1px solid #d8dee4; margin: 16px 0; }
`.trim();
}

/** 组装可交给浏览器打印的完整 HTML 文档。 */
export function buildDocumentHtml(bodyHtml: string, options: DocOptions, title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${docStyles(options, "")}</style>
</head>
<body>
<div class="doc-body">
${bodyHtml}
</div>
</body>
</html>`;
}

/** 取文件名（不含扩展名）。 */
export function fileBaseName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 取所在目录。 */
export function dirName(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : path;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
