pub mod page;
pub mod snapshot;

pub use page::render_dashboard_page;
pub use snapshot::{get_dashboard_snapshot, DashboardSnapshot};