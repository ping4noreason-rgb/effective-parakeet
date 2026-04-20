use tauri::State;

use crate::models::{AppError, CompileResult, SyntaxError};
use crate::AppState;

#[tauri::command]
pub async fn compile_code(
    code: String,
    filename: Option<String>,
    state: State<'_, AppState>,
) -> Result<CompileResult, AppError> {
    state.compiler.compile(&code, filename.as_deref()).await
}

#[tauri::command]
pub async fn check_syntax(
    code: String,
    state: State<'_, AppState>,
) -> Result<Vec<SyntaxError>, AppError> {
    state.compiler.check_syntax(&code).await
}
