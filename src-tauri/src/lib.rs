//! md2pdf-app：把 Markdown 文档渲染为可打印页面，并导出 PDF / PNG。
//!
//! Rust 侧职责：
//! - 读取 Markdown 文件与文档中引用的本地图片（转为 data URI）
//! - 调用本机 Chrome / Edge 的无头模式把 HTML 打印为 PDF
//! - 把前端生成的 PNG 字节写入用户选择的路径

use std::collections::HashMap;
use std::env;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::Serialize;

/// 打印等待浏览器的超时时间。
const BROWSER_TIMEOUT: Duration = Duration::from_secs(120);

/// 读取 Markdown 文本文件。
///
/// 优先按 UTF-8 解码；中文 Windows 下常见的 GBK/ANSI 编码会自动兜底转换，
/// 避免因编码问题导致「文件打不开」。
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))?;

    match String::from_utf8(bytes) {
        Ok(text) => Ok(strip_bom(text)),
        Err(err) => {
            let bytes = err.into_bytes();
            let (decoded, _, had_errors) = encoding_rs::GBK.decode(&bytes);
            if had_errors {
                Err("文件编码无法识别（既不是 UTF-8 也不是 GBK），请另存为 UTF-8 后重试。".to_string())
            } else {
                Ok(strip_bom(decoded.into_owned()))
            }
        }
    }
}

/// 去掉文本开头的 UTF-8 BOM。
fn strip_bom(text: String) -> String {
    match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_string(),
        None => text,
    }
}

/// 读取 Markdown 中引用的本地图片，返回「Markdown 中的原始路径 -> data URI」映射。
///
/// 读取失败的条目会被跳过，不影响其余图片。
#[tauri::command]
fn read_images_base64(dir: String, rel_paths: Vec<String>) -> HashMap<String, String> {
    let base = PathBuf::from(&dir);
    let mut images = HashMap::new();

    for rel in rel_paths {
        let abs = base.join(percent_decode(&rel));
        if !abs.is_file() {
            continue;
        }
        if let Ok(bytes) = fs::read(&abs) {
            let mime = mime_for(&abs);
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            images.insert(rel.clone(), format!("data:{mime};base64,{encoded}"));
        }
    }

    images
}

/// 返回可用的 Chrome / Edge 可执行文件路径（用于在界面上提示导出方式）。
#[tauri::command]
fn detect_browser() -> Option<String> {
    find_browser().map(|p| p.to_string_lossy().into_owned())
}

#[derive(Serialize)]
struct ExportResult {
    /// 实际使用的浏览器路径。
    browser: String,
    /// 用户选择的输出路径。
    pdf_path: String,
}

/// 把完整 HTML 打印为 PDF，写入 `out_path`。
#[tauri::command]
async fn export_pdf(html: String, out_path: String) -> Result<ExportResult, String> {
    let result = tauri::async_runtime::spawn_blocking(move || do_export_pdf(html, out_path))
        .await
        .map_err(|e| format!("导出任务异常：{e}"))?;
    result
}

/// 写出 PNG 等二进制文件。
#[tauri::command]
fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    fs::write(&path, &data).map_err(|e| format!("写入文件失败：{e}"))
}

fn do_export_pdf(html: String, out_path: String) -> Result<ExportResult, String> {
    let browser = find_browser().ok_or_else(|| {
        "未找到 Chrome 或 Edge，无法导出 PDF。请先安装 Chrome 或 Edge 后重试，或改用导出 PNG。".to_string()
    })?;

    let work_dir = env::temp_dir().join(format!("md2pdf-{}", unique_stamp()));
    fs::create_dir_all(&work_dir).map_err(|e| format!("创建临时目录失败：{e}"))?;

    let html_file = work_dir.join("document.html");
    let pdf_file = work_dir.join("document.pdf");
    let profile_dir = work_dir.join("profile");
    let log_file = work_dir.join("browser.log");

    let result = (|| -> Result<(), String> {
        fs::write(&html_file, html.as_bytes()).map_err(|e| format!("写入临时 HTML 失败：{e}"))?;

        let url = format!("file:///{}", html_file.to_string_lossy().replace('\\', "/"));
        let log = File::create(&log_file).map_err(|e| format!("创建日志文件失败：{e}"))?;
        let log_err = log.try_clone().map_err(|e| format!("创建日志文件失败：{e}"))?;

        let child = Command::new(&browser)
            .arg("--headless")
            .arg("--disable-gpu")
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--no-pdf-header-footer")
            .arg(format!("--user-data-dir={}", profile_dir.display()))
            .arg(format!("--print-to-pdf={}", pdf_file.display()))
            .arg(&url)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .spawn()
            .map_err(|e| format!("启动浏览器失败：{e}"))?;

        wait_for_exit(child, BROWSER_TIMEOUT)?;

        if !pdf_file.is_file() {
            return Err(format!("浏览器未生成 PDF：{}", browser_log_tail(&log_file)));
        }
        Ok(())
    })();

    if let Err(message) = result {
        let _ = fs::remove_dir_all(&work_dir);
        return Err(message);
    }

    fs::copy(&pdf_file, &out_path).map_err(|e| format!("写入 PDF 失败（{out_path}）：{e}"))?;
    let _ = fs::remove_dir_all(&work_dir);

    Ok(ExportResult {
        browser: browser.to_string_lossy().into_owned(),
        pdf_path: out_path,
    })
}

/// 等待子进程结束，超时则结束进程并报错。
fn wait_for_exit(mut child: Child, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => return Ok(()),
            Ok(None) => {}
            Err(e) => return Err(format!("等待浏览器退出失败：{e}")),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("浏览器打印超时，请重试。".to_string());
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn browser_log_tail(log_file: &Path) -> String {
    let text = fs::read_to_string(log_file).unwrap_or_default();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "无浏览器输出信息".to_string();
    }
    let tail: String = trimmed.chars().rev().take(400).collect::<String>().chars().rev().collect();
    tail
}

fn find_browser() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    let mut push_under = |var: &str, rest: &str| {
        if let Ok(root) = env::var(var) {
            if !root.trim().is_empty() {
                candidates.push(PathBuf::from(root).join(rest));
            }
        }
    };

    for (var, rest) in [
        ("ProgramFiles", r"Google\Chrome\Application\chrome.exe"),
        ("ProgramFiles(x86)", r"Google\Chrome\Application\chrome.exe"),
        ("LocalAppData", r"Google\Chrome\Application\chrome.exe"),
        ("ProgramFiles", r"Microsoft\Edge\Application\msedge.exe"),
        ("ProgramFiles(x86)", r"Microsoft\Edge\Application\msedge.exe"),
        ("LocalAppData", r"Microsoft\Edge\Application\msedge.exe"),
    ] {
        push_under(var, rest);
    }

    candidates.into_iter().find(|path| path.is_file())
}

fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

/// 解码 Markdown 图片路径中的 %XX 转义。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(value) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn unique_stamp() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}", std::process::id(), nanos)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            read_images_base64,
            detect_browser,
            export_pdf,
            write_binary_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("assets/a%20b.png"), "assets/a b.png");
        assert_eq!(percent_decode("assets/plain.png"), "assets/plain.png");
        // 非法的转义序列保持原样
        assert_eq!(percent_decode("a%zz.png"), "a%zz.png");
    }

    #[test]
    fn maps_image_mime_types() {
        assert_eq!(mime_for(Path::new("a.PNG")), "image/png");
        assert_eq!(mime_for(Path::new("a.jpg")), "image/jpeg");
        assert_eq!(mime_for(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(mime_for(Path::new("a.unknown")), "application/octet-stream");
    }

    #[test]
    fn reads_images_as_data_uri() {
        let dir = env::temp_dir().join(format!("md2pdf-test-{}", unique_stamp()));
        fs::create_dir_all(dir.join("assets")).unwrap();
        // 1x1 的 PNG
        const PNG: &[u8] = &[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ];
        fs::write(dir.join("assets").join("logo.png"), PNG).unwrap();

        let images = read_images_base64(
            dir.to_string_lossy().into_owned(),
            vec!["assets/logo.png".to_string(), "assets/missing.png".to_string()],
        );

        assert_eq!(images.len(), 1, "缺失的图片应被跳过");
        let data_uri = images.get("assets/logo.png").unwrap();
        assert!(data_uri.starts_with("data:image/png;base64,"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_utf8_and_gbk_files() {
        let dir = env::temp_dir().join(format!("md2pdf-enc-{}", unique_stamp()));
        fs::create_dir_all(&dir).unwrap();

        // UTF-8
        let utf8_path = dir.join("utf8.md");
        fs::write(&utf8_path, "# 标题\n\n正文".as_bytes()).unwrap();
        let text = read_text_file(utf8_path.to_string_lossy().into_owned()).expect("UTF-8 读取失败");
        assert!(text.contains("标题"));

        // GBK（中文 Windows 上常见）
        let gbk_path = dir.join("gbk.md");
        let (encoded, _, _) = encoding_rs::GBK.encode("# 标题\n\n正文");
        fs::write(&gbk_path, &encoded).unwrap();
        let text = read_text_file(gbk_path.to_string_lossy().into_owned()).expect("GBK 读取失败");
        assert!(text.contains("标题"), "GBK 解码结果异常：{text}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn strips_utf8_bom() {
        let dir = env::temp_dir().join(format!("md2pdf-bom-{}", unique_stamp()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bom.md");

        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("# 标题".as_bytes());
        fs::write(&path, &bytes).unwrap();

        let text = read_text_file(path.to_string_lossy().into_owned()).unwrap();
        assert!(text.starts_with('#'), "BOM 未被移除：{:?}", &text[..3.min(text.len())]);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 端到端：真的调用本机浏览器把 HTML 打印成 PDF，并检查产物。
    ///
    /// 机器上没有 Chrome / Edge 时跳过（仅打印提示）。
    #[test]
    fn exports_html_to_pdf() {
        if find_browser().is_none() {
            eprintln!("跳过：未找到 Chrome / Edge");
            return;
        }

        let html = r#"<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>导出测试</title>
<style>@page { size: A4; margin: 16mm; } body { font-family: "Microsoft YaHei", sans-serif; }</style>
</head><body><h1>机械臂网口 IP 配置升级说明</h1>
<p>把 IP 修改为 <code>192.128.0.10</code> 后重新上电。</p>
</body></html>"#;

        let out_path = env::temp_dir().join(format!("md2pdf-test-{}.pdf", unique_stamp()));
        let result = do_export_pdf(html.to_string(), out_path.to_string_lossy().into_owned());

        assert!(result.is_ok(), "导出 PDF 失败：{:?}", result.err());

        let bytes = fs::read(&out_path).expect("PDF 文件不存在");
        assert!(bytes.len() > 1024, "PDF 文件过小：{} 字节", bytes.len());
        assert_eq!(&bytes[..4], b"%PDF", "输出不是合法的 PDF");

        // 中文文档必须嵌入字体，否则拷到别的机器会乱码
        let raw = String::from_utf8_lossy(&bytes);
        assert!(raw.contains("FontFile"), "PDF 未嵌入字体");

        let _ = fs::remove_file(&out_path);
    }
}
