use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tokio::fs as tokio_fs;
use tokio::io::AsyncWriteExt;
use tracing::{info, warn};
use walkdir::WalkDir;

use crate::models::{AppError, FileInfo, ProjectInfo};
use crate::utils::path_validator::PathValidator;

pub struct FileService;

impl FileService {
    pub fn new() -> Self {
        PathValidator::ensure_primary_root()
            .unwrap_or_else(|e| warn!("Failed to prepare project root: {}", e));
        Self
    }

    pub async fn list_files(&self, path: &Path) -> Result<Vec<FileInfo>, AppError> {
        let valid_path = PathValidator::validate_path(path)?;
        let mut files = Vec::new();
        let mut read_dir = tokio_fs::read_dir(&valid_path)
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;

        while let Some(entry) = read_dir
            .next_entry()
            .await
            .map_err(|e| AppError::Io(e.to_string()))?
        {
            let metadata = entry
                .metadata()
                .await
                .map_err(|e| AppError::Io(e.to_string()))?;

            files.push(FileInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                size: metadata.len(),
                is_directory: metadata.is_dir(),
                modified: metadata
                    .modified()
                    .map(Self::format_system_time)
                    .unwrap_or_else(|_| "Unknown".to_string()),
                extension: entry.path().extension().map(|e| e.to_string_lossy().to_string()),
            });
        }

        files.sort_by(|a, b| match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });

        Ok(files)
    }

    pub async fn read_file(&self, path: &Path) -> Result<String, AppError> {
        let valid_path = PathValidator::validate_path(path)?;

        if !valid_path.is_file() {
            return Err(AppError::NotFound(format!(
                "Not a file: {}",
                valid_path.display()
            )));
        }

        if !PathValidator::is_allowed_extension(&valid_path) {
            return Err(AppError::PermissionDenied(format!(
                "Unsupported file extension: {}",
                valid_path.display()
            )));
        }

        let metadata = valid_path
            .metadata()
            .map_err(|e| AppError::Io(e.to_string()))?;
        if metadata.len() > 10 * 1024 * 1024 {
            return Err(AppError::PermissionDenied(format!(
                "File too large ({}MB > 10MB)",
                metadata.len() / 1024 / 1024
            )));
        }

        tokio_fs::read_to_string(&valid_path)
            .await
            .map_err(|e| AppError::Io(e.to_string()))
    }

    pub async fn write_file(&self, path: &Path, content: &str) -> Result<(), AppError> {
        let valid_path = PathValidator::validate_path(path)?;

        if !PathValidator::is_allowed_extension(&valid_path) {
            return Err(AppError::PermissionDenied(format!(
                "Unsupported file extension: {}",
                valid_path.display()
            )));
        }

        if let Some(parent) = valid_path.parent() {
            if !parent.exists() {
                tokio_fs::create_dir_all(parent)
                    .await
                    .map_err(|e| AppError::Io(e.to_string()))?;
            }
        }

        let mut file = tokio_fs::File::create(&valid_path)
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;

        file.write_all(content.as_bytes())
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;
        file.flush()
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;

        info!("File saved: {}", valid_path.display());
        Ok(())
    }

    pub async fn create_file(&self, parent_path: &Path, name: &str) -> Result<FileInfo, AppError> {
        PathValidator::validate_name(name)?;

        let valid_parent = PathValidator::validate_path(parent_path)?;
        if !valid_parent.is_dir() {
            return Err(AppError::NotFound("Parent is not a directory".to_string()));
        }

        let full_path = valid_parent.join(name);
        if full_path.exists() {
            return Err(AppError::PermissionDenied(format!(
                "File already exists: {}",
                name
            )));
        }

        if !PathValidator::is_allowed_extension(&full_path) {
            return Err(AppError::PermissionDenied(format!(
                "Unsupported file extension: {}",
                name
            )));
        }

        tokio_fs::write(&full_path, Self::template_for_file(name))
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;

        let metadata = full_path
            .metadata()
            .map_err(|e| AppError::Io(e.to_string()))?;

        info!("File created: {}", full_path.display());

        Ok(FileInfo {
            name: name.to_string(),
            path: full_path.to_string_lossy().to_string(),
            size: metadata.len(),
            is_directory: false,
            modified: metadata
                .modified()
                .map(Self::format_system_time)
                .unwrap_or_else(|_| "Unknown".to_string()),
            extension: full_path.extension().map(|e| e.to_string_lossy().to_string()),
        })
    }

    pub async fn create_folder(
        &self,
        parent_path: &Path,
        name: &str,
    ) -> Result<FileInfo, AppError> {
        PathValidator::validate_name(name)?;

        let valid_parent = PathValidator::validate_path(parent_path)?;
        let full_path = valid_parent.join(name);

        if full_path.exists() {
            return Err(AppError::PermissionDenied(format!(
                "Folder already exists: {}",
                name
            )));
        }

        tokio_fs::create_dir_all(&full_path)
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;

        let metadata = full_path
            .metadata()
            .map_err(|e| AppError::Io(e.to_string()))?;

        info!("Folder created: {}", full_path.display());

        Ok(FileInfo {
            name: name.to_string(),
            path: full_path.to_string_lossy().to_string(),
            size: metadata.len(),
            is_directory: true,
            modified: metadata
                .modified()
                .map(Self::format_system_time)
                .unwrap_or_else(|_| "Unknown".to_string()),
            extension: None,
        })
    }

    pub async fn rename(&self, old_path: &Path, new_name: &str) -> Result<(), AppError> {
        PathValidator::validate_name(new_name)?;

        let valid_old = PathValidator::validate_path(old_path)?;
        let parent = valid_old
            .parent()
            .ok_or_else(|| AppError::NotFound("Invalid path".to_string()))?;
        let new_path = parent.join(new_name);

        if new_path.exists() {
            return Err(AppError::PermissionDenied(
                "Target already exists".to_string(),
            ));
        }

        if valid_old.is_file() && !PathValidator::is_allowed_extension(&new_path) {
            return Err(AppError::PermissionDenied(format!(
                "Unsupported file extension: {}",
                new_name
            )));
        }

        tokio_fs::rename(&valid_old, &new_path)
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;

        info!("Renamed: {} -> {}", valid_old.display(), new_path.display());
        Ok(())
    }

    pub async fn get_projects(&self) -> Result<Vec<ProjectInfo>, AppError> {
        let roots = PathValidator::get_project_roots()?;
        let mut projects = Vec::new();
        let mut seen = HashSet::new();

        for root in roots {
            let root_projects = self.collect_projects_from_root(&root).await?;
            for project in root_projects {
                let key = project.path.to_lowercase();
                if seen.insert(key) {
                    projects.push(project);
                }
            }
        }

        projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(projects)
    }

    pub async fn create_project(&self, name: &str) -> Result<ProjectInfo, AppError> {
        PathValidator::validate_name(name)?;

        if self.find_existing_project(name).await?.is_some() {
            return Err(AppError::PermissionDenied(format!(
                "Project already exists: {}",
                name
            )));
        }

        let project_root = PathValidator::ensure_primary_root()?;
        let project_path = project_root.join(name);

        tokio_fs::create_dir_all(&project_path)
            .await
            .map_err(|e| AppError::Io(format!("Failed to create project dir: {}", e)))?;

        if let Err(error) = self.write_project_scaffold(&project_path, name).await {
            if let Err(cleanup_error) = tokio_fs::remove_dir_all(&project_path).await {
                warn!(
                    "Failed to cleanup incomplete project scaffold {}: {}",
                    project_path.display(),
                    cleanup_error
                );
            }
            return Err(error);
        }

        let metadata = project_path
            .metadata()
            .map_err(|e| AppError::Io(e.to_string()))?;
        let file_count = Self::count_project_files(&project_path);

        info!("Project created: {}", project_path.display());

        Ok(ProjectInfo {
            name: name.to_string(),
            path: project_path.to_string_lossy().to_string(),
            created: metadata
                .created()
                .map(Self::format_system_time)
                .unwrap_or_else(|_| "Unknown".to_string()),
            modified: metadata
                .modified()
                .map(Self::format_system_time)
                .unwrap_or_else(|_| "Unknown".to_string()),
            file_count,
        })
    }

    async fn collect_projects_from_root(&self, root: &Path) -> Result<Vec<ProjectInfo>, AppError> {
        if !root.exists() {
            return Ok(Vec::new());
        }

        let mut projects = Vec::new();
        let mut read_dir = tokio_fs::read_dir(root)
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;

        while let Some(entry) = read_dir
            .next_entry()
            .await
            .map_err(|e| AppError::Io(e.to_string()))?
        {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let metadata = path.metadata().map_err(|e| AppError::Io(e.to_string()))?;
            let file_count = Self::count_project_files(&path);

            projects.push(ProjectInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                created: metadata
                    .created()
                    .map(Self::format_system_time)
                    .unwrap_or_else(|_| "Unknown".to_string()),
                modified: metadata
                    .modified()
                    .map(Self::format_system_time)
                    .unwrap_or_else(|_| "Unknown".to_string()),
                file_count,
            });
        }

        Ok(projects)
    }

    async fn find_existing_project(&self, name: &str) -> Result<Option<PathBuf>, AppError> {
        let projects = self.get_projects().await?;
        Ok(projects
            .into_iter()
            .find(|project| project.name.eq_ignore_ascii_case(name))
            .map(|project| PathBuf::from(project.path)))
    }

    async fn write_project_scaffold(
        &self,
        project_path: &Path,
        project_name: &str,
    ) -> Result<(), AppError> {
        let main_c_path = project_path.join("main.c");
        let readme_path = project_path.join("README.md");

        tokio_fs::write(&main_c_path, Self::default_main_c())
            .await
            .map_err(|e| AppError::Io(format!("Failed to create main.c: {}", e)))?;

        tokio_fs::write(&readme_path, Self::default_readme(project_name))
            .await
            .map_err(|e| AppError::Io(format!("Failed to create README.md: {}", e)))?;

        Ok(())
    }

    fn template_for_file(name: &str) -> String {
        if name.ends_with(".c")
            || name.ends_with(".cpp")
            || name.ends_with(".cc")
            || name.ends_with(".cxx")
        {
            return Self::default_main_c();
        }

        if name.ends_with(".h")
            || name.ends_with(".hpp")
            || name.ends_with(".hh")
            || name.ends_with(".hxx")
        {
            let guard = name.to_uppercase().replace('.', "_");
            return format!("#ifndef {}\n#define {}\n\n\n#endif\n", guard, guard);
        }

        if name.eq_ignore_ascii_case("README.md") {
            return "# Project Notes\n\n".to_string();
        }

        String::new()
    }

    fn default_main_c() -> String {
        r#"#include <stdio.h>

int main(void) {
    printf("Hello from Cat Editor!\n");
    return 0;
}
"#
        .to_string()
    }

    fn default_readme(project_name: &str) -> String {
        format!(
            "# {}\n\nCreated with Cat Editor.\n\n- `main.c` contains the starter program.\n- Use Ctrl+S to save and Ctrl+R to run.\n",
            project_name
        )
    }

    fn count_project_files(path: &Path) -> u64 {
        WalkDir::new(path)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_file())
            .count() as u64
    }

    fn format_system_time(time: SystemTime) -> String {
        chrono::DateTime::<chrono::Local>::from(time)
            .format("%Y-%m-%d %H:%M:%S")
            .to_string()
    }
}
