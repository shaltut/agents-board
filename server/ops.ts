// The board operations cb, its relay and its hooks name (#3222): each is the cb.* function of the same name, called with
// named arguments through cli/board.ts. Default deny: a name that is not here is not called. This is the workers' list,
// not the web's (server/rpc.ts RPC_FUNCTIONS); the worker API (server/worker.ts) serves from it. setof: the function
// returns rows, not one value. No _name is ever listed. test/ops-list.test.ts keeps it equal to what is called and to
// db/schema.sql.
/** The kinds of worker key (cb.worker_keys). */
export type Kind = 'machine' | 'runner' | 'supervisor';
/** kinds: whose keys may call it over the worker API; none: only a caller with its own database connection.
 *  bytes: pictures travel in it, so its request may be 16 MB, not 1. machineLabel: its machine argument says what a row
 *  is about, not who is calling. */
export type Op = { setof?: true; kinds: readonly Kind[]; bytes?: true; machineLabel?: true };

const seat: readonly Kind[] = ['machine'];
const list = (more: Omit<Op, 'kinds'> & { kinds?: readonly Kind[] }, names: string) =>
  names.trim().split(/\s+/).map((n) => [n, { kinds: seat, ...more }] as const);
const one = {}, rows = { setof: true } as const, never = { kinds: [] };

export const OPS: Record<string, Op> = Object.fromEntries([
  ...list(one, `
    answer_delivered ask_record ask_reply asks_list brief broadcast digest epics_list fault_file github_watches
    goals_list huddle_add huddle_close huddle_open huddle_say huddles_list iam lock_queue lock_release lock_take log
    machine_models_set mem_find mem_list mem_pack mem_retire mem_rule mem_show mem_supersede next_empty_words next_step
    page_get page_set project_state_preview question_assign read_project resolve resume role_text seat_backup_clear
    seat_effort session_project_of sessions_overview squad_get squad_options squad_set stage_fail stage_pass stage_set
    start_words task_add task_block task_done task_find task_finish_line task_move task_notes_total task_project
    task_status task_tag task_unblock task_update tell withdraw
    broadcast_seen inbox_ping job_add job_cancel job_get job_hold job_log_url job_move job_retry jobs_ended jobs_list
    refusal_targets relay_hold resume_for_pane schema_check seat_code seat_model stage_words_for usage_report
    usage_summary work_still_open
  `),
  ...list({ bytes: true }, 'ask_post reask_post'),
  ...list({ machineLabel: true }, 'mem_add'),
  ...list(rows, `
    answers_pending ask_parent ask_relay bug_filed held_parts_of huddle_lines huddle_member_names huddle_row mine
    my_questions question_state questions_brief released_by session_binding session_events session_questions
    session_tasks start_projects task_claim task_filed task_goals task_notes task_queue task_row task_words
    tell_delivery users_overview
  `),
  // users, sign-ins and the GitHub watch are the owner's: never over the worker API
  ...list(never, 'github_mute github_watch_add github_watch_remove user_add user_known user_password user_set_role'),
  ...list({ ...never, ...rows }, 'user_show'),
  // the runner's: not served yet. The slice that moves the runner (S4) gives them its kind, once each is bound to the
  // key's runner (some name it by another argument, or by a job).
  ...list(never, 'job_claim job_finish runner_beat runner_hello runner_reconcile_held runner_settings'),
  ...list({ ...never, ...rows }, 'jobs_cancelled'),
  // a write that names neither a machine nor an actor, so the worker API has nothing to bind to the key: not served until
  // the slice that moves the relay (S3) gives it one
  ...list(never, 'ask_delivered'),
]);
