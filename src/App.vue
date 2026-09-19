<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  initializeDatabase,
  loadDay,
  loadNumberSeries,
  loadLearningHeatmap,
  loadLearningHistory,
  loadLearningTags,
  loadRecordedDates,
  loadRecordingStreak,
  loadTodos,
  createTodo,
  setTodoCompleted,
  removeTodo as deleteTodo,
  clearAllData,
  closeDatabase,
  getDatabase,
  saveDay,
  saveTemplate,
  type NumberComponent,
  type ComponentSeries,
  type StatisticType,
  type TodoItem,
  type LearningEntry,
  type LearningDaySummary,
  type LearningHistoryEntry,
} from "./services/database";

const templateComponents = ref<NumberComponent[]>([]);
const templateDraft = ref<NumberComponent[]>([]);
const values = reactive<Record<string, number | null>>({});
const touched = reactive<Record<string, boolean>>({});
const learningEntries = reactive<Record<string, LearningEntry[]>>({});
const learningTags = ref<string[]>([]);
const learningLogos = ["📖", "💻", "🌐", "🧮", "🔬", "🎨", "🎵", "✏️"];
const todos = ref<TodoItem[]>([]);
const newTodo = ref("");
const todoError = ref("");
const dataMenuOpen = ref(false);
const dataOperation = ref<"clear" | "import" | null>(null);
const pendingImportPath = ref("");
const dataStatus = ref("");
const dataBusy = ref(false);

const leftOpen = ref(true);
const rightOpen = ref(true);
const editorOpen = ref(false);
const catalogOpen = ref(false);
const editorError = ref("");
const templateSaving = ref(false);
const saved = ref(true);
const saving = ref(false);
const validationError = ref("");
const chartRanges = reactive<Record<string, "7天" | "30天" | "90天">>({});
const chartRangeMenuOpen = ref<string | null>(null);
const selectedDate = ref(new Date());
const visibleMonth = ref(new Date(selectedDate.value.getFullYear(), selectedDate.value.getMonth(), 1));
const templateVersionId = ref<number | null>(null);
const recordedDates = ref(new Set<string>());
const recordingStreak = ref(0);
const chartSeries = reactive<Record<string, ComponentSeries>>({});
const learningHeatmaps = reactive<Record<string, LearningDaySummary[]>>({});
const learningChartMonths = reactive<Record<string, string>>({});
const expandedLearningEntries = ref<LearningHistoryEntry[]>([]);
const selectedLearningDetailDate = ref<string | null>(null);
const weightCurveVisible = reactive({ morning: true, evening: true });
const collapsedCharts = reactive<Record<string, boolean>>({});
const expandedChartId = ref<string | null>(null);
const hoveredChartDate = ref<string | null>(null);
const sampleCalendarMonth = ref(new Date(selectedDate.value.getFullYear(), selectedDate.value.getMonth(), 1));
const sampleCalendarSeries = ref<ComponentSeries | null>(null);
const sampleCalendarLoading = ref(false);
const expandedComponent = computed(() => templateComponents.value.find((item) => item.id === expandedChartId.value) ?? null);
const sampleCalendarMonthLabel = computed(() =>
  new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(sampleCalendarMonth.value),
);
const loading = ref(true);
const currentTime = ref(new Date());
let clockTimer: ReturnType<typeof setInterval> | null = null;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let activeSave: Promise<void> | null = null;
let changeRevision = 0;

const formatDateKey = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const selectedDateLabel = computed(() =>
  new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(selectedDate.value),
);

const greeting = computed(() => {
  const hour = currentTime.value.getHours();
  if (hour >= 5 && hour < 12) {
    return { title: "早上好", message: "新的一天开始了，记下此刻的状态与计划吧。", icon: "◒", period: "morning" };
  }
  if (hour >= 12 && hour < 18) {
    return { title: "下午好", message: "忙碌之余停一停，记录今天已经发生的事。", icon: "☀", period: "afternoon" };
  }
  return { title: "晚上好", message: "今天也辛苦了。花两分钟和自己待一会儿吧。", icon: "☾", period: "evening" };
});

const monthLabel = computed(() =>
  new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(visibleMonth.value),
);

const calendarDays = computed(() => {
  const year = visibleMonth.value.getFullYear();
  const month = visibleMonth.value.getMonth();
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      date,
      day: date.getDate(),
      currentMonth: date.getMonth() === month,
      selected: formatDateKey(date) === formatDateKey(selectedDate.value),
      hasRecord: recordedDates.value.has(formatDateKey(date)),
    };
  });
});

const chartComponents = computed(() => templateComponents.value.filter((item) => item.chart));
const statisticLabels: Record<StatisticType, string> = { latest: "最新值", average: "平均值", min: "最小值", max: "最大值", change: "变化量" };

const linePoints = (componentId: string) => {
  const data = chartSeries[componentId]?.single ?? [];
  if (!data.length) return "";
  const min = Math.min(...data.map((point) => point.value));
  const max = Math.max(...data.map((point) => point.value));
  return data.map((point, i) => {
    const x = data.length === 1 ? 150 : 8 + (i * 284) / (data.length - 1);
    const y = 72 - ((point.value - min) / Math.max(max - min, 0.1)) * 52;
    return `${x},${y}`;
  }).join(" ");
};

const barHeights = (componentId: string) => {
  const data = (chartSeries[componentId]?.single ?? []).slice(-12);
  const max = Math.max(...data.map((point) => point.value), 1);
  return data.map((point) => Math.max(3, (point.value / max) * 62));
};

function displayMetric(component: NumberComponent) {
  let series = component.type === "weight"
    ? [...(chartSeries[component.id]?.morning ?? []), ...(chartSeries[component.id]?.evening ?? [])].map((point) => point.value)
    : (chartSeries[component.id]?.single ?? []).map((point) => point.value);
  if (component.type === "weight" && component.unit === "斤") series = series.map((value) => value * 2);
  if (!series.length) return "--";
  let value = series[series.length - 1];
  if (component.statistic === "average") value = series.reduce((sum, item) => sum + item, 0) / series.length;
  if (component.statistic === "min") value = Math.min(...series);
  if (component.statistic === "max") value = Math.max(...series);
  if (component.statistic === "change") value = series[series.length - 1] - series[0];
  return Number(value).toFixed(component.decimalPlaces);
}

function weightLinePoints(component: NumberComponent, slot: "morning" | "evening") {
  const source = chartSeries[component.id];
  if (!source) return "";
  const data = source[slot];
  const all = [...source.morning, ...source.evening];
  const dates = [...new Set(all.map((point) => point.date))].sort();
  if (!data.length || !all.length) return "";
  const min = Math.min(...all.map((point) => point.value));
  const max = Math.max(...all.map((point) => point.value));
  return data.map((point) => {
    const storedKg = point.value;
    const value = component.unit === "斤" ? storedKg * 2 : storedKg;
    const displayMin = component.unit === "斤" ? min * 2 : min;
    const displayMax = component.unit === "斤" ? max * 2 : max;
    const x = dates.length === 1 ? 150 : 8 + (dates.indexOf(point.date) * 284) / (dates.length - 1);
    const y = 72 - ((value - displayMin) / Math.max(displayMax - displayMin, 0.1)) * 52;
    return `${x},${y}`;
  }).join(" ");
}

function displayPointValue(component: NumberComponent, value: number) {
  return component.type === "weight" && component.unit === "斤" ? value * 2 : value;
}

function detailBounds(component: NumberComponent) {
  const series = chartSeries[component.id];
  if (!series) return { min: 0, max: 1 };
  const points = component.type === "weight" ? [...series.morning, ...series.evening] : series.single;
  const values = points.map((point) => displayPointValue(component, point.value));
  if (!values.length) return { min: 0, max: 1 };
  let min = Math.floor(Math.min(...values));
  let max = Math.ceil(Math.max(...values));
  if (min === max) { min -= 1; max += 1; }
  return { min, max };
}

function detailPoints(component: NumberComponent, slot: "single" | "morning" | "evening") {
  const series = chartSeries[component.id];
  if (!series) return [];
  const visibleSlots = component.type === "weight" ? ["morning", "evening"] as const : ["single"] as const;
  const all = visibleSlots.flatMap((item) => series[item]).map((point) => displayPointValue(component, point.value));
  const dates = [...new Set(visibleSlots.flatMap((item) => series[item]).map((point) => point.date))].sort();
  if (!all.length) return [];
  const { min, max } = detailBounds(component);
  return series[slot].map((point) => ({
    ...point,
    displayValue: displayPointValue(component, point.value),
    x: dates.length === 1 ? 350 : 55 + (dates.indexOf(point.date) * 610) / (dates.length - 1),
    y: 270 - ((displayPointValue(component, point.value) - min) / (max - min)) * 210,
  }));
}

function extremePoints(component: NumberComponent, slot: "single" | "morning" | "evening") {
  const points = detailPoints(component, slot);
  if (!points.length) return [];
  const minValue = Math.min(...points.map((point) => point.displayValue));
  const maxValue = Math.max(...points.map((point) => point.displayValue));
  const minPoint = points.find((point) => point.displayValue === minValue)!;
  const maxPoint = points.find((point) => point.displayValue === maxValue)!;
  return minPoint === maxPoint ? [minPoint] : [minPoint, maxPoint];
}

function detailTicks(component: NumberComponent) {
  const series = chartSeries[component.id];
  if (!series) return [];
  const points = component.type === "weight" ? [...series.morning, ...series.evening] : series.single;
  if (!points.length) return [];
  const { min, max } = detailBounds(component);
  const span = max - min;
  return Array.from({ length: 5 }, (_, index) => ({
    value: max - (span * index) / 4,
    y: 60 + (210 * index) / 4,
  }));
}

function shortDate(date: string) {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function detailDatePositions(component: NumberComponent) {
  const series = chartSeries[component.id];
  if (!series) return [];
  const points = component.type === "weight" ? [...series.morning, ...series.evening] : series.single;
  const dates = [...new Set(points.map((point) => point.date))].sort();
  return dates.map((date, index) => ({
    date,
    x: dates.length === 1 ? 350 : 55 + (index * 610) / (dates.length - 1),
  }));
}

async function openExpandedChart(componentId: string) {
  hoveredChartDate.value = null;
  expandedChartId.value = componentId;
  const component = templateComponents.value.find((item) => item.id === componentId);
  if (component?.type === "learning") {
    const [year, month] = learningMonthKey(component).split("-").map(Number);
    sampleCalendarMonth.value = new Date(year, month - 1, 1);
    selectedLearningDetailDate.value = null;
    await refreshExpandedLearning();
    return;
  }
  sampleCalendarMonth.value = new Date(selectedDate.value.getFullYear(), selectedDate.value.getMonth(), 1);
  await refreshSampleCalendar();
}

function closeExpandedChart() {
  hoveredChartDate.value = null;
  sampleCalendarSeries.value = null;
  expandedLearningEntries.value = [];
  selectedLearningDetailDate.value = null;
  expandedChartId.value = null;
}

async function refreshSampleCalendar() {
  const component = expandedComponent.value;
  if (!component || component.type === "learning") return;
  sampleCalendarLoading.value = true;
  try {
    const start = formatDateKey(new Date(sampleCalendarMonth.value.getFullYear(), sampleCalendarMonth.value.getMonth(), 1));
    const end = formatDateKey(new Date(sampleCalendarMonth.value.getFullYear(), sampleCalendarMonth.value.getMonth() + 1, 0));
    sampleCalendarSeries.value = await loadNumberSeries(component.id, start, end);
  } finally {
    sampleCalendarLoading.value = false;
  }
}

async function changeSampleCalendarMonth(offset: number) {
  sampleCalendarMonth.value = new Date(sampleCalendarMonth.value.getFullYear(), sampleCalendarMonth.value.getMonth() + offset, 1);
  await refreshSampleCalendar();
}

async function refreshExpandedLearning() {
  const component = expandedComponent.value;
  if (!component || component.type !== "learning") return;
  sampleCalendarLoading.value = true;
  try {
    const start = formatDateKey(new Date(sampleCalendarMonth.value.getFullYear(), sampleCalendarMonth.value.getMonth(), 1));
    const end = formatDateKey(new Date(sampleCalendarMonth.value.getFullYear(), sampleCalendarMonth.value.getMonth() + 1, 0));
    expandedLearningEntries.value = await loadLearningHistory(component.id, start, end);
  } finally {
    sampleCalendarLoading.value = false;
  }
}

async function changeExpandedLearningMonth(offset: number) {
  sampleCalendarMonth.value = new Date(sampleCalendarMonth.value.getFullYear(), sampleCalendarMonth.value.getMonth() + offset, 1);
  selectedLearningDetailDate.value = null;
  await refreshExpandedLearning();
}

function updateChartHover(component: NumberComponent, event: MouseEvent) {
  const svg = event.currentTarget as SVGSVGElement;
  const matrix = svg.getScreenCTM();
  if (!matrix) return;
  const pointer = svg.createSVGPoint();
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  const chartPoint = pointer.matrixTransform(matrix.inverse());
  const dates = detailDatePositions(component);
  if (!dates.length || chartPoint.x < 45 || chartPoint.x > 690 || chartPoint.y < 45 || chartPoint.y > 305) {
    hoveredChartDate.value = null;
    return;
  }
  hoveredChartDate.value = dates.reduce((nearest, item) =>
    Math.abs(item.x - chartPoint.x) < Math.abs(nearest.x - chartPoint.x) ? item : nearest,
  ).date;
}

function hoveredDateX(component: NumberComponent) {
  return detailDatePositions(component).find((item) => item.date === hoveredChartDate.value)?.x ?? 55;
}

function hoveredSamplePoints(component: NumberComponent) {
  if (!hoveredChartDate.value) return [];
  const slots = component.type === "weight" ? ["morning", "evening"] as const : ["single"] as const;
  return slots.flatMap((slot) => {
    if (slot === "morning" && !weightCurveVisible.morning) return [];
    if (slot === "evening" && !weightCurveVisible.evening) return [];
    return detailPoints(component, slot)
      .filter((point) => point.date === hoveredChartDate.value)
      .map((point) => ({
        ...point,
        slot,
        label: slot === "morning" ? "早上" : slot === "evening" ? "晚上" : "记录",
        color: slot === "morning" ? "#729b8b" : slot === "evening" ? "#d09a72" : component.color,
      }));
  });
}

function detailRows(component: NumberComponent) {
  const series = chartSeries[component.id];
  if (!series) return [];
  const rows = component.type === "weight"
    ? [
        ...series.morning.map((point) => ({ ...point, slot: "早上" })),
        ...series.evening.map((point) => ({ ...point, slot: "晚上" })),
      ]
    : series.single.map((point) => ({ ...point, slot: "记录" }));
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot));
}

function curveCalendars(component: NumberComponent) {
  const series = sampleCalendarSeries.value;
  if (!series) return [];
  const curves = component.type === "weight"
    ? [
        { slot: "morning" as const, label: "早上体重", color: "#729b8b" },
        { slot: "evening" as const, label: "晚上体重", color: "#d09a72" },
      ]
    : [{ slot: "single" as const, label: component.label, color: component.color }];
  const year = sampleCalendarMonth.value.getFullYear();
  const month = sampleCalendarMonth.value.getMonth();

  return curves.map((curve) => {
    const valueByDate = new Map(series[curve.slot].map((point) => [point.date, displayPointValue(component, point.value)]));
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const mondayOffset = (new Date(year, month, 1).getDay() + 6) % 7;
    const cells: Array<{ key: string; day: number | null; date: string; inRange: boolean; value: number | null }> = [];
    for (let index = 0; index < mondayOffset; index += 1) {
      cells.push({ key: `blank-${index}`, day: null, date: "", inRange: false, value: null });
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = formatDateKey(new Date(year, month, day));
      cells.push({ key: date, day, date, inRange: true, value: valueByDate.get(date) ?? null });
    }
    return { ...curve, cells, sampleCount: valueByDate.size };
  });
}

function learningMonthKey(component: NumberComponent) {
  return learningChartMonths[component.id] ?? `${selectedDate.value.getFullYear()}-${String(selectedDate.value.getMonth() + 1).padStart(2, "0")}`;
}

function monthKeyBounds(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  return [formatDateKey(new Date(year, month - 1, 1)), formatDateKey(new Date(year, month, 0))] as const;
}

function heatLevel(minutes: number) {
  if (minutes <= 0) return 0;
  if (minutes < 30) return 1;
  if (minutes < 60) return 2;
  if (minutes < 120) return 3;
  if (minutes < 240) return 4;
  return 5;
}

function learningCalendarCells(component: NumberComponent, expanded = false) {
  const monthKey = expanded
    ? `${sampleCalendarMonth.value.getFullYear()}-${String(sampleCalendarMonth.value.getMonth() + 1).padStart(2, "0")}`
    : learningMonthKey(component);
  const [year, monthNumber] = monthKey.split("-").map(Number);
  const month = monthNumber - 1;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const summaries = new Map((learningHeatmaps[component.id] ?? []).map((day) => [day.date, day]));
  const entriesByDate = new Map<string, LearningHistoryEntry[]>();
  if (expanded) expandedLearningEntries.value.forEach((entry) => {
    const entries = entriesByDate.get(entry.date) ?? [];
    entries.push(entry);
    entriesByDate.set(entry.date, entries);
  });
  const cells: Array<{ key: string; day: number | null; date: string; summary?: LearningDaySummary; entries: LearningHistoryEntry[] }> = [];
  for (let index = 0; index < offset; index += 1) cells.push({ key: `blank-${index}`, day: null, date: "", entries: [] });
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = formatDateKey(new Date(year, month, day));
    cells.push({ key: date, day, date, summary: summaries.get(date), entries: entriesByDate.get(date) ?? [] });
  }
  return cells;
}

function learningMonthTotal(component: NumberComponent) {
  return (learningHeatmaps[component.id] ?? []).reduce((sum, day) => sum + day.totalMinutes, 0);
}

function learningMonthDisplay(component: NumberComponent) {
  const [year, month] = learningMonthKey(component).split("-").map(Number);
  return `${year}年${month}月`;
}

function handleLearningMonthInput(component: NumberComponent, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (value) void setLearningChartMonth(component, value);
}

function selectedLearningDetails() {
  if (!selectedLearningDetailDate.value) return [];
  return expandedLearningEntries.value.filter((entry) => entry.date === selectedLearningDetailDate.value);
}

function toggleWeightCurve(slot: "morning" | "evening") {
  const other = slot === "morning" ? "evening" : "morning";
  if (weightCurveVisible[slot] && !weightCurveVisible[other]) return;
  weightCurveVisible[slot] = !weightCurveVisible[slot];
}

async function addTodo() {
  const content = newTodo.value.trim();
  if (!content) return;
  todoError.value = "";
  try {
    const todo = await createTodo(content);
    todos.value.unshift(todo);
    newTodo.value = "";
  } catch (error) {
    todoError.value = `无法添加：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function toggleTodo(todo: TodoItem) {
  const previous = todo.completed;
  todo.completed = !previous;
  todoError.value = "";
  try {
    await setTodoCompleted(todo.id, todo.completed);
    todos.value.sort((a, b) => Number(a.completed) - Number(b.completed) || b.id - a.id);
  } catch (error) {
    todo.completed = previous;
    todoError.value = `无法更新：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function removeGlobalTodo(todo: TodoItem) {
  todoError.value = "";
  try {
    await deleteTodo(todo.id);
    todos.value = todos.value.filter((item) => item.id !== todo.id);
  } catch (error) {
    todoError.value = `无法删除：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function exportData() {
  dataMenuOpen.value = false;
  const destination = await save({
    title: "导出 RecordEverything 数据",
    defaultPath: `RecordEverything-backup-${formatDateKey(new Date())}.db`,
    filters: [{ name: "SQLite 数据库", extensions: ["db"] }],
  });
  if (!destination) return;
  dataBusy.value = true;
  dataStatus.value = "正在导出…";
  try {
    await flushAutoSave();
    await closeDatabase();
    await invoke("export_database", { destination });
    dataStatus.value = "数据已导出";
  } catch (error) {
    dataStatus.value = `导出失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await getDatabase().catch(() => undefined);
    dataBusy.value = false;
  }
}

async function chooseImportFile() {
  dataMenuOpen.value = false;
  const source = await open({
    title: "选择 RecordEverything 数据库",
    multiple: false,
    directory: false,
    filters: [{ name: "SQLite 数据库", extensions: ["db", "sqlite", "sqlite3"] }],
  });
  if (typeof source !== "string") return;
  pendingImportPath.value = source;
  dataOperation.value = "import";
}

async function confirmDataOperation() {
  if (!dataOperation.value) return;
  dataBusy.value = true;
  dataStatus.value = dataOperation.value === "clear" ? "正在清空…" : "正在导入…";
  try {
    await flushAutoSave();
    if (dataOperation.value === "clear") {
      await clearAllData();
      todos.value = [];
      await initializeDatabase(formatDateKey(new Date()));
      await Promise.all([loadSelectedDay(), refreshRecordedDates()]);
      dataStatus.value = "所有数据已清空";
      dataOperation.value = null;
    } else {
      await closeDatabase();
      await invoke("import_database", { source: pendingImportPath.value });
      dataOperation.value = null;
      window.location.reload();
    }
  } catch (error) {
    dataStatus.value = `操作失败：${error instanceof Error ? error.message : String(error)}`;
    await getDatabase().catch(() => undefined);
    dataOperation.value = null;
  } finally {
    dataBusy.value = false;
  }
}

async function selectDate(date: Date) {
  await flushAutoSave();
  selectedDate.value = new Date(date);
  await loadSelectedDay();
}

function changeMonth(offset: number) {
  visibleMonth.value = new Date(visibleMonth.value.getFullYear(), visibleMonth.value.getMonth() + offset, 1);
  void refreshRecordedDates();
}

function changeYear(offset: number) {
  visibleMonth.value = new Date(visibleMonth.value.getFullYear() + offset, visibleMonth.value.getMonth(), 1);
  void refreshRecordedDates();
}

function markChanged() {
  changeRevision += 1;
  saved.value = false;
  validationError.value = "";
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    void saveRecord();
  }, 600);
}

async function flushAutoSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    if (!saved.value) await saveRecord();
  } else if (activeSave) {
    await activeSave;
  }
}

function updateValue(component: NumberComponent, slot?: "morning" | "evening") {
  const key = slot ? `${component.id}:${slot}` : component.id;
  touched[key] = true;
  if ((values[key] as number | string | null) === "") {
    values[key] = null;
  } else if (typeof values[key] === "number") {
    if (component.type === "weight" && (values[key] as number) < 0) values[key] = 0;
    const factor = 10 ** component.decimalPlaces;
    values[key] = Math.round((values[key] as number) * factor) / factor;
  }
  markChanged();
}

function addLearningEntry(component: NumberComponent) {
  const existing = Object.values(learningEntries).flat();
  const logo = existing.length ? existing[existing.length - 1].logo : "📖";
  if (!learningEntries[component.id]) learningEntries[component.id] = [];
  learningEntries[component.id].push({
    id: null, clientId: `learning-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    logo, tag: "", durationMinutes: null, knowledge: "",
  });
  markChanged();
}

function updateLearningEntry(entry: LearningEntry) {
  if ((entry.durationMinutes as number | string | null) === "") entry.durationMinutes = null;
  if (typeof entry.durationMinutes === "number") entry.durationMinutes = Math.round(entry.durationMinutes);
  if (entry.tag.length > 20) entry.tag = entry.tag.slice(0, 20);
  markChanged();
}

function removeLearningEntry(componentId: string, clientId: string) {
  learningEntries[componentId] = (learningEntries[componentId] ?? []).filter((entry) => entry.clientId !== clientId);
  markChanged();
}

function learningEntryValid(entry: LearningEntry) {
  return Boolean(entry.logo && entry.tag.trim() && entry.durationMinutes !== null && entry.durationMinutes > 0 && entry.durationMinutes < 1440);
}

async function saveRecord() {
  if (activeSave) return activeSave;
  const outOfRange = templateComponents.value.find((component) => {
    if (component.type === "learning") return false;
    const value = values[component.id];
    if (value === null) return false;
    return (component.minValue !== null && value < component.minValue) || (component.maxValue !== null && value > component.maxValue);
  });
  if (outOfRange) {
    validationError.value = `“${outOfRange.label}”超出允许范围`;
    return;
  }
  if (templateVersionId.value === null) return;
  const date = formatDateKey(selectedDate.value);
  const versionId = templateVersionId.value;
  const components = templateComponents.value.map((component) => ({ ...component }));
  const valueSnapshot = { ...values };
  const touchedSnapshot = { ...touched };
  const learningSnapshot = Object.fromEntries(
    Object.entries(learningEntries).map(([key, entries]) => [key, entries.map((entry) => ({ ...entry }))]),
  );
  const savedRevision = changeRevision;
  saving.value = true;
  activeSave = (async () => {
    try {
      await saveDay(date, versionId, components, valueSnapshot, touchedSnapshot, learningSnapshot);
      validationError.value = "";
      saved.value = savedRevision === changeRevision;
      await refreshRecordedDates();
      if (date === formatDateKey(selectedDate.value)) await Promise.all([refreshStats(), refreshStreak()]);
      learningTags.value = await loadLearningTags();
    } catch (error) {
      validationError.value = `保存失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      saving.value = false;
      activeSave = null;
      if (savedRevision !== changeRevision && !autoSaveTimer) {
        autoSaveTimer = setTimeout(() => {
          autoSaveTimer = null;
          void saveRecord();
        }, 100);
      }
    }
  })();
  return activeSave;
}

function moveComponent(index: number, direction: -1 | 1) {
  const target = index + direction;
  if (target < 0 || target >= templateDraft.value.length) return;
  const copy = [...templateDraft.value];
  [copy[index], copy[target]] = [copy[target], copy[index]];
  templateDraft.value = copy;
}

function removeComponent(index: number) {
  templateDraft.value.splice(index, 1);
}

function addNumberComponent() {
  const count = templateDraft.value.length + 1;
  const id = `number-${Date.now()}`;
  templateDraft.value.push({
    databaseId: null,
    id,
    type: "number",
    label: `数值记录 ${count}`,
    hint: "自定义数值记录",
    unit: "",
    decimalPlaces: 0,
    defaultValue: null,
    required: false,
    minValue: null,
    maxValue: null,
    chart: true,
    chartType: "line",
    statistic: "latest",
    color: ["#729b8b", "#e8a87c", "#87a878", "#788bb7", "#b48c78", "#8d9aa8", "#9c8daf"][count % 7],
  });
  catalogOpen.value = false;
}

function addWeightComponent() {
  if (templateDraft.value.some((component) => component.type === "weight")) {
    editorError.value = "模板中已有体重组件";
    return;
  }
  templateDraft.value.push({
    databaseId: null, id: `weight-${Date.now()}`, type: "weight", label: "体重",
    hint: "分别记录早晚体重", unit: "kg", decimalPlaces: 2,
    defaultValue: null, required: false, minValue: null, maxValue: null,
    chart: true, chartType: "line", statistic: "latest", color: "#729b8b",
  });
  catalogOpen.value = false;
}

function addLearningComponent() {
  if (templateDraft.value.some((component) => component.type === "learning")) {
    editorError.value = "模板中已有“今日所学”组件";
    return;
  }
  templateDraft.value.push({
    databaseId: null, id: `learning-${Date.now()}`, type: "learning", label: "今日所学",
    hint: "记录今天学到的知识", unit: "分钟", decimalPlaces: 0,
    defaultValue: null, required: false, minValue: 1, maxValue: 1439,
    chart: true, chartType: "line", statistic: "latest", color: "#6f9984",
  });
  catalogOpen.value = false;
}

function replaceReactiveRecord<T>(target: Record<string, T>, source: Record<string, T>) {
  Object.keys(target).forEach((key) => delete target[key]);
  Object.assign(target, source);
}

async function loadSelectedDay() {
  loading.value = true;
  validationError.value = "";
  try {
    const day = await loadDay(formatDateKey(selectedDate.value));
    templateVersionId.value = day.templateVersionId;
    templateComponents.value = day.components;
    replaceReactiveRecord(values, day.values);
    replaceReactiveRecord(touched, day.touched);
    replaceReactiveRecord(learningEntries, day.learningEntries);
    saved.value = true;
    await Promise.all([refreshStats(), refreshStreak()]);
  } catch (error) {
    validationError.value = `读取失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    loading.value = false;
  }
}

function monthBounds() {
  const start = new Date(visibleMonth.value.getFullYear(), visibleMonth.value.getMonth(), 1);
  const end = new Date(visibleMonth.value.getFullYear(), visibleMonth.value.getMonth() + 1, 0);
  return [formatDateKey(start), formatDateKey(end)] as const;
}

async function refreshRecordedDates() {
  const [start, end] = monthBounds();
  recordedDates.value = new Set(await loadRecordedDates(start, end));
}

async function refreshStreak() {
  recordingStreak.value = await loadRecordingStreak(formatDateKey(selectedDate.value));
}

function componentChartRange(component: NumberComponent) {
  return chartRanges[component.id] ?? "30天";
}

function chartStartDate(component: NumberComponent) {
  const days = Number.parseInt(componentChartRange(component), 10);
  const start = new Date(selectedDate.value);
  start.setDate(start.getDate() - days + 1);
  return formatDateKey(start);
}

function chartStartLabel(component: NumberComponent) {
  const [year, month, day] = chartStartDate(component).split("-").map(Number);
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(year, month - 1, day));
}

async function setComponentChartRange(component: NumberComponent, range: "7天" | "30天" | "90天") {
  chartRanges[component.id] = range;
  chartRangeMenuOpen.value = null;
  await refreshComponentStats(component);
}

async function setLearningChartMonth(component: NumberComponent, month: string) {
  learningChartMonths[component.id] = month;
  await refreshComponentStats(component);
}

async function refreshComponentStats(component: NumberComponent) {
  if (component.type === "learning") {
    const [start, end] = monthKeyBounds(learningMonthKey(component));
    learningHeatmaps[component.id] = await loadLearningHeatmap(component.id, start, end);
    return;
  }
  const end = formatDateKey(selectedDate.value);
  chartSeries[component.id] = await loadNumberSeries(component.id, chartStartDate(component), end);
}

async function refreshStats() {
  await Promise.all(chartComponents.value.map((component) => refreshComponentStats(component)));
}

async function openTemplateEditor() {
  await flushAutoSave();
  templateDraft.value = templateComponents.value.map((component) => ({ ...component }));
  catalogOpen.value = false;
  editorError.value = "";
  editorOpen.value = true;
}

function optionalNumber(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function applyTemplateChanges() {
  if (!templateDraft.value.length) {
    editorError.value = "模板至少需要保留一个记录项";
    return;
  }
  const invalid = templateDraft.value.find((component) => !component.label.trim());
  if (invalid) {
    editorError.value = "每个组件都必须填写名称";
    return;
  }
  const normalized = templateDraft.value.map((component) => ({
    ...component,
    label: component.label.trim(),
    unit: component.type === "weight" ? (component.unit === "斤" ? "斤" : "kg") : component.unit.trim(),
    decimalPlaces: component.type === "weight" ? 2 : Math.min(4, Math.max(0, Number(component.decimalPlaces) || 0)),
    defaultValue: component.type === "weight" ? null : optionalNumber(component.defaultValue),
    required: component.type === "weight" ? false : component.required,
    minValue: component.type === "weight" ? null : optionalNumber(component.minValue),
    maxValue: component.type === "weight" ? null : optionalNumber(component.maxValue),
    chart: component.type === "weight" ? true : component.chart,
    chartType: component.type === "weight" ? "line" as const : component.chartType,
  }));
  const invalidRange = normalized.find((component) =>
    component.minValue !== null && component.maxValue !== null && component.minValue > component.maxValue,
  );
  if (invalidRange) {
    editorError.value = `“${invalidRange.label}”的最小值不能大于最大值`;
    return;
  }
  templateSaving.value = true;
  editorError.value = "";
  try {
    await saveTemplate(formatDateKey(selectedDate.value), normalized);
    editorOpen.value = false;
    await loadSelectedDay();
  } catch (error) {
    editorError.value = `模板保存失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    templateSaving.value = false;
  }
}

onMounted(async () => {
  clockTimer = setInterval(() => { currentTime.value = new Date(); }, 60_000);
  try {
    const today = formatDateKey(new Date());
    await initializeDatabase(today);
    const [, , storedTodos, storedTags] = await Promise.all([loadSelectedDay(), refreshRecordedDates(), loadTodos(), loadLearningTags()]);
    todos.value = storedTodos;
    learningTags.value = storedTags;
  } catch (error) {
    validationError.value = `数据库初始化失败：${error instanceof Error ? error.message : String(error)}`;
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer);
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
});
</script>

<template>
  <div class="app-shell" :class="{ 'left-collapsed': !leftOpen, 'right-collapsed': !rightOpen, 'is-loading': loading }">
    <aside class="sidebar left-sidebar" :class="{ collapsed: !leftOpen }">
      <button v-if="!leftOpen" class="rail-button" title="展开日期栏" @click="leftOpen = true">›</button>
      <template v-else>
        <div class="brand-row">
          <img class="brand-mark" src="/app-icon.png" alt="RecordEverything 图标" />
          <div><strong>记录一下吧</strong></div>
          <button class="icon-button push" title="收起日期栏" @click="leftOpen = false">‹</button>
        </div>

        <section class="calendar-card">
          <div class="calendar-heading">
            <div class="calendar-nav-group">
              <button class="icon-button" title="上一年" aria-label="上一年" @click="changeYear(-1)">«</button>
              <button class="icon-button" title="上个月" aria-label="上个月" @click="changeMonth(-1)">‹</button>
            </div>
            <strong>{{ monthLabel }}</strong>
            <div class="calendar-nav-group">
              <button class="icon-button" title="下个月" aria-label="下个月" @click="changeMonth(1)">›</button>
              <button class="icon-button" title="下一年" aria-label="下一年" @click="changeYear(1)">»</button>
            </div>
          </div>
          <div class="week-row"><span v-for="day in ['一','二','三','四','五','六','日']" :key="day">{{ day }}</span></div>
          <div class="day-grid">
            <button
              v-for="item in calendarDays"
              :key="formatDateKey(item.date)"
              :class="{ muted: !item.currentMonth, selected: item.selected, recorded: item.hasRecord }"
              @click="selectDate(item.date)"
            >{{ item.day }}</button>
          </div>
          <button class="today-button" @click="selectDate(new Date()); visibleMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)">回到今天</button>
        </section>

        <div class="template-summary">
          <div class="section-label">今日模板</div>
          <div class="template-name"><span class="template-icon">✦</span><div><strong>我的日常</strong><small>{{ templateComponents.length }} 个记录项 · 继承自昨天</small></div></div>
          <button class="secondary-button full" @click="openTemplateEditor">编辑今日模板 <span>›</span></button>
        </div>

        <section class="global-todos">
          <div class="todo-heading"><span class="section-label">待办事项</span><small>{{ todos.filter(todo => !todo.completed).length }} 项未完成</small></div>
          <form class="todo-add" @submit.prevent="addTodo">
            <input v-model="newTodo" maxlength="120" placeholder="添加一项待办…" />
            <button type="submit" :disabled="!newTodo.trim()" title="添加待办">+</button>
          </form>
          <div v-if="todoError" class="todo-error">{{ todoError }}</div>
          <div v-if="todos.length" class="todo-list">
            <div v-for="todo in todos" :key="todo.id" :class="['todo-item', { completed: todo.completed }]">
              <button class="todo-check" :title="todo.completed ? '标记为未完成' : '标记为已完成'" @click="toggleTodo(todo)">{{ todo.completed ? '✓' : '' }}</button>
              <span>{{ todo.content }}</span>
              <button class="todo-delete" title="删除待办" @click="removeGlobalTodo(todo)">×</button>
            </div>
          </div>
          <div v-else class="todo-empty">还没有待办，记下一件想做的事吧。</div>
        </section>

        <div class="sidebar-footer">
          <span class="avatar">R</span>
          <div><strong>本地记录</strong><small>{{ dataStatus || '数据仅保存在这台设备' }}</small></div>
          <div class="data-menu-wrap">
            <button class="icon-button" :disabled="dataBusy" title="数据管理" @click="dataMenuOpen = !dataMenuOpen">⋯</button>
            <div v-if="dataMenuOpen" class="data-menu">
              <button class="danger" @click="dataOperation = 'clear'; dataMenuOpen = false"><span>⌫</span>清空数据</button>
              <button @click="exportData"><span>↗</span>导出数据</button>
              <button @click="chooseImportFile"><span>↙</span>导入数据</button>
            </div>
          </div>
        </div>
      </template>
    </aside>

    <main class="record-panel">
      <header class="record-header">
        <div>
          <div class="eyebrow">每日记录</div>
          <h1>{{ selectedDateLabel }}</h1>
          <p>慢一点，记下今天真实发生的事。</p>
        </div>
        <div class="save-area"><span :class="['save-state', { dirty: !saved || validationError }]">{{ validationError || (saving ? '正在自动保存…' : saved ? '已自动保存' : '等待自动保存…') }}</span></div>
      </header>

      <div class="record-scroll">
        <section class="greeting-card">
          <div><span :class="['greeting-icon', greeting.period]">{{ greeting.icon }}</span><div><strong>{{ greeting.title }}</strong><p>{{ greeting.message }}</p></div></div>
          <span class="streak"><b>{{ recordingStreak }}</b> 天连续记录</span>
        </section>

        <section class="form-section">
          <article v-for="component in templateComponents" :key="component.id" class="field-card">
            <div class="field-heading"><div><label>{{ component.label }}</label><small>{{ component.hint }}</small></div><span v-if="component.chart" class="chartable">可统计</span></div>

            <div v-if="component.type === 'learning'" class="learning-records">
              <article v-for="(entry, entryIndex) in learningEntries[component.id]" :key="entry.clientId" :class="['learning-entry-card', { invalid: !learningEntryValid(entry) }]">
                <div class="learning-alpha">
                  <label class="learning-logo"><span>Logo</span><select v-model="entry.logo" @change="updateLearningEntry(entry)"><option v-for="logo in learningLogos" :key="logo" :value="logo">{{ logo }}</option></select></label>
                  <label class="learning-tag"><span>Tag <em>必填 · 最多 20 字</em></span><input v-model="entry.tag" :list="`learning-tags-${component.id}`" maxlength="20" placeholder="如：Vue 响应式原理" @input="updateLearningEntry(entry)" /></label>
                  <label class="learning-duration"><span>学习时长</span><div><input v-model.number="entry.durationMinutes" type="number" min="1" max="1439" placeholder="0" @input="updateLearningEntry(entry)" /><b>分钟</b></div></label>
                  <button class="learning-delete" title="删除这条学习记录" @click="removeLearningEntry(component.id, entry.clientId)">×</button>
                </div>
                <label class="learning-beta"><span>具体知识点 <em>可选</em></span><textarea v-model="entry.knowledge" rows="4" placeholder="记下今天学到的概念、结论或疑问…" @input="updateLearningEntry(entry)"></textarea></label>
                <small v-if="!learningEntryValid(entry)" class="learning-validation">请填写 Tag，并将学习时长设为 1–1439 分钟；完整后才会计入热力图。</small>
                <span class="learning-index">#{{ entryIndex + 1 }}</span>
              </article>
              <datalist :id="`learning-tags-${component.id}`"><option v-for="tag in learningTags" :key="tag" :value="tag" /></datalist>
              <button class="add-learning-entry" @click="addLearningEntry(component)">＋ 添加一条学习记录</button>
            </div>
            <div v-else-if="component.type === 'weight'" class="weight-controls">
              <label v-for="slot in (['morning', 'evening'] as const)" :key="slot" class="weight-control">
                <span>{{ slot === 'morning' ? '早上' : '晚上' }}</span>
                <div class="number-control">
                  <input
                    v-model.number="values[`${component.id}:${slot}`]"
                    type="number"
                    min="0"
                    :step="1 / (10 ** component.decimalPlaces)"
                    placeholder="未填写"
                    @input="updateValue(component, slot)"
                  />
                  <span>{{ component.unit }}</span>
                </div>
              </label>
            </div>
            <div v-else class="number-control">
              <input
                v-model.number="values[component.id]"
                type="number"
                :step="1 / (10 ** component.decimalPlaces)"
                :min="component.minValue ?? undefined"
                :max="component.maxValue ?? undefined"
                :placeholder="component.defaultValue === null ? '未填写' : String(component.defaultValue)"
                @input="updateValue(component)"
              />
              <span>{{ component.unit }}</span>
            </div>
            <div v-if="component.type === 'number'" class="number-meta">
              <span>{{ component.decimalPlaces }} 位小数</span>
              <span v-if="component.minValue !== null || component.maxValue !== null">范围 {{ component.minValue ?? '不限' }}～{{ component.maxValue ?? '不限' }}</span>
              <span v-if="component.required" class="required-mark">必填</span>
            </div>
          </article>
        </section>
      </div>
    </main>

    <aside class="sidebar stats-sidebar" :class="{ collapsed: !rightOpen }">
      <button v-if="!rightOpen" class="rail-button" title="展开统计栏" @click="rightOpen = true">‹</button>
      <template v-else>
        <header class="stats-header"><div><span class="section-label">数据回顾</span><h2>变化与趋势</h2></div><button class="icon-button" title="收起统计栏" @click="rightOpen = false">›</button></header>
        <div class="stats-scroll">
          <article v-for="component in chartComponents" :key="component.id" class="chart-card">
            <div class="chart-title">
              <div><span class="color-dot" :style="{ background: component.color }"></span><strong>{{ component.label }}</strong></div>
              <div class="chart-actions">
                <button class="icon-button" :title="collapsedCharts[component.id] ? '展开图表' : '最小化图表'" @click="collapsedCharts[component.id] = !collapsedCharts[component.id]">{{ collapsedCharts[component.id] ? '□' : '−' }}</button>
                <div v-if="component.type === 'learning'" class="learning-month-control" :title="`选择${component.label}的统计月份`">
                  <span>{{ learningMonthDisplay(component) }}</span><input type="month" :value="learningMonthKey(component)" @change="handleLearningMonthInput(component, $event)" />
                </div>
                <div v-else class="chart-range-control">
                  <button class="chart-range-button" title="设置这张图表的统计时间" @click="chartRangeMenuOpen = chartRangeMenuOpen === component.id ? null : component.id">{{ componentChartRange(component) }}</button>
                  <div v-if="chartRangeMenuOpen === component.id" class="chart-range-menu">
                    <button v-for="range in (['7天', '30天', '90天'] as const)" :key="range" :class="{ active: componentChartRange(component) === range }" @click="setComponentChartRange(component, range)">{{ range }}</button>
                  </div>
                </div>
                <button class="icon-button" title="放大查看细节" @click="openExpandedChart(component.id)">⛶</button>
              </div>
            </div>
            <template v-if="!collapsedCharts[component.id]">
            <div v-if="component.type === 'learning'" class="learning-heat-summary">
              <div class="metric-row"><div><small>本月学习</small><strong>{{ learningMonthTotal(component) }}<small>分钟</small></strong></div><span>{{ (learningHeatmaps[component.id] ?? []).reduce((sum, day) => sum + day.entryCount, 0) }} 条记录</span></div>
              <div class="mini-heat-weekdays"><span v-for="weekday in ['一','二','三','四','五','六','日']" :key="weekday">{{ weekday }}</span></div>
              <div class="mini-heat-calendar">
                <div v-for="cell in learningCalendarCells(component)" :key="cell.key" :class="['mini-heat-day', `level-${heatLevel(cell.summary?.totalMinutes ?? 0)}`, { blank: cell.day === null }]">
                  <span v-if="cell.day !== null">{{ cell.day }}</span>
                </div>
              </div>
              <div class="heat-legend"><span>少</span><i v-for="level in 5" :key="level" :class="`level-${level}`"></i><span>多</span></div>
            </div>
            <template v-else>
            <div class="metric-row"><div><small>{{ statisticLabels[component.statistic] }}</small><strong>{{ displayMetric(component) }}<small>{{ component.unit }}</small></strong></div><span>↘ 0.6%</span></div>
            <div v-if="component.type === 'weight'" class="weight-chart-tools">
              <button :class="{ off: !weightCurveVisible.morning }" @click="toggleWeightCurve('morning')"><i class="morning-dot"></i>早上</button>
              <button :class="{ off: !weightCurveVisible.evening }" @click="toggleWeightCurve('evening')"><i class="evening-dot"></i>晚上</button>
            </div>
            <svg v-if="component.type === 'weight' && (chartSeries[component.id]?.morning.length || chartSeries[component.id]?.evening.length)" class="line-chart" viewBox="0 0 300 82" preserveAspectRatio="none">
              <path d="M 0 73 H 300 M 0 43 H 300 M 0 13 H 300" class="grid-line" />
              <polyline v-if="weightCurveVisible.morning" :points="weightLinePoints(component, 'morning')" fill="none" stroke="#729b8b" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
              <polyline v-if="weightCurveVisible.evening" :points="weightLinePoints(component, 'evening')" fill="none" stroke="#d09a72" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <svg v-else-if="component.type !== 'weight' && component.chartType === 'line' && chartSeries[component.id]?.single.length" class="line-chart" viewBox="0 0 300 82" preserveAspectRatio="none">
                <defs><linearGradient :id="`fade-${component.id}`" x1="0" y1="0" x2="0" y2="1"><stop offset="0" :stop-color="component.color" stop-opacity=".24"/><stop offset="1" :stop-color="component.color" stop-opacity="0"/></linearGradient></defs>
                <path d="M 0 73 H 300 M 0 43 H 300 M 0 13 H 300" class="grid-line" />
                <polyline :points="`${linePoints(component.id)} 292,80 8,80`" :fill="`url(#fade-${component.id})`" stroke="none" />
                <polyline :points="linePoints(component.id)" fill="none" :stroke="component.color" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <svg v-else-if="component.type !== 'weight' && chartSeries[component.id]?.single.length" class="line-chart" viewBox="0 0 300 82" preserveAspectRatio="none">
              <path d="M 0 73 H 300 M 0 43 H 300 M 0 13 H 300" class="grid-line" />
              <rect v-for="(height, barIndex) in barHeights(component.id)" :key="barIndex" :x="8 + barIndex * 24" :y="75 - height" width="14" :height="height" rx="3" :fill="component.color" opacity=".78" />
            </svg>
            <div v-else class="empty-chart">保存几天记录后，这里会出现趋势</div>
            <div class="chart-axis"><span>{{ chartStartLabel(component) }}</span><span>{{ formatDateKey(selectedDate) === formatDateKey(new Date()) ? '今天' : selectedDateLabel }}</span></div>
            </template>
            </template>
          </article>
          <div class="insight-card"><span>✦</span><div><strong>数值趋势</strong><p>所有统计均来自数值组件，可在模板中调整图表类型与统计指标。</p></div></div>
        </div>
      </template>
    </aside>

    <div v-if="dataOperation" class="modal-backdrop" @click.self="!dataBusy && (dataOperation = null)">
      <section class="data-confirm-modal">
        <div class="warning-mark">!</div>
        <h2>{{ dataOperation === 'clear' ? '清空所有数据？' : '导入并覆盖当前数据？' }}</h2>
        <p v-if="dataOperation === 'clear'">这将删除所有日常记录、模板和待办事项，且无法撤销。建议先导出一份备份。</p>
        <p v-else>导入的数据库将完全覆盖当前数据。应用会先自动保留一份导入前备份，然后重新加载。</p>
        <div class="confirm-file" v-if="dataOperation === 'import'">{{ pendingImportPath }}</div>
        <footer><button class="secondary-button" :disabled="dataBusy" @click="dataOperation = null">取消</button><button class="danger-button" :disabled="dataBusy" @click="confirmDataOperation">{{ dataBusy ? '正在处理…' : '我已了解，继续' }}</button></footer>
      </section>
    </div>

    <div v-if="expandedComponent" class="modal-backdrop" @click.self="closeExpandedChart">
      <section class="chart-detail-modal">
        <header>
          <div><span class="eyebrow">详细统计 · {{ expandedComponent.type === 'learning' ? sampleCalendarMonthLabel : componentChartRange(expandedComponent) }}</span><h2>{{ expandedComponent.label }}</h2><p>{{ expandedComponent.type === 'learning' ? '选择日期查看当天的全部学习记录。' : '每个圆点代表当天的一次有效记录。' }}</p></div>
          <button class="close-button" @click="closeExpandedChart">×</button>
        </header>
        <div v-if="expandedComponent.type === 'learning'" class="learning-detail-view">
          <div class="learning-detail-nav sample-calendar-nav">
            <button title="上个月" :disabled="sampleCalendarLoading" @click="changeExpandedLearningMonth(-1)">‹</button>
            <span>{{ sampleCalendarLoading ? '正在读取…' : sampleCalendarMonthLabel }}</span>
            <button title="下个月" :disabled="sampleCalendarLoading" @click="changeExpandedLearningMonth(1)">›</button>
          </div>
          <div class="learning-detail-weekdays"><span v-for="weekday in ['一','二','三','四','五','六','日']" :key="weekday">{{ weekday }}</span></div>
          <div :class="['learning-detail-calendar', { loading: sampleCalendarLoading }]">
            <button v-for="cell in learningCalendarCells(expandedComponent, true)" :key="cell.key" :disabled="cell.day === null" :class="['learning-detail-day', { blank: cell.day === null, selected: cell.date === selectedLearningDetailDate, recorded: cell.entries.length }]" @click="selectedLearningDetailDate = cell.date">
              <small v-if="cell.day !== null">{{ cell.day }} 日</small>
              <div v-if="cell.entries.length" class="learning-day-logos"><span v-for="(entry, index) in cell.entries.slice(0, 6)" :key="`${entry.id}-${index}`">{{ entry.logo }}</span><b v-if="cell.entries.length > 6">+{{ cell.entries.length - 6 }}</b></div>
              <span v-else-if="cell.day !== null" class="learning-no-entry">—</span>
            </button>
          </div>
          <section v-if="selectedLearningDetailDate" class="learning-day-detail">
            <header><div><span class="section-label">当日所学</span><h3>{{ selectedLearningDetailDate }}</h3></div><strong>{{ selectedLearningDetails().reduce((sum, entry) => sum + (entry.durationMinutes ?? 0), 0) }} 分钟</strong></header>
            <div v-if="selectedLearningDetails().length" class="learning-history-list">
              <article v-for="entry in selectedLearningDetails()" :key="entry.id ?? entry.clientId"><span>{{ entry.logo }}</span><div><strong>{{ entry.tag }}</strong><small>{{ entry.durationMinutes }} 分钟</small><p>{{ entry.knowledge || '未记录具体知识点' }}</p></div></article>
            </div>
            <p v-else class="detail-empty-learning">这一天没有有效的学习记录。</p>
          </section>
        </div>
        <template v-else>
        <div v-if="expandedComponent.type === 'weight'" class="detail-legend weight-chart-tools">
          <button :class="{ off: !weightCurveVisible.morning }" @click="toggleWeightCurve('morning')"><i class="morning-dot"></i>早上</button>
          <button :class="{ off: !weightCurveVisible.evening }" @click="toggleWeightCurve('evening')"><i class="evening-dot"></i>晚上</button>
        </div>
        <div v-if="detailRows(expandedComponent).length" class="detail-chart-wrap">
          <svg class="detail-chart interactive-chart" viewBox="0 0 720 330" @mousemove="updateChartHover(expandedComponent, $event)" @mouseleave="hoveredChartDate = null">
            <g v-for="tick in detailTicks(expandedComponent)" :key="tick.y">
              <line x1="55" x2="680" :y1="tick.y" :y2="tick.y" class="detail-grid-line" />
              <text x="47" :y="tick.y + 4" text-anchor="end" class="detail-axis-label">{{ tick.value.toFixed(expandedComponent.decimalPlaces) }}</text>
            </g>
            <line x1="55" x2="55" y1="60" y2="270" class="detail-axis-line" />
            <line x1="55" x2="680" y1="270" y2="270" class="detail-axis-line" />
            <polyline v-if="expandedComponent.type !== 'weight'" :points="detailPoints(expandedComponent, 'single').map(point => `${point.x},${point.y}`).join(' ')" fill="none" :stroke="expandedComponent.color" stroke-width="2.5" />
            <polyline v-if="expandedComponent.type === 'weight' && weightCurveVisible.morning" :points="detailPoints(expandedComponent, 'morning').map(point => `${point.x},${point.y}`).join(' ')" fill="none" stroke="#729b8b" stroke-width="2.5" />
            <polyline v-if="expandedComponent.type === 'weight' && weightCurveVisible.evening" :points="detailPoints(expandedComponent, 'evening').map(point => `${point.x},${point.y}`).join(' ')" fill="none" stroke="#d09a72" stroke-width="2.5" />
            <g v-for="point in detailPoints(expandedComponent, expandedComponent.type === 'weight' ? 'morning' : 'single')" :key="`a-${point.date}`">
              <circle v-if="expandedComponent.type !== 'weight' || weightCurveVisible.morning" :cx="point.x" :cy="point.y" r="4" :fill="expandedComponent.type === 'weight' ? '#729b8b' : expandedComponent.color"><title>{{ point.date }} · {{ point.displayValue.toFixed(expandedComponent.decimalPlaces) }} {{ expandedComponent.unit }}</title></circle>
            </g>
            <g v-if="expandedComponent.type === 'weight' && weightCurveVisible.evening" v-for="point in detailPoints(expandedComponent, 'evening')" :key="`e-${point.date}`">
              <circle :cx="point.x" :cy="point.y" r="4" fill="#d09a72"><title>{{ point.date }} · {{ point.displayValue.toFixed(expandedComponent.decimalPlaces) }} {{ expandedComponent.unit }}</title></circle>
            </g>
            <g v-if="expandedComponent.type !== 'weight'" v-for="point in extremePoints(expandedComponent, 'single')" :key="`extreme-single-${point.date}-${point.value}`">
              <circle :cx="point.x" :cy="point.y" r="6" fill="#fbfaf7" :stroke="expandedComponent.color" stroke-width="2.5" />
              <text :x="point.x" :y="point.y - 11" text-anchor="middle" class="extreme-value-label">{{ point.displayValue.toFixed(expandedComponent.decimalPlaces) }}</text>
            </g>
            <g v-if="expandedComponent.type === 'weight' && weightCurveVisible.morning" v-for="point in extremePoints(expandedComponent, 'morning')" :key="`extreme-morning-${point.date}-${point.value}`">
              <circle :cx="point.x" :cy="point.y" r="6" fill="#fbfaf7" stroke="#729b8b" stroke-width="2.5" />
              <text :x="point.x" :y="point.y - 11" text-anchor="middle" class="extreme-value-label morning-value-label">{{ point.displayValue.toFixed(expandedComponent.decimalPlaces) }}</text>
            </g>
            <g v-if="expandedComponent.type === 'weight' && weightCurveVisible.evening" v-for="point in extremePoints(expandedComponent, 'evening')" :key="`extreme-evening-${point.date}-${point.value}`">
              <circle :cx="point.x" :cy="point.y" r="6" fill="#fbfaf7" stroke="#d09a72" stroke-width="2.5" />
              <text :x="point.x" :y="point.y - 23" text-anchor="middle" class="extreme-value-label evening-value-label">{{ point.displayValue.toFixed(expandedComponent.decimalPlaces) }}</text>
            </g>
            <text v-for="item in detailDatePositions(expandedComponent)" :key="item.date" :x="item.x" y="292" text-anchor="middle" class="detail-date-label">{{ shortDate(item.date) }}</text>
            <g v-if="hoveredChartDate" class="hover-selection">
              <line :x1="hoveredDateX(expandedComponent)" :x2="hoveredDateX(expandedComponent)" y1="54" y2="270" class="hover-guide" />
              <text :x="hoveredDateX(expandedComponent)" y="43" text-anchor="middle" class="hover-date-label">{{ hoveredChartDate }}</text>
              <g v-for="(point, hoverIndex) in hoveredSamplePoints(expandedComponent)" :key="`hover-${point.slot}-${point.date}`">
                <circle :cx="point.x" :cy="point.y" r="13" :fill="point.color" class="hover-halo" />
                <circle :cx="point.x" :cy="point.y" r="6" fill="#fffdfa" :stroke="point.color" stroke-width="3" class="hover-core" />
                <text :x="point.x" :y="point.y - 15 - hoverIndex * 13" text-anchor="middle" class="hover-value-label" :fill="point.color">{{ point.label }} {{ point.displayValue.toFixed(expandedComponent.decimalPlaces) }} {{ expandedComponent.unit }}</text>
              </g>
            </g>
            <text x="18" y="34" class="detail-unit-label">单位：{{ expandedComponent.unit }}</text>
          </svg>
        </div>
        <div v-else class="detail-empty">当前日期范围内还没有记录</div>
        <div v-if="detailRows(expandedComponent).length" class="sample-list">
          <div class="sample-list-head">
            <strong>全部采样点</strong>
            <div class="sample-calendar-nav">
              <button title="上个月" :disabled="sampleCalendarLoading" @click="changeSampleCalendarMonth(-1)">‹</button>
              <span>{{ sampleCalendarLoading ? '正在读取…' : sampleCalendarMonthLabel }}</span>
              <button title="下个月" :disabled="sampleCalendarLoading" @click="changeSampleCalendarMonth(1)">›</button>
            </div>
          </div>
          <div :class="['curve-calendars', { loading: sampleCalendarLoading }]">
            <section v-for="curve in curveCalendars(expandedComponent)" :key="curve.slot" class="curve-calendar" :style="{ '--curve-color': curve.color }">
              <header><span class="curve-dot"></span><strong>{{ curve.label }}</strong><small>{{ curve.sampleCount }} 个采样</small></header>
              <div class="calendar-months">
                <article class="sample-month">
                  <div class="sample-weekdays"><span v-for="weekday in ['一','二','三','四','五','六','日']" :key="weekday">{{ weekday }}</span></div>
                  <div class="sample-calendar-grid">
                    <div v-for="cell in curve.cells" :key="cell.key" :class="['sample-day', { blank: cell.day === null, recorded: cell.value !== null }]">
                      <template v-if="cell.day !== null">
                        <small>{{ cell.day }} 日</small>
                        <strong v-if="cell.value !== null">{{ cell.value.toFixed(expandedComponent.decimalPlaces) }}<em>{{ expandedComponent.unit }}</em></strong>
                        <span v-else>—</span>
                      </template>
                    </div>
                  </div>
                </article>
              </div>
            </section>
          </div>
        </div>
        </template>
      </section>
    </div>

    <div v-if="editorOpen" class="modal-backdrop" @click.self="editorOpen = false">
      <section class="template-editor">
        <header><div><span class="eyebrow">模板编辑</span><h2>安排每天想记录的内容</h2><p>修改将从 {{ selectedDateLabel }} 起生效，之前的记录保持不变。</p></div><button class="close-button" @click="editorOpen = false">×</button></header>
        <div class="version-note"><span>↗</span><div><strong>将创建一个新的模板版本</strong><p>今天之后的日期将自动继承这套模板，直到你再次修改。</p></div></div>
        <div v-if="editorError" class="editor-error">{{ editorError }}</div>
        <div class="editor-list">
          <article v-for="(component, index) in templateDraft" :key="component.id" class="editor-item numeric-editor-item">
            <div class="editor-item-main">
              <span class="drag-handle">⠿</span>
              <span class="component-badge" :style="{ background: component.color + '22', color: component.color }">{{ component.type === 'weight' ? '秤' : component.type === 'learning' ? '学' : '123' }}</span>
              <div class="editor-fields"><input v-model="component.label" placeholder="记录名称" /><small>{{ component.type === 'weight' ? '体重组件' : component.type === 'learning' ? '学习记录组件' : '数值组件' }} · {{ component.hint }}</small></div>
              <label v-if="component.type === 'number'" class="chart-toggle"><input v-model="component.chart" type="checkbox" /><span></span>统计</label>
              <div class="move-buttons"><button :disabled="index === 0" @click="moveComponent(index, -1)">↑</button><button :disabled="index === templateDraft.length - 1" @click="moveComponent(index, 1)">↓</button></div>
              <button class="delete-button" @click="removeComponent(index)">×</button>
            </div>
            <div v-if="component.type === 'learning'" class="number-settings weight-settings">
              <div class="fixed-setting"><span>每日记录</span><strong>可添加多条</strong></div>
              <div class="fixed-setting"><span>时长规则</span><strong>1–1439 分钟</strong></div>
              <div class="fixed-setting"><span>Tag</span><strong>必填 · 20 字</strong></div>
              <div class="fixed-setting"><span>统计图</span><strong>月历热力图</strong></div>
            </div>
            <div v-else-if="component.type === 'weight'" class="number-settings weight-settings">
              <label><span>单位</span><select v-model="component.unit"><option value="kg">kg</option><option value="斤">斤</option></select></label>
              <div class="fixed-setting"><span>记录时段</span><strong>早上 + 晚上</strong></div>
              <div class="fixed-setting"><span>填写规则</span><strong>均为选填</strong></div>
              <div class="fixed-setting"><span>统计图</span><strong>双曲线折线图</strong></div>
            </div>
            <div v-else class="number-settings">
              <label><span>单位</span><input v-model="component.unit" placeholder="如 kg" /></label>
              <label><span>小数位</span><select v-model.number="component.decimalPlaces"><option v-for="n in 5" :key="n - 1" :value="n - 1">{{ n - 1 }} 位</option></select></label>
              <label><span>默认值</span><input v-model.number="component.defaultValue" type="number" placeholder="不设置" /></label>
              <label><span>最小值</span><input v-model.number="component.minValue" type="number" placeholder="不限" /></label>
              <label><span>最大值</span><input v-model.number="component.maxValue" type="number" placeholder="不限" /></label>
              <label class="required-setting"><span>填写规则</span><button :class="{ active: component.required }" @click="component.required = !component.required">{{ component.required ? '必填' : '选填' }}</button></label>
              <label v-if="component.chart"><span>图表类型</span><select v-model="component.chartType"><option value="line">折线图</option><option value="bar">柱状图</option></select></label>
              <label v-if="component.chart"><span>统计指标</span><select v-model="component.statistic"><option value="latest">最新值</option><option value="average">平均值</option><option value="min">最小值</option><option value="max">最大值</option><option value="change">变化量</option></select></label>
            </div>
          </article>
        </div>
        <button class="add-component" @click="catalogOpen = !catalogOpen">＋ 添加组件</button>
        <div v-if="catalogOpen" class="catalog-grid">
          <button @click="addLearningComponent"><span>学</span><div><strong>今日所学</strong><small>多条学习记录、Tag、时长与热力图</small></div></button>
          <button @click="addWeightComponent"><span>秤</span><div><strong>体重</strong><small>早晚双数值、kg/斤换算、双曲线</small></div></button>
          <button @click="addNumberComponent"><span>123</span><div><strong>自定义数值</strong><small>配置单位、精度、范围与统计图表</small></div></button>
        </div>
        <footer><button class="secondary-button" :disabled="templateSaving" @click="editorOpen = false">取消</button><button class="primary-button" :disabled="templateSaving" @click="applyTemplateChanges">{{ templateSaving ? '正在应用…' : '应用新模板' }}</button></footer>
      </section>
    </div>
  </div>
</template>

<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600;700&family=Noto+Serif+SC:wght@600;700&display=swap');

:root { font-family: "Noto Sans SC", "Microsoft YaHei", sans-serif; color: #34403b; background: #f4f3ef; font-synthesis: none; text-rendering: optimizeLegibility; }
* { box-sizing: border-box; }
* { scrollbar-width: thin; scrollbar-color: #b8c3bd #ebece7; }
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: #ebece7; border-radius: 10px; }
*::-webkit-scrollbar-thumb { border: 2px solid #ebece7; border-radius: 10px; background: #aebbb5; }
*::-webkit-scrollbar-thumb:hover { background: #84978f; }
*::-webkit-scrollbar-corner { background: transparent; }
html, body, #app { margin: 0; width: 100%; height: 100%; overflow: hidden; }
button, input, textarea { font: inherit; }
button { color: inherit; }
.app-shell { --left: 286px; --right: 344px; display: grid; grid-template-columns: var(--left) minmax(440px, 1fr) var(--right); width: 100vw; height: 100vh; min-width: 920px; background: #f8f7f3; transition: grid-template-columns .25s ease; }
.app-shell.is-loading { cursor: progress; }
.app-shell.left-collapsed { --left: 46px; }
.app-shell.right-collapsed { --right: 46px; }
.sidebar { position: relative; min-width: 0; background: #efeee8; border-color: #dfded7; overflow: hidden; }
.left-sidebar { border-right: 1px solid #dfded7; padding: 24px 20px 18px; display: flex; flex-direction: column; }
.stats-sidebar { display: flex; flex-direction: column; min-height: 0; border-left: 1px solid #e3e1da; background: #f2f1ec; padding: 27px 20px 18px; }
.sidebar.collapsed { padding: 0; }
.rail-button { width: 100%; height: 100%; border: 0; background: transparent; color: #7d8983; font-size: 27px; cursor: pointer; }
.rail-button:hover { background: #e9e8e1; color: #53766a; }
.brand-row { display: flex; align-items: center; gap: 11px; min-height: 42px; }
.brand-row strong { font-family: "Noto Serif SC", serif; display: block; font-size: 18px; letter-spacing: .08em; }
.brand-row small, .sidebar-footer small, .template-name small { display: block; font-size: 10px; color: #929994; line-height: 1.5; }
.brand-mark { width: 38px; height: 38px; border-radius: 11px; object-fit: contain; filter: drop-shadow(0 2px 4px #26312b1c); }
.push { margin-left: auto; }
.icon-button, .close-button { border: 0; background: transparent; border-radius: 8px; color: #7c8580; cursor: pointer; width: 30px; height: 30px; padding: 0; font-size: 18px; }
.icon-button:hover, .close-button:hover { background: #e6e4dd; }
.calendar-card { margin-top: 28px; }
.calendar-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 13px; }
.calendar-heading strong { font-size: 13px; font-weight: 600; }
.calendar-nav-group { display: flex; align-items: center; }.calendar-nav-group .icon-button { width: 23px; height: 27px; font-size: 16px; }
.week-row, .day-grid { display: grid; grid-template-columns: repeat(7, 1fr); text-align: center; gap: 3px; }
.week-row { margin-bottom: 5px; color: #a0a49f; font-size: 10px; }
.day-grid button { position: relative; justify-self: center; width: 28px; height: 28px; border: 1px solid transparent; background: transparent; border-radius: 50%; cursor: pointer; font-size: 11px; color: #5e6964; }
.day-grid button:hover { background: #e3e4dc; }
.day-grid button.muted { color: #c0c2be; }.day-grid button.recorded:not(.selected) { border-color: #56645f; color: #3f4c47; font-weight: 600; }.day-grid button.recorded.muted:not(.selected) { border-color: #aeb5b1; color: #8f9893; }.day-grid button.selected { border-color: #688b7f; background: #688b7f; color: white; font-weight: 600; }
.today-button { display: block; margin: 13px auto 0; padding: 5px 13px; border: 1px solid #d7d7d0; border-radius: 20px; background: #f6f5f1; font-size: 10px; color: #68736e; cursor: pointer; }
.template-summary { margin-top: 27px; padding-top: 20px; border-top: 1px solid #dcdbd4; }
.global-todos { min-height: 0; margin-top: 18px; padding-top: 16px; border-top: 1px solid #dcdbd4; display: flex; flex-direction: column; }.todo-heading { display: flex; align-items: center; justify-content: space-between; }.todo-heading small { color: #9a9f9b; font-size: 8px; }.todo-add { display: grid; grid-template-columns: minmax(0, 1fr) 28px; gap: 6px; margin-top: 10px; }.todo-add input { min-width: 0; height: 31px; border: 1px solid #dcdcd5; border-radius: 8px; outline: none; padding: 0 9px; background: #faf9f6; color: #56605b; font-size: 9px; }.todo-add input:focus { border-color: #8fa69d; background: white; }.todo-add button { border: 1px solid #78988c; border-radius: 8px; background: #78988c; color: white; cursor: pointer; font-size: 16px; }.todo-add button:disabled { opacity: .4; cursor: default; }.todo-list { min-height: 0; max-height: 170px; margin-top: 8px; padding-right: 3px; overflow-y: auto; display: grid; gap: 5px; }.todo-item { display: grid; grid-template-columns: 20px minmax(0, 1fr) 18px; align-items: center; gap: 7px; padding: 7px 5px; border-radius: 8px; background: #f8f7f3; }.todo-item:hover { background: #e9ece7; }.todo-check { display: grid; place-items: center; width: 17px; height: 17px; border: 1px solid #aeb9b3; border-radius: 50%; background: white; color: white; cursor: pointer; font-size: 10px; }.todo-item > span { min-width: 0; overflow-wrap: anywhere; color: #58625d; font-size: 9px; line-height: 1.45; }.todo-item.completed .todo-check { border-color: #78988c; background: #78988c; }.todo-item.completed > span { color: #a0a5a1; text-decoration: line-through; }.todo-delete { border: 0; background: transparent; color: #adb1ae; cursor: pointer; font-size: 15px; opacity: 0; }.todo-item:hover .todo-delete { opacity: 1; }.todo-delete:hover { color: #b86f64; }.todo-empty { margin-top: 9px; color: #a0a49f; font-size: 8px; line-height: 1.6; }.todo-error { margin-top: 7px; color: #ad6553; font-size: 8px; line-height: 1.4; }
.section-label, .eyebrow { text-transform: uppercase; letter-spacing: .15em; color: #969d98; font-weight: 600; font-size: 9px; }
.template-name { display: flex; align-items: center; gap: 10px; margin: 13px 0; }
.template-name strong { font-size: 12px; display: block; }
.template-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; background: #dee8e3; color: #628478; }
.secondary-button, .primary-button { border-radius: 10px; padding: 9px 15px; cursor: pointer; font-size: 11px; font-weight: 600; }
.secondary-button { border: 1px solid #d5d6d0; background: #faf9f6; }.secondary-button:hover { border-color: #9eb0a8; }
.full { width: 100%; display: flex; justify-content: space-between; }
.primary-button { border: 1px solid #638277; background: #688b7f; color: white; box-shadow: 0 4px 10px #688b7f24; }.primary-button:hover { background: #597b70; }
.sidebar-footer { flex: 0 0 auto; margin-top: auto; padding-top: 15px; border-top: 1px solid #dcdbd4; display: flex; align-items: center; gap: 9px; }
.sidebar-footer > div { flex: 1; }.sidebar-footer strong { font-size: 10px; display: block; }.avatar { display: grid; place-items: center; width: 29px; height: 29px; border-radius: 50%; background: #d9d6cc; color: #6f766f; font-size: 11px; font-weight: 700; }
.sidebar-footer .data-menu-wrap { position: relative; flex: 0 0 auto; }.data-menu { position: absolute; z-index: 30; right: 0; bottom: 34px; width: 132px; padding: 5px; border: 1px solid #dcded8; border-radius: 10px; background: #fffefa; box-shadow: 0 12px 30px #34413a24; }.data-menu button { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; border-radius: 7px; padding: 8px 9px; background: transparent; color: #58645e; text-align: left; cursor: pointer; font-size: 9px; }.data-menu button:hover { background: #edf1ed; }.data-menu button.danger { color: #a45f50; }.data-menu button.danger:hover { background: #faece7; }.data-menu button span { width: 13px; text-align: center; font-size: 12px; }
.record-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; background: #fbfaf7; }
.record-header { min-height: 116px; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 24px clamp(28px, 5vw, 70px) 20px; border-bottom: 1px solid #e7e5de; background: #fdfcf9dd; }
.record-header h1 { font-family: "Noto Serif SC", serif; margin: 4px 0 2px; font-size: 23px; color: #303a36; }.record-header p { margin: 0; font-size: 11px; color: #89908c; }
.save-area { display: flex; align-items: center; gap: 14px; }.save-state { font-size: 10px; color: #8d9893; }.save-state::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: #7fa18f; }.save-state.dirty::before { background: #d9a96a; }
.record-scroll, .stats-scroll { min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: #d0d0c8 transparent; }
.record-scroll { flex: 1 1 auto; padding: 24px clamp(28px, 5vw, 70px) 50px; }
.greeting-card { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 18px; border: 1px solid #e6e0d2; border-radius: 14px; background: #f6f1e7; }
.greeting-card > div { display: flex; align-items: center; gap: 12px; }.greeting-card strong { font-family: "Noto Serif SC", serif; font-size: 13px; }.greeting-card p { margin: 3px 0 0; font-size: 10px; color: #8d8b82; }.greeting-icon { display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 auto; border-radius: 50%; font-size: 21px; }.greeting-icon.morning { color: #c88752; background: #f8e5cf; }.greeting-icon.afternoon { color: #d39a48; background: #f7eac9; }.greeting-icon.evening { color: #68789a; background: #e3e7f0; }.streak { white-space: nowrap; padding: 5px 9px; border-radius: 20px; background: #fffaf0; color: #997e57; font-size: 9px; }.streak b { font-size: 12px; }
.form-section { margin-top: 20px; display: grid; gap: 12px; }.field-card { padding: 18px; border: 1px solid #e5e3dc; border-radius: 14px; background: white; box-shadow: 0 4px 18px #59665e08; }.field-heading { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 14px; }.field-heading label { display: block; font-family: "Noto Serif SC", serif; font-weight: 700; font-size: 13px; }.field-heading small { display: block; margin-top: 3px; color: #9a9e9b; font-size: 9px; }.chartable { align-self: start; color: #739085; background: #edf3f0; border-radius: 20px; padding: 3px 7px; font-size: 8px; }
.rating-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 7px; }.rating-row button { border: 1px solid #e5e4de; border-radius: 10px; background: #fafaf7; padding: 7px 3px; font-size: 8px; color: #929893; cursor: pointer; }.rating-row button span { display: block; font-size: 19px; line-height: 20px; color: #9ca5a0; }.rating-row button:hover, .rating-row button.active { border-color: #d1a46f; color: #8e6944; background: #fbf2e7; }.rating-row button.active span { color: #d49d5d; }
.number-control { display: flex; align-items: baseline; border-bottom: 1px solid #d9d9d3; width: 180px; }.number-control input { width: 125px; border: 0; outline: 0; background: transparent; color: #3b4742; font-family: "Noto Serif SC", serif; font-size: 27px; font-weight: 600; }.number-control span { color: #9aa09c; font-size: 11px; }
.weight-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }.weight-control > span { display: block; margin-bottom: 7px; color: #7d8882; font-size: 9px; }.weight-control .number-control { width: 100%; }.weight-control .number-control input { width: 100%; min-width: 0; }.weight-chart-tools { display: flex; gap: 6px; margin: 7px 0 3px; }.weight-chart-tools button { display: flex; align-items: center; gap: 5px; border: 1px solid #dedfd9; border-radius: 20px; padding: 3px 8px; background: white; color: #68736e; font-size: 8px; cursor: pointer; }.weight-chart-tools button.off { opacity: .4; }.weight-chart-tools i { width: 7px; height: 7px; border-radius: 50%; }.morning-dot { background: #729b8b; }.evening-dot { background: #d09a72; }
.weight-control input[type="number"] { appearance: textfield; -moz-appearance: textfield; }.weight-control input[type="number"]::-webkit-inner-spin-button, .weight-control input[type="number"]::-webkit-outer-spin-button { margin: 0; -webkit-appearance: none; }
.learning-records { display: grid; gap: 10px; }.learning-entry-card { position: relative; padding: 13px; border: 1px solid #dde4df; border-radius: 12px; background: #fafcf9; }.learning-entry-card.invalid { border-color: #eadbd4; }.learning-alpha { display: grid; grid-template-columns: 64px minmax(150px, 1fr) 118px 24px; align-items: end; gap: 10px; }.learning-alpha label > span, .learning-beta > span { display: block; margin-bottom: 5px; color: #858f8a; font-size: 8px; }.learning-alpha label > span em, .learning-beta > span em { color: #aaa; font-style: normal; }.learning-logo select, .learning-tag input, .learning-duration input { width: 100%; height: 34px; border: 1px solid #dddeda; border-radius: 8px; outline: 0; background: white; color: #4f5b55; }.learning-logo select { font-size: 18px; text-align: center; }.learning-tag input { padding: 0 9px; font-size: 10px; }.learning-duration > div { display: flex; align-items: center; height: 34px; border: 1px solid #dddeda; border-radius: 8px; background: white; }.learning-duration input { min-width: 0; border: 0; background: transparent; padding: 0 7px; }.learning-duration b { padding-right: 7px; color: #919894; font-size: 8px; font-weight: 400; }.learning-alpha input:focus, .learning-alpha select:focus, .learning-beta textarea:focus { border-color: #8da79b; }.learning-delete { width: 24px; height: 34px; border: 0; background: transparent; color: #a8aeaa; cursor: pointer; font-size: 18px; }.learning-delete:hover { color: #b56856; }.learning-beta { display: block; margin-top: 11px; }.learning-beta textarea { width: 100%; resize: vertical; min-height: 82px; border: 1px solid #dddeda; border-radius: 9px; outline: 0; padding: 9px 10px; background: white; color: #53605a; font-size: 10px; line-height: 1.65; }.learning-validation { display: block; margin-top: 7px; color: #ad705f; font-size: 8px; }.learning-index { position: absolute; top: 9px; right: 12px; color: #c0c4c1; font-size: 7px; }.add-learning-entry { width: 100%; border: 1px dashed #9fb2a9; border-radius: 10px; padding: 9px; background: #f3f7f4; color: #5f7c70; cursor: pointer; font-size: 9px; }.add-learning-entry:hover { background: #eaf2ed; }
.number-meta { display: flex; gap: 10px; margin-top: 9px; color: #9aa09c; font-size: 8px; }.number-meta span { padding-right: 10px; border-right: 1px solid #e4e3dd; }.number-meta span:last-child { border-right: 0; }.number-meta .required-mark { color: #a87868; }
.toggle-control { display: grid; grid-template-columns: 38px 1fr; text-align: left; align-items: center; column-gap: 10px; border: 0; background: transparent; padding: 0; cursor: pointer; }.toggle-control strong { font-size: 11px; }.toggle-control small { grid-column: 2; color: #a0a49f; font-size: 9px; }.switch { grid-row: span 2; width: 37px; height: 21px; border-radius: 20px; background: #dadbd6; padding: 3px; transition: .2s; }.switch i { display: block; width: 15px; height: 15px; border-radius: 50%; background: white; box-shadow: 0 1px 4px #0002; transition: .2s; }.toggle-control.on .switch { background: #77988c; }.toggle-control.on .switch i { transform: translateX(16px); }
.textarea-wrap { position: relative; }.textarea-wrap textarea, .text-input { width: 100%; resize: vertical; min-height: 88px; border: 1px solid #e5e4de; outline: 0; border-radius: 10px; padding: 11px 12px 22px; background: #fafaf7; color: #56605b; font-size: 11px; line-height: 1.8; }.text-input { min-height: 0; padding: 10px 12px; }.textarea-wrap textarea:focus, .text-input:focus { border-color: #9cb2aa; background: #fff; }.textarea-wrap span { position: absolute; right: 9px; bottom: 8px; color: #aeb1ad; font-size: 8px; }.choice-row { display: flex; gap: 8px; flex-wrap: wrap; }.choice-row button { border: 1px solid #dfdfd9; background: #fafaf7; border-radius: 9px; padding: 8px 14px; cursor: pointer; font-size: 10px; }.choice-row button.active { background: #e9f0ed; border-color: #83a094; color: #527267; }.bottom-save { display: block; margin: 20px 0 0 auto; }
.stats-header { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 0 2px 18px; }.stats-header h2 { font-family: "Noto Serif SC", serif; margin: 4px 0 0; font-size: 19px; }.range-tabs { flex: 0 0 auto; display: grid; grid-template-columns: repeat(3, 1fr); padding: 3px; border-radius: 9px; background: #e8e7e1; margin-bottom: 15px; }.range-tabs button { border: 0; background: transparent; border-radius: 7px; padding: 6px; color: #929792; font-size: 9px; cursor: pointer; }.range-tabs button.active { background: #fbfaf7; color: #53655e; box-shadow: 0 1px 4px #0000000d; }.stats-scroll { flex: 1 1 auto; height: auto; padding-right: 3px; }.chart-card { margin-bottom: 11px; padding: 14px; border: 1px solid #e1e0d9; border-radius: 13px; background: #faf9f6; }.chart-title { display: flex; align-items: center; justify-content: space-between; }.chart-title > div { display: flex; align-items: center; gap: 7px; }.chart-title strong { font-size: 10px; }.color-dot { width: 7px; height: 7px; border-radius: 50%; }.metric-row { display: flex; justify-content: space-between; align-items: baseline; margin: 8px 0 1px; }.metric-row strong { font-family: "Noto Serif SC", serif; font-size: 21px; }.metric-row strong small { margin-left: 3px; color: #999f9b; font-family: "Noto Sans SC", sans-serif; font-size: 9px; font-weight: 400; }.metric-row span { color: #77988c; font-size: 8px; }.line-chart { display: block; width: 100%; height: 78px; overflow: visible; }.grid-line { stroke: #e6e5df; stroke-width: .6; fill: none; }.chart-axis { display: flex; justify-content: space-between; color: #acafab; font-size: 7px; }.completion { display: flex; align-items: center; gap: 13px; margin: 12px 0; }.completion b { display: block; font-size: 9px; }.completion p { margin: 3px 0 0; color: #7f9a8e; font-size: 8px; }.ring { width: 55px; height: 55px; display: grid; place-items: center; border-radius: 50%; background: conic-gradient(#87a878 0 78%, #e2e5df 78%); position: relative; }.ring::after { content: ""; position: absolute; inset: 5px; background: #faf9f6; border-radius: 50%; }.ring span { position: relative; z-index: 1; font-family: "Noto Serif SC", serif; font-weight: 700; font-size: 14px; }.ring small { font-size: 7px; }.mini-bars { display: flex; gap: 4px; }.mini-bars i { flex: 1; height: 13px; border-radius: 3px; background: #e2e4df; }.mini-bars i.filled { background: #9ab28f; }.insight-card { display: flex; gap: 10px; padding: 13px; border-radius: 12px; background: #e8efeb; color: #557166; }.insight-card > span { font-size: 15px; }.insight-card strong { font-size: 10px; }.insight-card p { margin: 3px 0 0; color: #71877f; font-size: 8px; line-height: 1.6; }
.modal-backdrop { position: fixed; z-index: 50; inset: 0; display: grid; place-items: center; padding: 30px; background: #35403973; backdrop-filter: blur(3px); }.template-editor { width: min(720px, 92vw); max-height: 90vh; overflow-y: auto; border: 1px solid #e4e2db; border-radius: 18px; background: #faf9f6; box-shadow: 0 24px 80px #29332d42; }.template-editor > header { display: flex; justify-content: space-between; padding: 25px 28px 18px; border-bottom: 1px solid #e6e4dd; }.template-editor h2 { font-family: "Noto Serif SC", serif; margin: 4px 0; font-size: 21px; }.template-editor header p { margin: 0; color: #8e9691; font-size: 10px; }.close-button { font-size: 25px; }.version-note { display: flex; gap: 10px; margin: 17px 28px; padding: 11px 13px; border-radius: 10px; background: #edf3f0; color: #5c776d; }.version-note > span { font-size: 18px; }.version-note strong { font-size: 10px; }.version-note p { margin: 2px 0 0; font-size: 8px; color: #7d938b; }.editor-list { padding: 0 28px; display: grid; gap: 8px; }.editor-item { display: flex; align-items: center; gap: 10px; padding: 10px; border: 1px solid #e3e2dc; border-radius: 11px; background: white; }.drag-handle { color: #b3b6b2; cursor: grab; }.component-badge { display: grid; place-items: center; width: 31px; height: 31px; border-radius: 9px; font-weight: 700; font-size: 11px; }.editor-fields { flex: 1; min-width: 0; }.editor-fields input { width: 100%; border: 0; outline: 0; padding: 0; color: #414b46; font-weight: 600; font-size: 11px; }.editor-fields small { display: block; color: #a0a49f; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 8px; }.chart-toggle { display: flex; align-items: center; gap: 5px; color: #8b928e; font-size: 8px; }.chart-toggle input { display: none; }.chart-toggle span { width: 25px; height: 15px; padding: 2px; border-radius: 20px; background: #d9dad5; }.chart-toggle span::after { content: ""; display: block; width: 11px; height: 11px; border-radius: 50%; background: white; transition: .2s; }.chart-toggle input:checked + span { background: #75958a; }.chart-toggle input:checked + span::after { transform: translateX(10px); }.move-buttons { display: flex; }.move-buttons button, .delete-button { border: 0; background: transparent; color: #989e9a; cursor: pointer; }.move-buttons button:disabled { opacity: .25; }.delete-button { font-size: 17px; }.delete-button:hover { color: #b86f64; }.add-component { display: block; width: calc(100% - 56px); margin: 12px 28px; padding: 10px; border: 1px dashed #aebbb5; border-radius: 10px; color: #668277; background: #f5f7f4; cursor: pointer; font-size: 10px; }.catalog-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px; margin: 0 28px 14px; }.catalog-grid button { display: flex; align-items: center; gap: 9px; border: 1px solid #e2e1db; border-radius: 10px; background: white; padding: 9px; text-align: left; cursor: pointer; }.catalog-grid button:hover { border-color: #8ca59b; background: #f5f8f6; }.catalog-grid button > span { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: #edf1ee; color: #698478; }.catalog-grid strong { display: block; font-size: 9px; }.catalog-grid small { display: block; color: #a0a39f; font-size: 7px; }.template-editor > footer { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 28px 22px; border-top: 1px solid #e6e4dd; }
.data-confirm-modal { width: min(430px, 90vw); padding: 28px; border: 1px solid #e5d9d4; border-radius: 17px; background: #fffdfa; box-shadow: 0 24px 70px #29332d42; text-align: center; }.warning-mark { display: grid; place-items: center; width: 38px; height: 38px; margin: 0 auto 12px; border-radius: 50%; background: #f7e4dc; color: #ac604c; font-family: serif; font-size: 23px; font-weight: 700; }.data-confirm-modal h2 { margin: 0; font-family: "Noto Serif SC", serif; font-size: 18px; }.data-confirm-modal p { margin: 10px 0; color: #7f8782; font-size: 10px; line-height: 1.7; }.confirm-file { margin: 12px 0; padding: 8px; border-radius: 8px; background: #f2f1ed; color: #727b76; overflow-wrap: anywhere; font-size: 8px; text-align: left; }.data-confirm-modal footer { display: flex; justify-content: center; gap: 9px; margin-top: 18px; }.danger-button { border: 1px solid #a96453; border-radius: 10px; padding: 9px 15px; background: #ae6957; color: white; cursor: pointer; font-size: 10px; }.danger-button:hover { background: #995a49; }.danger-button:disabled { cursor: wait; opacity: .55; }
.weight-settings { grid-template-columns: repeat(4, 1fr); }.fixed-setting { display: flex; flex-direction: column; gap: 6px; }.fixed-setting span { color: #939a96; font-size: 8px; }.fixed-setting strong { font-size: 9px; font-weight: 600; }
.metric-row { align-items: flex-end; }.metric-row > div > small { display: block; margin-bottom: 1px; color: #9ba09d; font-size: 7px; }.metric-row strong { display: block; }.metric-row strong small { display: inline; }.numeric-editor-item { display: block; padding: 0; overflow: hidden; }.editor-item-main { display: flex; align-items: center; gap: 10px; padding: 10px; }.number-settings { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; padding: 12px 14px 14px 51px; border-top: 1px solid #ecebe6; background: #fafaf7; }.number-settings label { min-width: 0; }.number-settings label > span { display: block; margin-bottom: 4px; color: #929995; font-size: 8px; }.number-settings input, .number-settings select { width: 100%; height: 30px; border: 1px solid #deded8; border-radius: 7px; outline: 0; padding: 0 8px; background: white; color: #56605b; font-size: 9px; }.number-settings input:focus, .number-settings select:focus { border-color: #8da69c; }.required-setting button { width: 100%; height: 30px; border: 1px solid #deded8; border-radius: 7px; background: white; color: #8c938f; cursor: pointer; font-size: 9px; }.required-setting button.active { border-color: #c69c88; background: #f8eee9; color: #a36f58; }
.empty-chart { display: grid; place-items: center; height: 78px; margin-top: 5px; border-radius: 9px; background: #f2f1ed; color: #a4aaa6; font-size: 8px; }
.chart-actions { display: flex; gap: 2px !important; }.chart-actions button { width: 25px; height: 25px; border-radius: 7px; font-size: 14px; }.chart-card:has(> .chart-title + template) { padding-bottom: 14px; }
.chart-range-control { position: relative; }.chart-actions .chart-range-button { width: auto; min-width: 38px; padding: 0 5px; border: 0; background: transparent; color: #77827d; cursor: pointer; font-size: 8px; }.chart-actions .chart-range-button:hover { background: #eceeea; color: #52675e; }.chart-range-menu { position: absolute; z-index: 20; top: 29px; left: 50%; width: 62px; padding: 4px; transform: translateX(-50%); border: 1px solid #dcddd7; border-radius: 9px; background: #fffefa; box-shadow: 0 9px 24px #34413a20; }.chart-actions .chart-range-menu button { width: 100%; height: auto; border: 0; border-radius: 6px; padding: 6px 4px; background: transparent; color: #78817d; cursor: pointer; font-size: 8px; }.chart-actions .chart-range-menu button:hover { background: #edf1ee; }.chart-actions .chart-range-menu button.active { background: #e4ece8; color: #4e6b60; font-weight: 700; }
.learning-month-control { position: relative; min-width: 54px; height: 25px; display: grid !important; place-items: center; border-radius: 7px; color: #68766f; font-size: 7px; overflow: hidden; }.learning-month-control:hover { background: #eceeea; }.learning-month-control input { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }.mini-heat-weekdays, .mini-heat-calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }.mini-heat-weekdays { margin: 8px 0 3px; color: #a4aaa6; text-align: center; font-size: 6px; }.mini-heat-day { aspect-ratio: 1; display: grid; place-items: center; border-radius: 4px; background: #eceee8; color: #75817b; font-size: 6px; }.mini-heat-day.blank { background: transparent; }.mini-heat-day.level-1, .heat-legend .level-1 { background: #dcebe2; }.mini-heat-day.level-2, .heat-legend .level-2 { background: #bbd7c7; }.mini-heat-day.level-3, .heat-legend .level-3 { background: #8fbea4; color: white; }.mini-heat-day.level-4, .heat-legend .level-4 { background: #5f9d7a; color: white; }.mini-heat-day.level-5, .heat-legend .level-5 { background: #347455; color: white; }.heat-legend { display: flex; justify-content: flex-end; align-items: center; gap: 3px; margin-top: 7px; color: #a0a5a2; font-size: 6px; }.heat-legend i { width: 9px; height: 9px; border-radius: 2px; }
.chart-detail-modal { width: min(900px, 92vw); max-height: 90vh; overflow-y: auto; border: 1px solid #e3e1da; border-radius: 18px; background: #fbfaf7; box-shadow: 0 24px 80px #29332d42; }.chart-detail-modal > header { display: flex; justify-content: space-between; align-items: flex-start; padding: 24px 28px 16px; border-bottom: 1px solid #e6e4dd; }.chart-detail-modal h2 { margin: 5px 0 3px; font-family: "Noto Serif SC", serif; font-size: 22px; }.chart-detail-modal header p { margin: 0; color: #929995; font-size: 9px; }.detail-legend { margin: 14px 28px 0; }.detail-chart-wrap { padding: 8px 22px 0; overflow-x: auto; }.detail-chart { display: block; width: 100%; min-width: 650px; height: 350px; }.detail-grid-line { stroke: #e4e4de; stroke-width: 1; }.detail-axis-line { stroke: #aeb4b0; stroke-width: 1.2; }.detail-axis-label, .detail-date-label, .detail-unit-label { fill: #8d9590; font-family: "Noto Sans SC", sans-serif; font-size: 9px; }.detail-date-label { font-size: 8px; }.detail-unit-label { font-size: 10px; }.extreme-value-label { fill: #53675f; font-family: "Noto Sans SC", sans-serif; font-size: 10px; font-weight: 700; paint-order: stroke; stroke: #fbfaf7; stroke-width: 4px; stroke-linejoin: round; }.morning-value-label { fill: #537d6e; }.evening-value-label { fill: #af7048; }.detail-empty { display: grid; place-items: center; height: 300px; color: #a0a6a2; font-size: 11px; }.sample-list { margin: 0 28px 26px; border-top: 1px solid #e6e4dd; padding-top: 16px; }.sample-list-head { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 10px; }.sample-list-head span { color: #929995; }.sample-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; max-height: 180px; overflow-y: auto; }.sample-item { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; padding: 9px 10px; border: 1px solid #e6e4de; border-radius: 9px; background: white; }.sample-item span { font-size: 9px; }.sample-item small { color: #929995; font-size: 8px; }.sample-item strong { grid-column: 1 / -1; color: #52675f; font-family: "Noto Serif SC", serif; font-size: 13px; }
.interactive-chart { cursor: crosshair; }.hover-guide { stroke: #8fa39a; stroke-width: 1.2; stroke-dasharray: 4 4; opacity: .8; pointer-events: none; }.hover-date-label, .hover-value-label { font-family: "Noto Sans SC", sans-serif; font-weight: 700; paint-order: stroke; stroke: #fbfaf7; stroke-width: 5px; stroke-linejoin: round; pointer-events: none; }.hover-date-label { fill: #53645d; font-size: 10px; }.hover-value-label { font-size: 10px; }.hover-halo { opacity: .18; transform-box: fill-box; transform-origin: center; animation: sample-pulse 1.25s ease-out infinite; pointer-events: none; }.hover-core { filter: drop-shadow(0 2px 4px #34413a38); pointer-events: none; }@keyframes sample-pulse { 0% { transform: scale(.65); opacity: .32; } 70%, 100% { transform: scale(1.35); opacity: 0; } }
.curve-calendars { display: grid; gap: 14px; }.curve-calendar { --curve-color: #729b8b; padding: 14px; border: 1px solid #e2e2dc; border-radius: 13px; background: #f8f8f4; }.curve-calendar > header { display: flex; align-items: center; gap: 7px; margin-bottom: 13px; }.curve-calendar > header .curve-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--curve-color); }.curve-calendar > header strong { font-size: 11px; }.curve-calendar > header small { margin-left: auto; color: #989f9b; font-size: 8px; }.calendar-months { display: grid; grid-template-columns: repeat(auto-fit, minmax(225px, 1fr)); gap: 12px; }.sample-month { min-width: 0; padding: 11px; border: 1px solid #e8e7e1; border-radius: 10px; background: #fffefa; }.sample-month h3 { margin: 0 0 9px; color: #5e6964; font-family: "Noto Serif SC", serif; font-size: 10px; text-align: center; }.sample-weekdays, .sample-calendar-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 3px; }.sample-weekdays { margin-bottom: 4px; color: #a5aaa7; text-align: center; font-size: 7px; }.sample-day { min-width: 0; min-height: 45px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; border: 1px solid #ecebe6; border-radius: 7px; background: #fafaf7; }.sample-day small { color: #a9aeaa; font-size: 7px; font-weight: 400; }.sample-day strong { max-width: 100%; color: #4c5b55; font-family: "Noto Serif SC", serif; font-size: 10px; line-height: 1; white-space: nowrap; }.sample-day strong em { margin-left: 1px; color: #8d9691; font-family: "Noto Sans SC", sans-serif; font-size: 6px; font-style: normal; font-weight: 400; }.sample-day > span { color: #c6c9c6; font-size: 9px; }.sample-day.recorded { border-color: color-mix(in srgb, var(--curve-color) 34%, #e7e6df); background: color-mix(in srgb, var(--curve-color) 8%, #fffefa); box-shadow: inset 0 2px 0 color-mix(in srgb, var(--curve-color) 60%, transparent); }.sample-day.blank { border-color: transparent; background: transparent; }.sample-day.outside { opacity: .28; background: transparent; }.sample-day.outside strong, .sample-day.outside span { display: none; }
.sample-list-head { position: relative; align-items: center; justify-content: flex-start; min-height: 25px; }.sample-calendar-nav { position: absolute; left: 50%; transform: translateX(-50%); display: grid; grid-template-columns: 25px 104px 25px; align-items: center; gap: 4px; }.sample-calendar-nav button { width: 25px; height: 25px; border: 1px solid #dbddd7; border-radius: 7px; background: #fffefa; color: #64726c; cursor: pointer; font-size: 16px; line-height: 1; }.sample-calendar-nav button:hover { border-color: #91a69d; background: #edf2ef; }.sample-calendar-nav button:disabled { cursor: wait; opacity: .45; }.sample-calendar-nav span { color: #64706a; text-align: center; font-family: "Noto Serif SC", serif; font-size: 9px; }.curve-calendars { transition: opacity .18s ease; }.curve-calendars.loading { opacity: .45; pointer-events: none; }
.learning-detail-view { padding: 18px 28px 28px; }.learning-detail-nav { position: relative; left: auto; transform: none; width: max-content; margin: 0 auto 14px; }.learning-detail-weekdays, .learning-detail-calendar { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }.learning-detail-weekdays { margin-bottom: 5px; color: #a0a6a2; text-align: center; font-size: 8px; }.learning-detail-calendar { transition: opacity .18s; }.learning-detail-calendar.loading { opacity: .4; pointer-events: none; }.learning-detail-day { min-height: 82px; display: flex; flex-direction: column; align-items: flex-start; gap: 7px; border: 1px solid #e5e5df; border-radius: 10px; padding: 8px; background: #fffefa; color: #5d6963; cursor: pointer; text-align: left; }.learning-detail-day:hover { border-color: #9db4a8; background: #f3f7f4; }.learning-detail-day.selected { border-color: #668c7b; box-shadow: 0 0 0 2px #729b8b22; }.learning-detail-day.recorded { background: #f6faf7; }.learning-detail-day.blank { visibility: hidden; }.learning-detail-day small { color: #a5aaa7; font-size: 8px; }.learning-day-logos { display: flex; flex-wrap: wrap; gap: 3px; font-size: 15px; }.learning-day-logos b { display: grid; place-items: center; min-width: 21px; height: 21px; border-radius: 10px; background: #e6ece8; color: #6d7f76; font-size: 7px; }.learning-no-entry { align-self: center; color: #d0d2cf; }.learning-day-detail { margin-top: 18px; padding-top: 16px; border-top: 1px solid #e4e3dd; }.learning-day-detail > header { display: flex; justify-content: space-between; align-items: center; }.learning-day-detail h3 { margin: 4px 0 0; font-family: "Noto Serif SC", serif; font-size: 15px; }.learning-day-detail > header > strong { color: #5c796c; font-size: 10px; }.learning-history-list { display: grid; gap: 8px; margin-top: 12px; }.learning-history-list article { display: grid; grid-template-columns: 38px 1fr; gap: 10px; padding: 11px; border: 1px solid #e4e4de; border-radius: 10px; background: white; }.learning-history-list article > span { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: #edf3ef; font-size: 20px; }.learning-history-list strong { font-size: 10px; }.learning-history-list small { margin-left: 8px; color: #819087; font-size: 8px; }.learning-history-list p { margin: 6px 0 0; color: #737d78; white-space: pre-wrap; font-size: 9px; line-height: 1.6; }.detail-empty-learning { padding: 25px; color: #a2a7a4; text-align: center; font-size: 9px; }
.editor-error { margin: -7px 28px 14px; padding: 9px 11px; border: 1px solid #e2b9ac; border-radius: 9px; background: #fff1ed; color: #a45f4d; font-size: 9px; }.template-editor button:disabled { cursor: wait; opacity: .55; }
@media (max-width: 1120px) { .app-shell { --right: 300px; --left: 250px; }.record-header, .record-scroll { padding-left: 28px; padding-right: 28px; }.number-settings { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
