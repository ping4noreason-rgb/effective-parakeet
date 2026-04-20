use std::sync::Arc;
use std::time::{Duration, Instant};

use sysinfo::{Disks, System};
use tokio::sync::Mutex;

use crate::models::{AppError, SystemInfo};

pub struct MonitorService {
    sys: Arc<Mutex<System>>,
    last_update: Arc<Mutex<Instant>>,
    cached_info: Arc<Mutex<Option<SystemInfo>>>,
}

impl MonitorService {
    pub fn new() -> Self {
        Self {
            sys: Arc::new(Mutex::new(System::new_all())),
            last_update: Arc::new(Mutex::new(Instant::now() - Duration::from_secs(10))),
            cached_info: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn get_info(&self) -> Result<SystemInfo, AppError> {
        let now = Instant::now();

        {
            let last_update = self.last_update.lock().await;
            if now.duration_since(*last_update) < Duration::from_secs(5) {
                if let Some(cached) = self.cached_info.lock().await.clone() {
                    return Ok(cached);
                }
            }
        }

        let mut sys = self.sys.lock().await;
        sys.refresh_memory();
        sys.refresh_cpu();

        let ram_total = sys.total_memory();
        let ram_used = sys.used_memory();
        let ram_free = ram_total.saturating_sub(ram_used);
        let ram_percent = if ram_total > 0 {
            ((ram_used as f64 / ram_total as f64) * 100.0) as u8
        } else {
            0
        };

        let disks = Disks::new_with_refreshed_list();
        let mut disk_total = 0u64;
        let mut disk_used = 0u64;
        for disk in disks.list() {
            disk_total += disk.total_space();
            disk_used += disk.total_space().saturating_sub(disk.available_space());
        }

        let cpu_usage = sys.global_cpu_info().cpu_usage();

        let info = SystemInfo {
            ram_total,
            ram_used,
            ram_free,
            ram_percent,
            disk_total,
            disk_used,
            disk_free: disk_total.saturating_sub(disk_used),
            cpu_usage,
        };

        *self.last_update.lock().await = now;
        *self.cached_info.lock().await = Some(info.clone());

        Ok(info)
    }
}