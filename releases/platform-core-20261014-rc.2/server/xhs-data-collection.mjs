export const XHS_DATA_COLLECTION_PROTOCOL = "xhs_data_collect_v1";
export const XHS_DATA_COLLECTION_TTL_MS = 21 * 60_000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (value) => datePattern.test(String(value)) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const text = (value, limit) => String(value ?? "").slice(0, limit);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const invalid = (message) => { throw Object.assign(new TypeError(message), { statusCode: 400 }); };

export function hasXhsDataCollectionCapability(agent) {
  return agent?.health?.xhsDataCollect?.protocol === XHS_DATA_COLLECTION_PROTOCOL
    && agent.health.xhsDataCollect.ready === true;
}

export function sanitizeXhsDataCollection(input) {
  if (!input || input.schema_version !== 3 || input.window_days !== 30
      || !isDate(input.window_start_date) || !isDate(input.window_end_date)
      || Date.parse(input.window_end_date) - Date.parse(input.window_start_date) !== 29 * 86400_000
      || !Array.isArray(input.notes) || input.notes.length > 1000) {
    invalid("invalid_xhs_collection_result");
  }
  const notes = input.notes.map((note) => {
    if (!note || !isDate(note.published_date) || !String(note.title || "").trim()
        || note.published_date < input.window_start_date || note.published_date > input.window_end_date) {
      invalid("invalid_xhs_collection_note");
    }
    return {
      title: text(note.title, 180), published_date: note.published_date,
      published_at_raw: text(note.published_at_raw, 10), status_raw: text(note.status_raw, 120),
      list_view_count: count(note.list_view_count), list_like_count: count(note.list_like_count),
      list_comment_count: count(note.list_comment_count), note_id: null
    };
  });
  const complete = input.complete === true
    && ["list_end_visible", "older_than_window_visible"].includes(input.stop_reason);
  const totals = Object.fromEntries(["list_view_count", "list_like_count", "list_comment_count"]
    .map((key) => [key, notes.some((note) => note[key] === null) ? null : notes.reduce((sum, note) => sum + note[key], 0)]));
  return {
    schema_version: 3, source: "xhs_creator_center_works_analysis_list", window_days: 30,
    window_start_date: input.window_start_date, window_end_date: input.window_end_date,
    captured_at: text(input.captured_at, 80), account_bound: input.account_bound === true,
    app_slot: input.app_slot === "app2" ? "app2" : "app1",
    list_scope_raw: text(input.list_scope_raw, 160), complete,
    stop_reason: text(input.stop_reason, 80), scrolls: count(input.scrolls),
    warnings: Array.isArray(input.warnings) ? input.warnings.slice(0, 20).map((value) => text(value, 160)) : [],
    recovery_events: Array.isArray(input.recovery_events) ? input.recovery_events.slice(0, 100).map((value) => text(value, 160)) : [],
    notes, totals
  };
}
