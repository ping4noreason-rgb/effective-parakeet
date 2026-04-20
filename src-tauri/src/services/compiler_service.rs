use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use std::env;

use regex::Regex;
use tempfile::TempDir;
use tokio::time::timeout;

use crate::models::{AppError, CompileResult, SyntaxError};

pub struct CompilerService {
    compiler_path: Option<String>,
    timeout_duration: Duration,
}

impl CompilerService {
    pub fn new() -> Self {
        Self {
            compiler_path: Self::find_compiler(),
            timeout_duration: Duration::from_secs(30),
        }
    }

    pub fn is_available(&self) -> bool {
        self.compiler_path.is_some()
    }

    pub fn compiler_label(&self) -> String {
        self.compiler_path
            .as_deref()
            .and_then(|path| Path::new(path).file_name())
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "No compiler detected".to_string())
    }

    fn get_exe_directory() -> Option<PathBuf> {
        env::current_exe().ok().and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
    }

    fn find_compiler() -> Option<String> {
        if let Some(compiler) = Self::find_compiler_near_exe() {
            return Some(compiler);
        }
        
        Self::find_compiler_in_path()
    }

    fn find_compiler_near_exe() -> Option<String> {
        let exe_dir = Self::get_exe_directory()?;
        
        let candidate_paths = vec![
            exe_dir.join("tools").join("tcc").join("tcc.exe"),
            exe_dir.join("tools").join("tcc").join("bin").join("tcc.exe"),
            exe_dir.join("bin").join("tcc").join("tcc.exe"),
            exe_dir.join("compilers").join("tcc").join("tcc.exe"),
            exe_dir.join("tcc").join("tcc.exe"),
            
            exe_dir.join("tools").join("mingw64").join("bin").join("gcc.exe"),
            exe_dir.join("mingw64").join("bin").join("gcc.exe"),
            exe_dir.join("bin").join("gcc.exe"),
            
            exe_dir.join("tools").join("clang").join("bin").join("clang.exe"),
            exe_dir.join("clang").join("bin").join("clang.exe"),
        ];
        
        for path in candidate_paths {
            if path.exists() {
                tracing::info!("Found compiler at: {}", path.display());
                return Some(path.to_string_lossy().to_string());
            }
        }
        
        Self::find_compiler_recursive(&exe_dir)
    }

    fn find_compiler_recursive(exe_dir: &Path) -> Option<String> {
        let target_names = ["tcc.exe", "gcc.exe", "clang.exe"];
        
        for name in target_names {
            if let Some(path) = Self::search_file(exe_dir, name, 3) {
                tracing::info!("Found {} recursively at: {}", name, path.display());
                return Some(path.to_string_lossy().to_string());
            }
        }
        
        None
    }

    fn search_file(dir: &Path, filename: &str, max_depth: usize) -> Option<PathBuf> {
        if max_depth == 0 {
            return None;
        }
        
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                
                if path.is_file() && path.file_name()?.to_str()? == filename {
                    return Some(path);
                }
                
                if path.is_dir() {
                    if let Some(found) = Self::search_file(&path, filename, max_depth - 1) {
                        return Some(found);
                    }
                }
            }
        }
        
        None
    }

    fn find_compiler_in_path() -> Option<String> {
        let compilers = ["tcc", "gcc", "clang", "cc"];
        for compiler in compilers {
            if let Ok(path) = which::which(compiler) {
                tracing::info!("Found {} in PATH: {}", compiler, path.display());
                return Some(path.to_string_lossy().to_string());
            }
        }
        
        tracing::warn!("No C compiler found");
        None
    }

    pub async fn compile(
        &self,
        code: &str,
        filename: Option<&str>,
    ) -> Result<CompileResult, AppError> {
        let compiler_path = self.compiler_path.clone().ok_or_else(|| {
            AppError::Compiler(
                "No C compiler found. Install GCC, Clang, or TCC to use Run from the editor."
                    .to_string(),
            )
        })?;

        let start = Instant::now();
        let temp_dir = TempDir::new().map_err(|e| AppError::Io(e.to_string()))?;

        let src_name = filename.unwrap_or("program.c");
        let src_path = temp_dir.path().join(src_name);

        #[cfg(target_os = "windows")]
        let exe_path = temp_dir.path().join("program.exe");
        #[cfg(not(target_os = "windows"))]
        let exe_path = temp_dir.path().join("program");

        std::fs::write(&src_path, code).map_err(|e| AppError::Io(e.to_string()))?;

        let compiler_path_for_task = compiler_path.clone();
        let compile_result = timeout(
            self.timeout_duration,
            tokio::task::spawn_blocking(move || {
                let output = Command::new(&compiler_path_for_task)
                    .arg(&src_path)
                    .arg("-o")
                    .arg(&exe_path)
                    .output()?;

                Ok::<_, std::io::Error>((output, exe_path, temp_dir))
            }),
        )
        .await;

        match compile_result {
            Ok(Ok(Ok((output, exe_path, _temp_dir)))) => {
                let execution_time = start.elapsed().as_millis() as u64;
                let compiler_name = Path::new(&compiler_path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                if output.status.success() {
                    let program_output = self.run_program(&exe_path).await;

                    Ok(CompileResult {
                        success: true,
                        output: program_output,
                        errors: vec![],
                        execution_time,
                        compiler: compiler_name,
                    })
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    Ok(CompileResult {
                        success: false,
                        output: String::new(),
                        errors: vec![stderr],
                        execution_time,
                        compiler: compiler_name,
                    })
                }
            }
            Ok(Ok(Err(error))) => {
                Err(AppError::Compiler(format!("Compilation failed: {}", error)))
            }
            Ok(Err(error)) => Err(AppError::Compiler(format!(
                "Compilation task failed: {}",
                error
            ))),
            Err(_) => Err(AppError::Timeout(
                "Compilation timeout (30 seconds)".to_string(),
            )),
        }
    }

    async fn run_program(&self, exe_path: &Path) -> String {
        if !exe_path.exists() {
            return "Failed to create executable".to_string();
        }

        let result = timeout(
            Duration::from_secs(5),
            tokio::task::spawn_blocking({
                let exe_path = exe_path.to_path_buf();
                move || {
                    let output = Command::new(&exe_path).output();

                    match output {
                        Ok(out) => {
                            let stdout = String::from_utf8_lossy(&out.stdout);
                            let stderr = String::from_utf8_lossy(&out.stderr);
                            format!("{}{}", stdout, stderr)
                        }
                        Err(error) => format!("Execution error: {}", error),
                    }
                }
            }),
        )
        .await;

        match result {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => format!("Task error: {}", error),
            Err(_) => "Program timeout (5 seconds)".to_string(),
        }
    }

    pub async fn check_syntax(&self, code: &str) -> Result<Vec<SyntaxError>, AppError> {
        let compiler_path = self.compiler_path.clone().ok_or_else(|| {
            AppError::Compiler(
                "No compiler found. Syntax checks are unavailable until a C compiler is installed."
                    .to_string(),
            )
        })?;

        let temp_dir = TempDir::new().map_err(|e| AppError::Io(e.to_string()))?;
        let src_path = temp_dir.path().join("check.c");

        std::fs::write(&src_path, code).map_err(|e| AppError::Io(e.to_string()))?;

        let result = timeout(
            Duration::from_secs(10),
            tokio::task::spawn_blocking(move || {
                let compiler_name = Path::new(&compiler_path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();

                let mut command = Command::new(&compiler_path);
                command.arg("-c").arg(&src_path);

                if compiler_name != "tcc" {
                    command.arg("-fsyntax-only");
                }

                let output = command.output()?;
                Ok::<_, std::io::Error>(String::from_utf8_lossy(&output.stderr).to_string())
            }),
        )
        .await;

        match result {
            Ok(Ok(Ok(stderr))) => Ok(self.parse_errors(&stderr)),
            Ok(Ok(Err(error))) => Err(AppError::Compiler(format!(
                "Syntax check failed: {}",
                error
            ))),
            Ok(Err(error)) => Err(AppError::Compiler(format!(
                "Syntax task failed: {}",
                error
            ))),
            Err(_) => Err(AppError::Timeout("Syntax check timeout".to_string())),
        }
    }

    fn parse_errors(&self, stderr: &str) -> Vec<SyntaxError> {
        let mut errors = Vec::new();
        let regex =
            Regex::new(r"(?:([^:]+):(\d+):(\d+)?:\s*(error|warning):\s*(.+))").unwrap();

        for captures in regex.captures_iter(stderr) {
            let line: usize = captures
                .get(2)
                .and_then(|value| value.as_str().parse().ok())
                .unwrap_or(0);
            let column: usize = captures
                .get(3)
                .and_then(|value| value.as_str().parse().ok())
                .unwrap_or(0);
            let message = captures
                .get(5)
                .map(|value| value.as_str().to_string())
                .unwrap_or_default();
            let error_type = captures
                .get(4)
                .map(|value| value.as_str().to_string())
                .unwrap_or_default();

            errors.push(SyntaxError {
                line: line.saturating_sub(1),
                column,
                message,
                error_type,
            });
        }

        errors
    }
}
