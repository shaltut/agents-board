// The board operations cb names (#3222): each is the cb.* function of the same name, called with named arguments
// through cli/board.ts. Default deny: a name that is not here is not called. This is cb's list, not the web's
// (server/rpc.ts RPC_FUNCTIONS); the worker API will serve from it. setof: the function returns rows, not one value.
// No _name is ever listed. test/ops-list.test.ts keeps it equal to what cb calls and to db/schema.sql.
export type Op = { setof?: true };

const one: Op = {}, rows: Op = { setof: true };
const list = (op: Op, names: string) => names.trim().split(/\s+/).map((n) => [n, op] as const);

export const OPS: Record<string, Op> = Object.fromEntries([
  ...list(one, `
    answer_delivered ask_post ask_record ask_reply asks_list brief broadcast digest epics_list fault_file github_mute
    job_claim job_finish runner_beat runner_hello runner_reconcile_held runner_settings
    board_now jobs_list lease_release lease_renew lease_take seat_switch supervise_log supervise_mark supervise_state
    github_watch_add github_watch_remove github_watches goals_list huddle_add huddle_close huddle_open huddle_say
    huddles_list iam lock_queue lock_release lock_take log machine_models_set mem_add mem_find mem_list mem_pack
    mem_retire mem_rule mem_show mem_supersede next_empty_words next_step page_get page_set project_state_preview
    question_assign read_project reask_post resolve resume role_text seat_backup_clear seat_effort session_project_of
    sessions_overview squad_get squad_options squad_set stage_fail stage_pass stage_set start_words task_add
    task_block task_done task_find task_finish_line task_move task_notes_total task_project task_status task_tag
    task_unblock task_update tell user_add user_known user_password user_set_role withdraw
  `),
  ...list(rows, `
    answers_pending ask_parent ask_relay bug_filed held_parts_of huddle_lines huddle_member_names huddle_row jobs_cancelled mine
    sessions_live squad_history supervised_projects
    my_questions question_state questions_brief released_by session_binding session_events session_questions
    session_tasks start_projects task_claim task_filed task_goals task_notes task_queue task_row task_words
    tell_delivery user_show users_overview
  `),
]);
