#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;
mod services;
mod utils;

use std::sync::Arc;

use tracing::{error, info, warn};
use tracing_subscriber::{fmt, EnvFilter};

use services::{CompilerService, FileService, MonitorService, TerminalService, TrashService};
use utils::error_handler::handle_panic;
use utils::path_validator::PathValidator;

#[derive(Clone)]
pub struct AppState {
    pub compiler: Arc<CompilerService>,
    pub file_service: Arc<FileService>,
    pub monitor: Arc<MonitorService>,
    pub terminal: Arc<TerminalService>,
    pub trash: Arc<TrashService>,
}

fn main() {
    std::panic::set_hook(Box::new(|panic_info| {
        error!("Panic occurred: {:?}", panic_info);
        handle_panic(panic_info);
    }));

    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    fmt::fmt()
        .with_env_filter(env_filter)
        .with_target(false)
        .with_thread_ids(true)
        .with_file(true)
        .with_line_number(true)
        .init();

    info!("Starting C-at Editor v1.0.0");

    match PathValidator::get_project_roots_as_strings() {
        Ok(roots) => info!("Project roots: {}", roots.join(" | ")),
        Err(error) => warn!("Failed to resolve project roots: {}", error),
    }

    let compiler = Arc::new(CompilerService::new());
    if compiler.is_available() {
        info!("Detected compiler: {}", compiler.compiler_label());
    } else {
        warn!("No C compiler detected. Run/Syntax features will be limited.");
    }

    let state = AppState {
        compiler,
        file_service: Arc::new(FileService::new()),
        monitor: Arc::new(MonitorService::new()),
        terminal: Arc::new(TerminalService::new()),
        trash: Arc::new(TrashService::new()),
    };

    tauri::Builder::default()
        .manage(state)
        .setup(|app| {
            info!("Application setup completed");
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::compiler::compile_code,
            commands::compiler::check_syntax,
            commands::filesystem::get_files,
            commands::filesystem::get_file_content,
            commands::filesystem::save_file,
            commands::filesystem::create_file,
            commands::filesystem::create_folder,
            commands::filesystem::delete_file_safe,
            commands::filesystem::rename_file,
            commands::projects::get_projects,
            commands::projects::create_project,
            commands::projects::delete_project_safe,
            commands::system::get_system_info,
            commands::system::get_runtime_status,
            commands::terminal::create_terminal_session,
            commands::terminal::execute_terminal_command,
            commands::terminal::set_terminal_cwd,
            commands::terminal::drain_terminal_output,
            commands::terminal::close_terminal_session,
            commands::window::window_minimize,
            commands::window::window_toggle_maximize,
            commands::window::window_is_maximized,
            commands::window::window_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
