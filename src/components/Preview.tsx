import { forwardRef } from "react";
import { PAGE_SIZE_MM, docStyles, type DocOptions } from "../lib/doc";

interface PreviewProps {
  options: DocOptions;
  html: string;
}

/**
 * A4 纸张预览。
 *
 * 纸张尺寸与页边距使用物理单位（mm），与打印结果保持一致；
 * 样式由 `docStyles` 生成，导出 PDF 时复用同一份样式。
 */
export const Preview = forwardRef<HTMLDivElement, PreviewProps>(function Preview({ options, html }, ref) {
  return (
    <>
      <style>{docStyles(options, ".doc-body")}</style>
      <div className="flex justify-center px-6 py-8">
        <div className="shadow-xl ring-1 ring-slate-300">
          <div
            ref={ref}
            className="doc-body"
            style={{
              width: `${PAGE_SIZE_MM.width}mm`,
              minHeight: `${PAGE_SIZE_MM.height}mm`,
              padding: `${options.marginTop}mm ${options.marginRight}mm ${options.marginBottom}mm ${options.marginLeft}mm`,
              backgroundColor: "#ffffff",
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </>
  );
});
