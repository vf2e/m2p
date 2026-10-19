import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOC_OPTIONS,
  buildDocumentHtml,
  collectImagePaths,
  dirName,
  docStyles,
  fileBaseName,
  renderMarkdown,
} from "./doc";

describe("collectImagePaths", () => {
  it("收集相对路径的图片，忽略绝对地址与重复项", () => {
    const markdown = [
      "![图 1](assets/01-entry.png)",
      "![图 2](<assets/02 panel.png>)",
      '![图 3](assets/01-entry.png "标题")',
      "![远程](https://example.com/a.png)",
      "![内联](data:image/png;base64,AAAA)",
      '<img src="assets/03-result.png" width="100">',
    ].join("\n\n");

    expect(collectImagePaths(markdown)).toEqual([
      "assets/01-entry.png",
      "assets/02 panel.png",
      "assets/03-result.png",
    ]);
  });

  it("没有图片时返回空数组", () => {
    expect(collectImagePaths("# 标题\n\n正文")).toEqual([]);
  });
});

describe("renderMarkdown", () => {
  it("把命中的图片替换为 data URI", () => {
    const dataUri = "data:image/png;base64,AAAA";
    const html = renderMarkdown("![图 1](assets/01.png)", { "assets/01.png": dataUri });

    expect(html).toContain(`src="${dataUri}"`);
    expect(html).toContain('alt="图 1"');
  });

  it("未命中的图片保留原路径", () => {
    const html = renderMarkdown("![图 1](assets/missing.png)", {});
    expect(html).toContain('src="assets/missing.png"');
  });

  it("支持百分号转义的路径", () => {
    const dataUri = "data:image/png;base64,BBBB";
    const html = renderMarkdown("![图](assets/a%20b.png)", { "assets/a b.png": dataUri });
    expect(html).toContain(`src="${dataUri}"`);
  });

  it("支持尖括号包裹、含空格的路径", () => {
    const dataUri = "data:image/png;base64,CCCC";
    const html = renderMarkdown("![图](<assets/02 panel.png>)", { "assets/02 panel.png": dataUri });
    expect(html).toContain(`src="${dataUri}"`);
  });

  it("渲染 GFM 表格与行内代码", () => {
    const html = renderMarkdown(
      "| 项目 | 说明 |\n| --- | --- |\n| IP | `192.128.0.10` |\n",
      {},
    );

    expect(html).toContain("<table>");
    expect(html).toContain("<code>192.128.0.10</code>");
  });
});

describe("docStyles", () => {
  it("预览样式带作用域，PDF 样式为全局", () => {
    const scoped = docStyles(DEFAULT_DOC_OPTIONS);
    const global = docStyles(DEFAULT_DOC_OPTIONS, "");

    expect(scoped).toContain(".doc-body h1");
    expect(scoped).not.toContain("\nh1 {");
    expect(global).toContain("\nh1 {");
    expect(global).toContain("body {");
  });

  it("纸张固定为 A4，边距写入 @page 规则", () => {
    const css = docStyles({ ...DEFAULT_DOC_OPTIONS, marginTop: 20 });
    expect(css).toContain("size: A4;");
    expect(css).toContain("margin: 20mm");
  });
});

describe("buildDocumentHtml", () => {
  it("生成自包含的 HTML，并转义标题", () => {
    const html = buildDocumentHtml("<p>正文</p>", DEFAULT_DOC_OPTIONS, "升级说明 <A&B>");

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<title>升级说明 &lt;A&amp;B&gt;</title>");
    expect(html).toContain('<div class="doc-body">');
  });
});

describe("路径工具", () => {
  it("在 Windows 与 POSIX 路径下都能取到文件名和目录", () => {
    expect(fileBaseName("C:\\docs\\升级说明.md")).toBe("升级说明");
    expect(dirName("C:\\docs\\升级说明.md")).toBe("C:\\docs");
    expect(fileBaseName("/tmp/a.b.md")).toBe("a.b");
    expect(dirName("/tmp/a.b.md")).toBe("/tmp");
  });
});
