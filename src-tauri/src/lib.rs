//! MuseLab 的平台层：只做三件事——单实例、自动更新、原生文件对话框。
//!
//! 乐谱与音频全在前端（TypeScript），Rust 侧刻意保持薄：
//! 这样内核能被 Node 直接单测（scripts/verify.ts），不会被原生依赖绑死。
//!
//! 为什么自己写 save/open 而不用 tauri-plugin-fs：
//! fs 插件的权限 scope 要按目录配置，配松了等于给整个磁盘写权限，配紧了用户又存不进
//! 「另存为」随手选的路径。路径由系统对话框出来、由用户当场点头，这个模型天然是安全的，
//! 用不着再维护一套 scope 规则。

use serde::Serialize;
use std::sync::mpsc;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// 用户等待选文件的时间上限：超过就当作取消，不让命令永远挂着
const PICK_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Serialize)]
pub struct OpenedFile {
    name: String,
    path: String,
    bytes: Vec<u8>,
}

/// 保存文件：弹「另存为」，然后写盘。返回实际落盘路径（用户取消返回 null）。
#[tauri::command]
async fn save_file(
    app: AppHandle,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    let name = file_name.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel();
        app.dialog()
            .file()
            .set_file_name(&name)
            .save_file(move |p| {
                let _ = tx.send(p);
            });
        rx.recv_timeout(PICK_TIMEOUT).ok().flatten()
    })
    .await
    .map_err(|e| format!("对话框线程出错：{e}"))?;

    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("路径无法解析：{e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("写入失败：{e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 打开文件：弹「选择文件」，读成字节返回给前端解析。
#[tauri::command]
async fn open_file(app: AppHandle) -> Result<Option<OpenedFile>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel();
        app.dialog().file().pick_file(move |p| {
            let _ = tx.send(p);
        });
        rx.recv_timeout(PICK_TIMEOUT).ok().flatten()
    })
    .await
    .map_err(|e| format!("对话框线程出错：{e}"))?;

    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("路径无法解析：{e}"))?;
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败：{e}"))?;
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名文件".to_string());
    Ok(Some(OpenedFile {
        name,
        path: path.to_string_lossy().to_string(),
        bytes,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 深链队列：既要 manage 给命令用，又要传给冷启动 seed —— 两处必须同一份。
    let zbiz_pending = cap_hub::receiver::SharedPending::default();

    tauri::Builder::default()
        // 单实例：第二次启动聚焦已有窗口（必须是第一个注册的插件）
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            cap_hub::receiver::handle_second_instance(app, &argv);
        }))
        .manage(zbiz_pending.clone())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_file,
            open_file,
            zbiz_take_pending
        ])
        .setup(move |app| {
            cap_hub::receiver::seed_cold_start(app.handle(), &zbiz_pending);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri 应用启动失败");
}

/// 取走队列里的深链（家族统一命令名）。
#[tauri::command]
fn zbiz_take_pending(
    pending: tauri::State<'_, cap_hub::receiver::SharedPending>,
) -> Vec<cap_hub::Handoff> {
    cap_hub::receiver::take_pending_from(pending.inner())
}
