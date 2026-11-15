pub mod page;
pub mod snapshot;

pub use page::render_dashboard_page;
pub use snapshot::{DashboardSnapshot, get_dashboard_snapshot};
