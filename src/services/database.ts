import Database from "@tauri-apps/plugin-sql";

export type ChartType = "line" | "bar";
export type StatisticType = "latest" | "average" | "min" | "max" | "change";

export interface NumberComponent {
  databaseId: number | null;
  id: string;
  type: "number" | "weight";
  label: string;
  hint: string;
  unit: string;
  decimalPlaces: number;
  defaultValue: number | null;
  required: boolean;
  minValue: number | null;
  maxValue: number | null;
  chart: boolean;
  chartType: ChartType;
  statistic: StatisticType;
  color: string;
}

export interface LoadedDay {
  templateVersionId: number;
  components: NumberComponent[];
  values: Record<string, number | null>;
  touched: Record<string, boolean>;
  hasRecord: boolean;
}

interface IdRow { id: number }
interface CountRow { count: number }
interface ComponentRow {
  id: number; stable_id: string; name: string; unit: string;
  decimal_places: number; default_value: number | null; required: number;
  min_value: number | null; max_value: number | null; chart_enabled: number;
  chart_type: ChartType; statistic: StatisticType; color: string; component_kind: "number" | "weight";
}
interface ValueRow { stable_id: string; value: number; measurement_slot: "single" | "morning" | "evening" }
interface DateRow { record_date: string }
interface SeriesRow { value: number; record_date: string; measurement_slot: "single" | "morning" | "evening" }
export interface SeriesPoint { date: string; value: number }
export interface ComponentSeries { single: SeriesPoint[]; morning: SeriesPoint[]; evening: SeriesPoint[] }
export interface TodoItem { id: number; content: string; completed: boolean }
interface TodoRow { id: number; content: string; completed: number }

export const DATABASE_URL = "sqlite:record-everything.db";
let databasePromise: Promise<Database> | null = null;

export function getDatabase(): Promise<Database> {
  if (!databasePromise) {
    databasePromise = Database.load(DATABASE_URL).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

export async function closeDatabase(): Promise<void> {
  if (!databasePromise) return;
  const database = await databasePromise;
  await database.close();
  databasePromise = null;
}

export async function clearAllData(): Promise<void> {
  const database = await getDatabase();
  await database.execute("DELETE FROM number_values");
  await database.execute("DELETE FROM daily_records");
  await database.execute("DELETE FROM number_components");
  await database.execute("DELETE FROM template_versions");
  await database.execute("DELETE FROM global_todos");
}

export async function initializeDatabase(today: string): Promise<void> {
  const database = await getDatabase();
  let versions = await database.select<IdRow[]>("SELECT id FROM template_versions ORDER BY effective_date LIMIT 1");
  if (!versions.length) {
    const result = await database.execute("INSERT INTO template_versions (effective_date) VALUES ($1)", [today]);
    versions = [{ id: Number(result.lastInsertId) }];
  }
  const versionId = Number(versions[0].id);
  const componentCount = await database.select<CountRow[]>(
    "SELECT COUNT(*) AS count FROM number_components WHERE template_version_id = $1 AND active = 1",
    [versionId],
  );
  if (Number(componentCount[0]?.count ?? 0) > 0) return;
  const defaults: Omit<NumberComponent, "databaseId">[] = [
    { id: "weight", type: "weight", label: "体重", hint: "分别记录早晚体重", unit: "kg", decimalPlaces: 2, defaultValue: null, required: false, minValue: null, maxValue: null, chart: true, chartType: "line", statistic: "latest", color: "#729b8b" },
    { id: "water", type: "number", label: "饮水量", hint: "今天累计饮水量", unit: "ml", decimalPlaces: 0, defaultValue: 0, required: false, minValue: 0, maxValue: 5000, chart: true, chartType: "bar", statistic: "average", color: "#788bb7" },
    { id: "steps", type: "number", label: "步数", hint: "今天累计行走步数", unit: "步", decimalPlaces: 0, defaultValue: null, required: true, minValue: 0, maxValue: 100000, chart: true, chartType: "bar", statistic: "latest", color: "#87a878" },
  ];
  for (const [index, component] of defaults.entries()) await upsertComponent(database, versionId, component, index);
}

function mapComponent(row: ComponentRow): NumberComponent {
  return {
    databaseId: Number(row.id), id: row.stable_id, type: row.component_kind, label: row.name,
    hint: row.component_kind === "weight" ? "分别记录早晚体重" : "自定义数值记录", unit: row.unit, decimalPlaces: Number(row.decimal_places),
    defaultValue: row.default_value, required: Boolean(row.required), minValue: row.min_value,
    maxValue: row.max_value, chart: Boolean(row.chart_enabled), chartType: row.chart_type,
    statistic: row.statistic, color: row.color,
  };
}

async function findTemplateVersion(database: Database, date: string): Promise<number> {
  let rows = await database.select<IdRow[]>(
    "SELECT id FROM template_versions WHERE effective_date <= $1 ORDER BY effective_date DESC LIMIT 1", [date],
  );
  if (!rows.length) rows = await database.select<IdRow[]>("SELECT id FROM template_versions ORDER BY effective_date ASC LIMIT 1");
  if (!rows.length) {
    await initializeDatabase(date);
    rows = await database.select<IdRow[]>("SELECT id FROM template_versions ORDER BY effective_date ASC LIMIT 1");
  }
  if (!rows.length) throw new Error("无法创建初始模板");
  return Number(rows[0].id);
}

export async function loadDay(date: string): Promise<LoadedDay> {
  const database = await getDatabase();
  const templateVersionId = await findTemplateVersion(database, date);
  const rows = await database.select<ComponentRow[]>(
    `SELECT id, stable_id, name, unit, decimal_places, default_value, required,
            min_value, max_value, chart_enabled, chart_type, statistic, color, component_kind
       FROM number_components
      WHERE template_version_id = $1 AND active = 1
      ORDER BY sort_order, id`, [templateVersionId],
  );
  const components = rows.map(mapComponent);
  const values: Record<string, number | null> = {};
  const touched: Record<string, boolean> = {};
  components.forEach((component) => {
    const keys = component.type === "weight" ? [`${component.id}:morning`, `${component.id}:evening`] : [component.id];
    keys.forEach((key) => { values[key] = null; touched[key] = false; });
  });
  const records = await database.select<IdRow[]>("SELECT id FROM daily_records WHERE record_date = $1 LIMIT 1", [date]);
  if (records.length) {
    const stored = await database.select<ValueRow[]>(
      `SELECT nc.stable_id, nv.value, nv.measurement_slot FROM number_values nv
       JOIN number_components nc ON nc.id = nv.component_id WHERE nv.record_id = $1`, [records[0].id],
    );
    stored.forEach((row) => {
      const key = row.measurement_slot === "single" ? row.stable_id : `${row.stable_id}:${row.measurement_slot}`;
      if (key in values) {
        const component = components.find((item) => item.id === row.stable_id);
        const value = Number(row.value);
        values[key] = component?.type === "weight" && component.unit === "斤" ? value * 2 : value;
        touched[key] = true;
      }
    });
  }
  return { templateVersionId, components, values, touched, hasRecord: records.length > 0 };
}

export async function saveDay(date: string, versionId: number, components: NumberComponent[], values: Record<string, number | null>, touched: Record<string, boolean>): Promise<void> {
  const database = await getDatabase();
  await database.execute(
    `INSERT INTO daily_records (record_date, template_version_id) VALUES ($1, $2)
     ON CONFLICT(record_date) DO UPDATE SET template_version_id = excluded.template_version_id, updated_at = CURRENT_TIMESTAMP`,
    [date, versionId],
  );
  const rows = await database.select<IdRow[]>("SELECT id FROM daily_records WHERE record_date = $1", [date]);
  const recordId = Number(rows[0].id);
  await database.execute("DELETE FROM number_values WHERE record_id = $1", [recordId]);
  for (const component of components) {
    const slots = component.type === "weight" ? ["morning", "evening"] as const : ["single"] as const;
    for (const slot of slots) {
      const key = slot === "single" ? component.id : `${component.id}:${slot}`;
      const value = values[key];
      if (!touched[key] || value === null || component.databaseId === null) continue;
      const storedValue = component.type === "weight" && component.unit === "斤" ? value / 2 : value;
      await database.execute("INSERT INTO number_values (record_id, component_id, measurement_slot, value) VALUES ($1, $2, $3, $4)", [recordId, component.databaseId, slot, storedValue]);
    }
  }
}

async function upsertComponent(database: Database, versionId: number, component: Omit<NumberComponent, "databaseId"> | NumberComponent, order: number): Promise<void> {
  await database.execute(
    `INSERT INTO number_components (
       stable_id, template_version_id, name, unit, decimal_places, default_value, required,
       min_value, max_value, chart_enabled, chart_type, statistic, color, sort_order, active, component_kind
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15)
     ON CONFLICT(template_version_id, stable_id) DO UPDATE SET
       name=excluded.name, unit=excluded.unit, decimal_places=excluded.decimal_places,
       default_value=excluded.default_value, required=excluded.required, min_value=excluded.min_value,
       max_value=excluded.max_value, chart_enabled=excluded.chart_enabled, chart_type=excluded.chart_type,
       statistic=excluded.statistic, color=excluded.color, sort_order=excluded.sort_order,
       active=1, component_kind=excluded.component_kind`,
    [component.id, versionId, component.label, component.unit, component.decimalPlaces,
      component.defaultValue, Number(component.required), component.minValue, component.maxValue,
      Number(component.chart), component.chartType, component.statistic, component.color, order, component.type],
  );
}

export async function saveTemplate(date: string, components: NumberComponent[]): Promise<void> {
  const database = await getDatabase();
  let rows = await database.select<IdRow[]>("SELECT id FROM template_versions WHERE effective_date = $1", [date]);
  if (!rows.length) {
    const result = await database.execute("INSERT INTO template_versions (effective_date) VALUES ($1)", [date]);
    rows = [{ id: Number(result.lastInsertId) }];
  }
  const versionId = Number(rows[0].id);
  await database.execute("UPDATE number_components SET active = 0 WHERE template_version_id = $1", [versionId]);
  for (const [index, component] of components.entries()) await upsertComponent(database, versionId, component, index);
}

export async function loadRecordedDates(start: string, end: string): Promise<string[]> {
  const database = await getDatabase();
  const rows = await database.select<DateRow[]>("SELECT record_date FROM daily_records WHERE record_date BETWEEN $1 AND $2", [start, end]);
  return rows.map((row) => row.record_date);
}

function previousDateKey(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}-${String(previous.getUTCDate()).padStart(2, "0")}`;
}

export async function loadRecordingStreak(endDate: string): Promise<number> {
  const database = await getDatabase();
  const rows = await database.select<DateRow[]>(
    "SELECT record_date FROM daily_records WHERE record_date <= $1 ORDER BY record_date DESC",
    [endDate],
  );
  let expected = endDate;
  let streak = 0;
  for (const row of rows) {
    if (row.record_date !== expected) break;
    streak += 1;
    expected = previousDateKey(expected);
  }
  return streak;
}

export async function loadNumberSeries(stableId: string, start: string, end: string): Promise<ComponentSeries> {
  const database = await getDatabase();
  const rows = await database.select<SeriesRow[]>(
    `SELECT nv.value, nv.measurement_slot, dr.record_date FROM number_values nv
     JOIN daily_records dr ON dr.id = nv.record_id
     JOIN number_components nc ON nc.id = nv.component_id
     WHERE nc.stable_id = $1 AND dr.record_date BETWEEN $2 AND $3 ORDER BY dr.record_date`,
    [stableId, start, end],
  );
  const series: ComponentSeries = { single: [], morning: [], evening: [] };
  rows.forEach((row) => series[row.measurement_slot].push({ date: row.record_date, value: Number(row.value) }));
  return series;
}

export async function loadTodos(): Promise<TodoItem[]> {
  const database = await getDatabase();
  const rows = await database.select<TodoRow[]>(
    "SELECT id, content, completed FROM global_todos ORDER BY completed, created_at DESC, id DESC",
  );
  return rows.map((row) => ({ id: Number(row.id), content: row.content, completed: Boolean(row.completed) }));
}

export async function createTodo(content: string): Promise<TodoItem> {
  const database = await getDatabase();
  const result = await database.execute("INSERT INTO global_todos (content) VALUES ($1)", [content]);
  return { id: Number(result.lastInsertId), content, completed: false };
}

export async function setTodoCompleted(id: number, completed: boolean): Promise<void> {
  const database = await getDatabase();
  await database.execute(
    "UPDATE global_todos SET completed = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
    [Number(completed), id],
  );
}

export async function removeTodo(id: number): Promise<void> {
  const database = await getDatabase();
  await database.execute("DELETE FROM global_todos WHERE id = $1", [id]);
}
