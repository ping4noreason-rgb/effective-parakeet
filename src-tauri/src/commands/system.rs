use tauri::State;

use crate::models::{AppError, RuntimeStatus, SystemInfo};
use crate::utils::path_validator::PathValidator;
use crate::AppState;

#[tauri::command]
pub async fn get_system_info(
    state: State<'_, AppState>,
) -> Result<SystemInfo, AppError> {
    state.monitor.get_info().await
}

#[tauri::command]
pub async fn get_runtime_status(
    state: State<'_, AppState>,
) -> Result<RuntimeStatus, AppError> {
    Ok(RuntimeStatus {
        compiler_available: state.compiler.is_available(),
        compiler_label: state.compiler.compiler_label(),
        project_roots: PathValidator::get_project_roots_as_strings()?,
    })
}
