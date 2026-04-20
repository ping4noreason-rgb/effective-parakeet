use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
    pub modified: String,
    pub extension: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    pub created: String,
    pub modified: String,
    pub file_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileResult {
    pub success: bool,
    pub output: String,
    pub errors: Vec<String>,
    pub execution_time: u64,
    pub compiler: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyntaxError {
    pub line: usize,
    pub column: usize,
    pub message: String,
    pub error_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub ram_total: u64,
    pub ram_used: u64,
    pub ram_free: u64,
    pub ram_percent: u8,
    pub disk_total: u64,
    pub disk_used: u64,
    pub disk_free: u64,
    pub cpu_usage: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeStatus {
    pub compiler_available: bool,
    pub compiler_label: String,
    pub project_roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSessionInfo {
    pub session_id: String,
    pub shell: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalOutputEvent {
    pub stream: String,
    pub text: String,
    pub kind: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[error("Path traversal detected: {0}")]
    PathTraversal(String),
    #[error("File not found: {0}")]
    NotFound(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("Compiler error: {0}")]
    Compiler(String),
    #[error("Terminal error: {0}")]
    Terminal(String),
    #[error("Window error: {0}")]
    Window(String),
    #[error("Timeout error: {0}")]
    Timeout(String),
    #[error("Invalid name: {0}")]
    InvalidName(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
