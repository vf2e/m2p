import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Preview } from "./components/Preview";
import {
  DEFAULT_DOC_OPTIONS,
  buildDocumentHtml,
  renderMarkdown,
  type DocOptions,
} from "./lib/doc";
import {
  detectBrowser,
  exportPdf,
  isTauri,
  loadDocument,
  pickMarkdownPath,
  pickSavePath,
  revealPath,
  writeBinaryFile,
  type LoadedDoc,
} from "./lib/api";

type StatusKind = "info" | "success" | "error";

interface StatusMessage {
  kind: StatusKind;
  text: string;
  /** 导出成功后的产物路径，用于「在文件夹中显示」。 */
  path?: string;
}

const BUTTON_BASE =
  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
const BUTTON_PRIMARY = `${BUTTON_BASE} bg-blue-600 text-white hover:bg-blue-700`;
const BUTTON_GHOST = `${BUTTON_BASE} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`;

/** 页面设置区数字输入框的统一样式（固定高度，保证行间对齐）。 */
const CONTROL_CLASS = "h-8 rounded border border-slate-300 px-2 text-sm";

export default function App() {
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [options, setOptions] = useState<DocOptions>(DEFAULT_DOC_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  // undefined 表示尚未检测完成
  const [browser, setBrowser] = useState<string | null | undefined>(undefined);
  const previewRef = useRef<HTMLDivElement>(null);

  const html = useMemo(() => (doc ? renderMarkdown(doc.content, doc.images) : ""), [doc]);

  useEffect(() => {
    if (!isTauri()) {
      setBrowser(null);
      return;
    }
    detectBrowser()
      .then(setBrowser)
      .catch(() => setBrowser(null));
  }, []);

  const openDocument = useCallback(async (path: string) => {
    setBusy(true);
    setStatus({ kind: "info", text: "正在读取文档…" });
    try {
      const loaded = await loadDocument(path);
      setDoc(loaded);
      setStatus({
        kind: loaded.missingImages.length > 0 ? "error" : "success",
        text:
          loaded.missingImages.length > 0
            ? `已载入 ${loaded.name}，但有 ${loaded.missingImages.length} 张图片未找到：${loaded.missingImages.join("、")}`
            : `已载入 ${loaded.name}`,
      });
    } catch (error) {
      setStatus({ kind: "error", text: toMessage(error) });
    } finally {
      setBusy(false);
    }
  }, []);

  const handleOpen = useCallback(async () => {
    if (!isTauri()) {
      setStatus({ kind: "error", text: "文件选择需要在桌面应用中使用，请通过 npm run tauri dev 启动。" });
      return;
    }
    try {
      const path = await pickMarkdownPath();
      if (!path) {
        setStatus({ kind: "info", text: "没有选择文件（对话框被取消或未返回路径）。" });
        return;
      }
      await openDocument(path);
    } catch (error) {
      setStatus({ kind: "error", text: `打开文件失败：${toMessage(error)}` });
    }
  }, [openDocument]);

  // 支持通过 URL 参数直接打开文档：?file=<绝对路径>
  // 便于从命令行、快捷方式或其它程序跳转过来。
  useEffect(() => {
    const file = new URLSearchParams(window.location.search).get("file");
    if (file) void openDocument(file);
  }, [openDocument]);

  // 支持把 Markdown 文件直接拖进窗口。
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "drop" && event.payload.paths.length > 0) {
            void openDocument(event.payload.paths[0]);
          }
        }),
      )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openDocument]);

  const handleExportPdf = useCallback(async () => {
    if (!doc) return;

    if (!browser) {
      setStatus({
        kind: "error",
        text: "未检测到 Chrome 或 Edge，无法导出 PDF。可改用「导出 PNG」。",
      });
      return;
    }

    setBusy(true);
    setStatus({ kind: "info", text: "正在生成 PDF…" });
    try {
      const outPath = await pickSavePath(`${doc.dir}\\${doc.name}.pdf`, "PDF 文档", ["pdf"]);
      if (!outPath) {
        setStatus(null);
        return;
      }
      const fullHtml = buildDocumentHtml(html, options, doc.name);
      const result = await exportPdf(fullHtml, outPath);
      setStatus({
        kind: "success",
        text: `PDF 已导出：${result.pdfPath}（调用 ${browserName(result.browser)}）`,
        path: result.pdfPath,
      });
    } catch (error) {
      setStatus({ kind: "error", text: toMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [browser, doc, html, options]);

  const handleExportPng = useCallback(async () => {
    const element = previewRef.current;
    if (!doc || !element) return;

    setBusy(true);
    setStatus({ kind: "info", text: "正在渲染 PNG…" });
    try {
      // 按需加载截图库，避免增大应用启动体积。
      const { default: html2canvas } = await import("html2canvas-pro");

      const canvas = await html2canvas(element, {
        scale: 2,
        backgroundColor: "#ffffff",
        useCORS: true,
        logging: false,
      });

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("生成 PNG 失败");

      const outPath = await pickSavePath(`${doc.dir}\\${doc.name}.png`, "PNG 图片", ["png"]);
      if (!outPath) {
        setStatus(null);
        return;
      }

      await writeBinaryFile(outPath, new Uint8Array(await blob.arrayBuffer()));
      setStatus({ kind: "success", text: `PNG 已导出：${outPath}`, path: outPath });
    } catch (error) {
      setStatus({ kind: "error", text: toMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [doc]);

  const setMargin = useCallback((key: "vertical" | "horizontal", value: number) => {
    setOptions((current) =>
      key === "vertical"
        ? { ...current, marginTop: value, marginBottom: value }
        : { ...current, marginLeft: value, marginRight: value },
    );
  }, []);

  const patchOptions = useCallback((patch: Partial<DocOptions>) => {
    setOptions((current) => ({ ...current, ...patch }));
  }, []);

  return (
    <div className="flex h-full flex-col bg-slate-100 text-slate-800">
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-base font-semibold text-slate-900">Markdown 文档导出工具</h1>
          <span className="text-xs text-slate-500">PDF / PNG</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button className={BUTTON_GHOST} onClick={handleOpen} disabled={busy}>
            打开 Markdown
          </button>
          <button className={BUTTON_PRIMARY} onClick={handleExportPdf} disabled={busy || !doc}>
            导出 PDF
          </button>
          <button className={BUTTON_GHOST} onClick={handleExportPng} disabled={busy || !doc}>
            导出 PNG
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 状态横幅固定在预览区顶部，确保载入/导出结果不会被忽略 */}
          {status && (
            <div
              className={`flex shrink-0 items-start gap-3 border-b px-4 py-2 text-sm ${
                status.kind === "error"
                  ? "border-red-200 bg-red-50 text-red-700"
                  : status.kind === "success"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-slate-200 bg-slate-100 text-slate-600"
              }`}
            >
              <span className="min-w-0 flex-1 break-all">{status.text}</span>
              {status.path && (
                <button
                  className="shrink-0 underline"
                  onClick={() => void revealPath(status.path as string).catch(() => undefined)}
                >
                  在文件夹中显示
                </button>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto">
            {doc ? (
              <Preview ref={previewRef} options={options} html={html} />
            ) : (
              <EmptyState onOpen={handleOpen} busy={busy} />
            )}
          </div>
        </main>

        <aside className="flex w-80 shrink-0 flex-col gap-5 overflow-auto border-l border-slate-200 bg-white p-5">
          <section className="space-y-2">
            <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">当前文档</h2>
            {doc ? (
              <div className="space-y-1 text-sm">
                <p className="font-medium break-all text-slate-800">{doc.name}</p>
                <p className="text-xs break-all text-slate-500">{doc.path}</p>
                <p className="text-xs text-slate-500">
                  内联图片 {Object.keys(doc.images).length} 张
                  {doc.missingImages.length > 0 ? `，未找到 ${doc.missingImages.length} 张` : ""}
                </p>
              </div>
            ) : (
              <p className="text-sm text-slate-500">尚未载入文档</p>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">页面设置</h2>

            <NumberField
              label="上下边距"
              value={options.marginTop}
              suffix="mm"
              min={0}
              max={60}
              onChange={(value) => setMargin("vertical", value)}
            />
            <NumberField
              label="左右边距"
              value={options.marginLeft}
              suffix="mm"
              min={0}
              max={60}
              onChange={(value) => setMargin("horizontal", value)}
            />
            <NumberField
              label="图片最大高度"
              value={options.imageMaxHeight}
              suffix="mm"
              min={20}
              max={240}
              onChange={(value) => patchOptions({ imageMaxHeight: value })}
            />
            <NumberField
              label="正文字号"
              value={options.fontSize}
              suffix="pt"
              min={7}
              max={16}
              step={0.5}
              onChange={(value) => patchOptions({ fontSize: value })}
            />
          </section>

          <section className="space-y-2">
            <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">导出环境</h2>
            <p className="text-xs break-all text-slate-500">
              {browser === undefined
                ? "正在检测浏览器…"
                : browser
                  ? `PDF 打印：${browserName(browser)}`
                  : "未检测到 Chrome / Edge，仅可导出 PNG"}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function EmptyState({ onOpen, busy }: { onOpen: () => void; busy: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <h2 className="text-lg font-semibold text-slate-700">拖入或选择 Markdown 文档</h2>
      <p className="max-w-md text-sm text-slate-500">
        支持 .md / .markdown / .txt。文档中引用的本地图片（如 assets/xxx.png）会自动读取并内联，
        导出结果不依赖原始文件。
      </p>
      <button className={BUTTON_PRIMARY} onClick={onOpen} disabled={busy}>
        选择文件
      </button>
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  suffix: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}

function NumberField({ label, value, suffix, min, max, step = 1, onChange }: NumberFieldProps) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm text-slate-600">
      <span>{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          className={`w-20 text-right ${CONTROL_CLASS}`}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isNaN(next)) onChange(Math.min(max, Math.max(min, next)));
          }}
        />
        <span className="w-6 text-xs text-slate-400">{suffix}</span>
      </span>
    </label>
  );
}

function browserName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  const lower = file.toLowerCase();
  if (lower.includes("msedge")) return "Edge";
  if (lower.includes("chrome")) return "Chrome";
  return file;
}

function toMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
