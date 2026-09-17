use tauri_plugin_sql::{Migration, MigrationKind};
use tauri::Manager;
use std::{fs, io::Read, path::PathBuf};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("record-everything.db"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn export_database(app: tauri::AppHandle, destination: String) -> Result<(), String> {
    let source = database_path(&app)?;
    let destination = PathBuf::from(destination);
    if source == destination { return Err("导出位置不能是当前数据库".into()); }
    fs::copy(source, destination).map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
fn import_database(app: tauri::AppHandle, source: String) -> Result<(), String> {
    let source = PathBuf::from(source);
    let mut file = fs::File::open(&source).map_err(|error| error.to_string())?;
    let mut header = [0_u8; 16];
    file.read_exact(&mut header).map_err(|_| "所选文件不是有效的 SQLite 数据库".to_string())?;
    if &header != b"SQLite format 3\0" {
        return Err("所选文件不是有效的 SQLite 数据库".into());
    }
    let destination = database_path(&app)?;
    if source == destination { return Err("不能导入当前正在使用的数据库".into()); }
    if destination.exists() {
        let backup = destination.with_file_name("record-everything.before-import.db");
        fs::copy(&destination, backup).map_err(|error| error.to_string())?;
    }
    fs::copy(source, destination).map(|_| ()).map_err(|error| error.to_string())
}

fn database_migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_record_everything_schema",
        sql: r#"
            CREATE TABLE IF NOT EXISTS template_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                effective_date TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS number_components (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stable_id TEXT NOT NULL,
                template_version_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT '',
                decimal_places INTEGER NOT NULL DEFAULT 0
                    CHECK (decimal_places BETWEEN 0 AND 4),
                default_value REAL,
                required INTEGER NOT NULL DEFAULT 0
                    CHECK (required IN (0, 1)),
                min_value REAL,
                max_value REAL,
                chart_enabled INTEGER NOT NULL DEFAULT 1
                    CHECK (chart_enabled IN (0, 1)),
                chart_type TEXT NOT NULL DEFAULT 'line'
                    CHECK (chart_type IN ('line', 'bar')),
                statistic TEXT NOT NULL DEFAULT 'latest'
                    CHECK (statistic IN ('latest', 'average', 'min', 'max', 'change')),
                color TEXT NOT NULL DEFAULT '#729b8b',
                sort_order INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (template_version_id)
                    REFERENCES template_versions(id)
                    ON DELETE CASCADE,
                UNIQUE (template_version_id, stable_id),
                CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value)
            );

            CREATE TABLE IF NOT EXISTS daily_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                record_date TEXT NOT NULL UNIQUE,
                template_version_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (template_version_id)
                    REFERENCES template_versions(id)
            );

            CREATE TABLE IF NOT EXISTS number_values (
                record_id INTEGER NOT NULL,
                component_id INTEGER NOT NULL,
                value REAL NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (record_id, component_id),
                FOREIGN KEY (record_id)
                    REFERENCES daily_records(id)
                    ON DELETE CASCADE,
                FOREIGN KEY (component_id)
                    REFERENCES number_components(id)
            );

            CREATE INDEX IF NOT EXISTS idx_template_versions_effective_date
                ON template_versions(effective_date);

            CREATE INDEX IF NOT EXISTS idx_number_components_version_order
                ON number_components(template_version_id, sort_order);

            CREATE INDEX IF NOT EXISTS idx_number_components_stable_id
                ON number_components(stable_id);

            CREATE INDEX IF NOT EXISTS idx_daily_records_record_date
                ON daily_records(record_date);

            CREATE INDEX IF NOT EXISTS idx_number_values_component_id
                ON number_values(component_id);
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 2,
        description: "add_component_active_state",
        sql: r#"
            ALTER TABLE number_components
            ADD COLUMN active INTEGER NOT NULL DEFAULT 1
                CHECK (active IN (0, 1));

            CREATE INDEX IF NOT EXISTS idx_number_components_active
                ON number_components(template_version_id, active, sort_order);
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 3,
        description: "add_weight_component_and_measurement_slots",
        sql: r#"
            ALTER TABLE number_components
            ADD COLUMN component_kind TEXT NOT NULL DEFAULT 'number'
                CHECK (component_kind IN ('number', 'weight'));

            ALTER TABLE number_values RENAME TO number_values_legacy;

            CREATE TABLE number_values (
                record_id INTEGER NOT NULL,
                component_id INTEGER NOT NULL,
                measurement_slot TEXT NOT NULL DEFAULT 'single'
                    CHECK (measurement_slot IN ('single', 'morning', 'evening')),
                value REAL NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (record_id, component_id, measurement_slot),
                FOREIGN KEY (record_id) REFERENCES daily_records(id) ON DELETE CASCADE,
                FOREIGN KEY (component_id) REFERENCES number_components(id)
            );

            INSERT INTO number_values (record_id, component_id, measurement_slot, value, created_at, updated_at)
            SELECT record_id, component_id, 'single', value, created_at, updated_at
            FROM number_values_legacy;

            DROP TABLE number_values_legacy;

            CREATE INDEX idx_number_values_component_id
                ON number_values(component_id);

            UPDATE number_components
               SET component_kind = 'weight', unit = CASE WHEN unit = '斤' THEN '斤' ELSE 'kg' END,
                   decimal_places = 1, default_value = NULL, required = 0,
                   min_value = NULL, max_value = NULL, chart_enabled = 1,
                   chart_type = 'line', statistic = 'latest'
             WHERE stable_id = 'weight';
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 4,
        description: "set_weight_precision_to_two_decimals",
        sql: r#"
            UPDATE number_components
               SET decimal_places = 2
             WHERE component_kind = 'weight';
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 5,
        description: "create_global_todos",
        sql: r#"
            CREATE TABLE global_todos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0
                    CHECK (completed IN (0, 1)),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX idx_global_todos_completed_created
                ON global_todos(completed, created_at, id);
        "#,
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:record-everything.db", database_migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![greet, export_database, import_database])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
