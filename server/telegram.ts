// Telegram answering (#683): the board's own bot sends Ahmed's open questions to his paired chat and answers them
// from there through the dashboard's path (cb-web, as ahmed). Long polling, plain text, no dependency.
// The token travels in every request URL: errors here name the method and status only, never the URL.
import { randomBytes } from 'node:crypto';
import { sql, dotenv } from './db.ts';
import { callFn } from './rpc.ts';
import { inlineText, mdText } from './mdtext.ts';

const LIMIT = 4096; // Telegram's message length, in UTF-16 units (a JS string's length)
const RECOMMENDED = /\s*\(recommended\)\s*$/i; // as QuestionCard strips it from a clicked label
const REASONS: Record<string, string> = { details: 'More details', clarify: 'Clarify', simplify: 'Simplify', reask: 'Re-ask', visual: 'Show me' };
const CUT = '\n[context cut: the full text is on the dashboard]';

type Q = { id: number; project: string; asked_by: string; body: string; context: string | null; multi: boolean;
  options: { label: string; description: string | null }[] | null; blocking?: boolean; task_id?: number | null;
  versions?: { reason: string | null }[] | null; hands?: { name: string; display: string }[]; pictures?: number };
type Button = { text: string; callback_data: string };
// How many pictures a question carries (cb ask --image): the chat says so and points at the board, where they show.
const PICS = () => sql`(select count(*)::int from cb.question_images i where i.question_id = q.id) as pictures`;
let board: string | undefined; // read once: compose runs on every message
const boardUrl = () => (board ??= (process.env.CB_PUBLIC_URL || dotenv('PUBLIC_URL') || '').replace(/\/$/, ''));
// The people a question can be handed to (#1200): those on its project, as the dashboard's For picker offers them.
const HANDS = () => sql`(select coalesce(jsonb_agg(jsonb_build_object('name', u.name, 'display', u.display) order by u.name), '[]')
  from cb.users u join cb.user_projects up on up.user_name = u.name where up.project = q.project) as hands`;

let cfg: { token: string; api: string } | null = null;
let bot: string | null = null; // the bot's username, from getMe
let code: { value: string; until: number } | null = null; // ponytail: one pairing code in memory; a restart drops it (ask again)
let stop: AbortController | null = null;
let loop: Promise<void> | null = null;

class TgError extends Error {
  status: number; description: string; retryAfter: number; // retryAfter: a 429's parameters.retry_after, in seconds
  constructor(method: string, status: number, description = '', retryAfter = 0) {
    super(`telegram ${method}: ${status} ${description}`.trim());
    this.status = status; this.description = description; this.retryAfter = retryAfter;
  }
}

async function tg(method: string, body: object = {}): Promise<any> {
  if (!cfg) throw new Error('telegram is not configured');
  for (let tries = 0; ; tries++) {
    const signal = AbortSignal.any([stop!.signal, AbortSignal.timeout(method === 'getUpdates' ? 40_000 : 15_000)]);
    const r = await fetch(`${cfg.api}/bot${cfg.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    }).catch((e) => { throw new TgError(method, 0, e?.name === 'TimeoutError' ? 'timed out' : 'network error'); });
    const j: any = await r.json().catch(() => ({}));
    if (j.ok) return j.result;
    const wait = j.parameters?.retry_after;
    if (r.status === 429 && wait && wait <= 30 && tries < 3) { await sleep(wait * 1000); continue; } // a burst (the backlog at pairing)
    throw new TgError(method, r.status, j.description, Number(wait) || 0);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const notModified = (e: any) => e instanceof TgError && /not modified/i.test(e.description);
const fit = (s: string, n: number) => s.slice(0, Math.max(0, n)).replace(/[\uD800-\uDBFF]$/, ''); // never half a surrogate pair

/** The message for a question: plain text (no parse mode, nothing to escape) and its buttons. outcome closes it.
 *  Questions are Markdown, which Telegram can't show as written: mdText reads it out (tables as rows, links with
 *  their address). Labels stay as written: they are the answer. */
export function compose(q: Q, picked: string[] = [], outcome?: string) {
  const opts = q.options ?? [];
  const head = [`Q${q.id} · ${q.project} · from ${q.asked_by}`,
    q.blocking && q.task_id ? `Holding #${q.task_id} until you answer` : '',
    q.versions?.length ? `Rewritten${q.versions.at(-1)?.reason ? ` (${q.versions.at(-1)!.reason === 'visual' ? 'with pictures' : REASONS[q.versions.at(-1)!.reason!]?.toLowerCase()})` : ''}` : ''].filter(Boolean).join('\n');
  const list = opts.length ? opts.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${inlineText(o.description)}` : ''}`).join('\n')
    + (q.multi ? '\nPick any, then Send.' : '') : '';
  const how = outcome ?? (opts.length ? 'Tap an option, or reply to this message with your own answer.' : 'Reply to this message to answer.');
  let body = mdText(q.body), ctx = mdText(q.context ?? '');
  const pics = q.pictures ? `${q.pictures} picture${q.pictures > 1 ? 's' : ''} with this question: see ${q.pictures > 1 ? 'them' : 'it'} on the board${boardUrl() ? ` ${boardUrl()}` : ''}` : '';
  const join = () => [head, body, pics, list, ctx ? `Context:\n${ctx}` : '', how].filter(Boolean).join('\n\n');
  let text = join();
  if (text.length > LIMIT && ctx) { ctx = fit(ctx, ctx.length - (text.length - LIMIT) - CUT.length) + CUT; text = join(); }
  if (text.length > LIMIT) { body = fit(body, body.length - (text.length - LIMIT) - CUT.length) + CUT; text = join(); }
  text = fit(text, LIMIT);

  const rows: Button[][] = outcome ? [] : [
    ...opts.map((o, i) => [q.multi
      ? { text: `${picked.includes(o.label) ? '[x]' : '[ ]'} ${o.label}`, callback_data: `t:${q.id}:${i}` }
      : { text: o.label, callback_data: `o:${q.id}:${i}` }]),
    ...(q.multi && opts.length ? [[{ text: picked.length ? `Send (${picked.length})` : 'Send', callback_data: `s:${q.id}` }]] : []),
    ...hands(q),
    // two rows: five send-back buttons in one are too narrow on a phone
    ...((b) => [b.slice(0, 3), b.slice(3)])(Object.entries(REASONS).map(([k, v]) => ({ text: v, callback_data: `b:${q.id}:${k}` }))),
  ];
  return { text, reply_markup: { inline_keyboard: rows } };
}

/** Hand to rows, 3 a row: Telegram refuses the whole message for a row over 8 or callback_data over 64 bytes (a name
 *  too long for that is left to the dashboard's For picker). */
function hands(q: Q): Button[][] {
  const b = (q.hands ?? []).map((u) => ({ text: `Hand to ${u.display}`, callback_data: `h:${q.id}:${u.name}` }))
    .filter((x) => Buffer.byteLength(x.callback_data) <= 64);
  return Array.from({ length: Math.ceil(b.length / 3) }, (_, i) => b.slice(i * 3, i * 3 + 3));
}

const WAITING = 'Waiting: this project is disabled. It comes back here, to answer, when Ahmed enables it.';

/** What a closed message says, from the question as it is now. */
function outcome(q: any) {
  if (q.status === 'answered' || q.status === 'delivered')
    return `Answered${q.answered_by && q.answered_by !== 'ahmed' ? ` by ${q.answered_by}` : ''}: ${q.answer}`;
  if (q.status === 'sent_back') return `Sent back: ${REASONS[q.sent_back?.reason]?.toLowerCase() ?? q.sent_back?.reason}${q.sent_back?.note ? ` — ${q.sent_back.note}` : ''}`;
  if (q.status === 'open' && !q.assigned_to && q.live === false) return WAITING;
  if (q.status === 'withdrawn') return 'Withdrawn.';
  if (q.status === 'dormant') return `Waiting again: it opens if Q${q.parent_id}'s answer picks it.`;
  if (q.assigned_to) return `Handed to ${q.assigned_to}.`;
  return 'Closed.';
}

async function pairedChat(): Promise<number | null> {
  const [s] = await sql`select (value ->> 'chat_id')::bigint as chat from cb.settings where key = 'telegram_chat'`;
  return s?.chat ?? null;
}

// One reconcile at a time; a change that lands meanwhile runs it once more.
let running: Promise<void> | null = null, again = false, everyone = false;
// #4591, #4629: a question whose send failed is tried again on its own (on a quiet board no change would come). Each
// question keeps its own gap, from RETRY_MIN doubling to RETRY_MAX, so one that keeps failing never slows a new one.
// A board change still tries every waiting question at once, as before, without growing its gap; the timer's tries grow it.
//  - sent: Telegram took it but its row did not save. Only the row is retried: never a second copy.
//  - refused: Telegram said 4xx other than 429 (chat not found, bot blocked, too long). Neither the timer nor a change
//    tries it again; a rewrite (a new asked_at), a new pairing, a restart, or (a 403) the paired chat writing in does.
//  - hold: a 429 stops every send until its retry_after (flood control is the bot's, not a message's), up to HOLD_MAX:
//    the reply is wire input (TELEGRAM_API may be a proxy), and one absurd value must not silence the bot for a day.
// Memory only: a restart tries each open question once more.
const RETRY_MIN = 1000, RETRY_MAX = 5 * 60_000, HOLD_MAX = 3600; // HOLD_MAX in seconds
type Try = { gap: number; due: number; sent?: number; refused?: number };
const tries = new Map<string, Try>(); // by question, the asking it is (asked_at) and the chat
let hold = 0;
let retry: ReturnType<typeof setTimeout> | null = null, failWait = RETRY_MIN; // failWait: for a pass that throws
let refusedLogged = 0;
const clearRetry = () => { if (retry) clearTimeout(retry); retry = null; };
const forget = () => { tries.clear(); hold = 0; refusedLogged = 0; };
/** Brings Telegram in line with the board: close messages whose question moved on, send questions newly open for Ahmed. */
export const reconcile = (): Promise<void> => run(false);
/** timer: the retry timer's own run, which tries only the questions whose gap is up. */
function run(timer: boolean): Promise<void> {
  if (!cfg) return Promise.resolve();
  if (!timer) everyone = true;
  if (running) { again = true; return running; }
  clearRetry();
  running = (async () => {
    let threw = false;
    do {
      again = false;
      const all = everyone; everyone = false;
      threw = await pass(all).then(() => false, (e) => { console.error(`telegram: ${e.message}`); return true; });
    } while (again);
    if (!cfg) return; // stopped meanwhile
    let at = Infinity, unsent = 0, unrecorded = 0, refused = 0;
    for (const t of tries.values()) {
      if (t.refused) { refused++; continue; }
      if (t.sent === undefined) unsent++; else unrecorded++;
      at = Math.min(at, t.sent === undefined ? Math.max(t.due, hold) : t.due);
    }
    // a pass that threw (the database, say) left its tries untouched, some past due: its own doubling gap, never a spin
    if (threw) at = Date.now() + failWait;
    failWait = threw ? Math.min(failWait * 2, RETRY_MAX) : RETRY_MIN;
    const wait = Math.max(at - Date.now(), 100);
    // the timer wakes at least every RETRY_MAX and re-holds if it must: a delay past setTimeout's ~24.8 days would fire in 1 ms
    const ms = Math.min(wait, RETRY_MAX);
    // counts only: the token and the chat id never reach a log line
    if (unsent || unrecorded || threw || refused > refusedLogged) {
      const said = [unsent && `${unsent} question(s) not sent`, unrecorded && `${unrecorded} sent but not recorded`,
        refused && `${refused} not reached Telegram (refused: not tried again)`].filter(Boolean).join(', ');
      console.error(`telegram: ${said || 'the pass failed'}${at < Infinity ? `; trying again in ${Math.round(wait / 1000)}s` : ''}`);
    }
    refusedLogged = refused;
    if (at === Infinity) return;
    retry = setTimeout(() => { retry = null; void run(true); }, ms);
    retry.unref?.(); // never what keeps the process alive
  })().finally(() => { running = null; });
  return running;
}

/** The next try after a failure: the first, or a try whose gap was up, doubles the gap; a board change's early try keeps it. */
function later(t: Try | undefined, early: boolean, min = 0): Try {
  const gap = !t?.gap ? RETRY_MIN : early ? t.gap : Math.min(t.gap * 2, RETRY_MAX);
  return { gap, due: Date.now() + Math.max(gap, min) };
}

/** A send Telegram did not take: refused as asked, or tried again after its gap or a 429's retry_after. */
function failed(key: string, t: Try | undefined, early: boolean, id: number, e: any) {
  const status = e instanceof TgError ? e.status : 0;
  if (status >= 400 && status < 500 && status !== 429) { // the same send would get the same answer
    tries.set(key, { gap: 0, due: Infinity, refused: status });
    console.error(`telegram: Q${id} not reached Telegram: ${e.message}; not tried again until it is rewritten or the chat writes to the bot`);
    return;
  }
  if (status === 429 && e.retryAfter > HOLD_MAX) console.error(`telegram: a 429 asked to wait ${e.retryAfter}s; waiting ${HOLD_MAX}s`);
  const wait = status === 429 ? Math.min(e.retryAfter, HOLD_MAX) * 1000 : 0;
  if (wait) hold = Math.max(hold, Date.now() + wait);
  tries.set(key, later(t, early, wait));
  console.error(`telegram: sending Q${id}: ${e.message}`);
}

/** One reconcile pass. all: try every waiting question, not only those whose gap is up (a failed edit is not retried). */
async function pass(all: boolean): Promise<void> {
  const chat = await pairedChat();
  if (!chat) { tries.clear(); return; }
  // 1. messages whose question is no longer open for Ahmed as sent (or whose answer changed): show the outcome
  const moved = await sql`select q.*, ${HANDS()}, ${PICS()}, cb._live(q.project) as live, m.message_id, m.chat_id as m_chat, m.state, m.desired from (
      -- waiting: its project is disabled (#4559, Q3019): the buttons come off until it is enabled, then 'open' restores them
      select m.*, case when q.status = 'open' and q.assigned_to is null and not cb._live(q.project) then 'waiting'
                       when q.status = 'open' and q.assigned_to is null and q.created_at = m.asked_at then 'open'
                       when q.status = 'open' and q.assigned_to is null then 'superseded'
                       when q.status in ('answered', 'delivered') then 'answered:' || q.answer
                       when q.status = 'open' then 'assigned:' || q.assigned_to
                       else q.status end as desired
        from cb.telegram_messages m join cb.questions q on q.id = m.question_id) m
    join cb.questions q on q.id = m.question_id
    where m.state <> m.desired and not (m.desired = 'superseded' and m.state <> 'open')`;
  for (const q of moved) {
    try {
      if (q.desired === 'superseded') // rewritten or reopened: the new message below carries it
        await tg('editMessageReplyMarkup', { chat_id: q.m_chat, message_id: q.message_id, reply_markup: { inline_keyboard: [] } });
      else if (q.desired === 'open') // handed back to Ahmed as it was asked: the same message, buttons again
        await tg('editMessageText', { chat_id: q.m_chat, message_id: q.message_id, ...compose(q) });
      else await tg('editMessageText', { chat_id: q.m_chat, message_id: q.message_id, ...compose(q, [], outcome(q)) });
    } catch (e: any) { if (!notModified(e)) console.error(`telegram: Q${q.id}: ${e.message}`); }
    await sql`update cb.telegram_messages set state = ${q.desired}, awaiting = null, picked = '[]' where question_id = ${q.id}`;
  }
  // 2. open for Ahmed and not on Telegram as it stands: send it (new, rewritten, a follow-up that opened, handed back)
  // asked_at as text: created_at has microseconds, which a JS Date would drop (and every pass would re-send)
  const fresh = await sql`select q.*, ${HANDS()}, ${PICS()}, q.created_at::text as asked_at from cb.questions q left join cb.telegram_messages m on m.question_id = q.id
    where q.status = 'open' and q.assigned_to is null and (m.question_id is null or m.state <> 'open' or m.chat_id <> ${chat})
      and cb._live(q.project) -- #4559 (Q3019): a disabled project's questions wait; enabling it sends them (cb.project_state notifies questions)
    order by q.created_at, q.id`;
  const seen = new Set<string>();
  for (const q of fresh) {
    const key = `${q.id} ${q.asked_at} ${chat}`, t = tries.get(key), now = Date.now();
    const early = !!t && t.due > now + 50; // its gap is not up yet
    seen.add(key);
    if (t?.refused || (early && !all)) continue;
    let sent = t?.sent;
    if (sent === undefined) {
      if (hold > now) { tries.set(key, { gap: t?.gap ?? 0, due: hold }); continue; }
      try { sent = Number((await tg('sendMessage', { chat_id: chat, ...compose(q as any) })).message_id); }
      catch (e: any) { failed(key, t, early, q.id, e); continue; }
    }
    try {
      await sql`insert into cb.telegram_messages (question_id, chat_id, message_id, asked_at)
                values (${q.id}, ${chat}, ${sent}, ${q.asked_at}::text::timestamptz) -- text first: a timestamptz param goes through a JS Date
                on conflict (question_id) do update set chat_id = excluded.chat_id, message_id = excluded.message_id,
                  asked_at = excluded.asked_at, state = 'open', picked = '[]', awaiting = null, prompt_id = null`;
      tries.delete(key);
    } catch (e: any) { // Telegram has it: keep its message_id and retry the row alone, never a second copy
      console.error(`telegram: Q${q.id} sent, not recorded: ${e.message}`);
      tries.set(key, { ...later(t, early), sent });
    }
  }
  for (const key of tries.keys()) if (!seen.has(key)) tries.delete(key); // answered, withdrawn, handed on, disabled: done
}

/** Answer or send back as Ahmed's dashboard, once: refused if it is no longer open for him. */
// asked: the message's asked_at as text; a question rewritten since (cb.reask: same id, new options) is refused.
async function act(id: number, asked: string, fn: 'answer' | 'send_back' | 'question_assign', args: Record<string, unknown>): Promise<string | null> {
  try {
    const done = await sql.begin(async (tx: any) => {
      await tx`set local application_name = 'cb-web'`;
      const [q] = await tx`select *, created_at = ${asked}::text::timestamptz as same, cb._live(project) as live from cb.questions where id = ${id} for update`;
      if (!q || q.status !== 'open' || q.assigned_to || !q.live) return refusal(id, q); // #4559: a disabled project's question waits
      if (!q.same) return `Q${id} was rewritten: answer the new message.`;
      await callFn(fn, { id: String(id), ...args }, tx);
      return null;
    });
    await reconcile(); // the NOTIFY does this too; awaiting it shows the outcome before we reply
    return done;
  } catch (e: any) {
    return `Could not ${{ answer: 'answer', send_back: 'send back', question_assign: 'hand on' }[fn]} Q${id}: ${e.message}`;
  }
}

/** Why a question can't be answered from here now. */
function refusal(id: number, q: any) {
  if (!q) return `Q${id} is not on the board.`;
  if (q.status === 'open' && q.assigned_to) return `Q${id} is handed to ${q.assigned_to} now.`;
  if (q.status === 'open' && q.live === false) return `Q${id} waits: its project is disabled. It comes back here when Ahmed enables it.`;
  if (q.status === 'answered' || q.status === 'delivered') return `Q${id} is already answered: ${q.answer}`;
  if (q.status === 'sent_back') return `Q${id} is already sent back; it comes back when the session rewrites it.`;
  if (q.status === 'open') return `Q${id} was rewritten: answer the new message.`;
  return `Q${id} is already ${q.status}.`;
}

const say = (chat: number, text: string, more: object = {}) => tg('sendMessage', { chat_id: chat, text, ...more });

async function row(where: any) {
  const [m] = await sql`select m.*, m.asked_at::text as asked, q.options, q.multi from cb.telegram_messages m join cb.questions q on q.id = m.question_id where ${where}`;
  return m;
}

async function onButton(cb: any, chat: number) {
  const [kind, idS, arg] = String(cb.data ?? '').split(':');
  const id = Number(idS);
  const m = Number.isSafeInteger(id) ? await row(sql`m.question_id = ${id}`) : null;
  const toast = (text: string, alert = false) => tg('answerCallbackQuery', { callback_query_id: cb.id, text: fit(text, 200), show_alert: alert });
  if (!m || m.message_id !== cb.message?.message_id || m.chat_id !== chat) return toast('This message is out of date.');
  if (m.state !== 'open') return toast(refusal(id, (await sql`select *, cb._live(project) as live from cb.questions where id = ${id}`)[0]), true);
  const label = (i: string) => m.options?.[Number(i)]?.label as string | undefined;
  if (kind === 'o' && label(arg)) {
    const r = await act(id, m.asked, 'answer', { answer: label(arg)!.replace(RECOMMENDED, '') });
    return toast(r ?? 'Answered.', !!r);
  }
  if (kind === 't' && label(arg)) {
    const l = label(arg)!, picked: string[] = m.picked.includes(l) ? m.picked.filter((x: string) => x !== l) : [...m.picked, l];
    await sql`update cb.telegram_messages set picked = ${sql.json(picked)} where question_id = ${id}`;
    const [q] = await sql`select q.*, ${HANDS()}, ${PICS()} from cb.questions q where id = ${id}`;
    await tg('editMessageReplyMarkup', { chat_id: chat, message_id: m.message_id, reply_markup: compose(q as any, picked).reply_markup })
      .catch((e) => { if (!notModified(e)) throw e; });
    return toast(picked.includes(l) ? `Picked ${l}` : `Unpicked ${l}`);
  }
  if (kind === 's') {
    if (!m.picked.length) return toast('Pick at least one first, or reply with your own answer.', true);
    const r = await act(id, m.asked, 'answer', { answer: m.picked.join('; ') });
    return toast(r ?? 'Answered.', !!r);
  }
  if (kind === 'h' && arg) { // the trigger refuses anyone off the question's project
    const r = await act(id, m.asked, 'question_assign', { to_user: arg });
    const [u] = r ? [] : await sql`select display from cb.users where name = ${arg}`;
    return toast(r ?? `Handed to ${u?.display ?? arg}.`, !!r);
  }
  if (kind === 'b' && REASONS[arg]) {
    if (arg === 'clarify') {
      const p = await say(chat, `Reply with your question for the session about Q${id}.`,
        { reply_markup: { force_reply: true, input_field_placeholder: `Your question about Q${id}` } });
      await sql`update cb.telegram_messages set awaiting = 'clarify', prompt_id = ${p.message_id} where question_id = ${id}`;
      return toast('Reply with your question.');
    }
    const r = await act(id, m.asked, 'send_back', { reason: arg, note: null });
    return toast(r ?? 'Sent back.', !!r);
  }
  return toast('Unknown button.');
}

async function onText(msg: any, chat: number) {
  const text = String(msg.text).trim();
  const to = msg.reply_to_message?.message_id;
  if (text.startsWith('/start')) return say(chat, 'This chat is paired with the board: questions come here.');
  if (!to) return say(chat, "Reply to a question's message to answer it (swipe it left, or long-press and Reply).");
  const m = await row(sql`m.chat_id = ${chat} and (m.message_id = ${to} or m.prompt_id = ${to})`);
  if (!m) return say(chat, "That message isn't a question waiting on you (a rewrite comes as a new message).", { reply_parameters: { message_id: msg.message_id } });
  if (m.state !== 'open') return say(chat, refusal(m.question_id, (await sql`select *, cb._live(project) as live from cb.questions where id = ${m.question_id}`)[0]),
    { reply_parameters: { message_id: msg.message_id } });
  const clarify = m.awaiting === 'clarify' && to === m.prompt_id; // a reply to the question itself answers it
  if (m.awaiting && !clarify) await sql`update cb.telegram_messages set awaiting = null where question_id = ${m.question_id}`;
  const r = clarify ? await act(m.question_id, m.asked, 'send_back', { reason: 'clarify', note: text })
    : await act(m.question_id, m.asked, 'answer', { answer: m.multi && m.picked.length ? `${m.picked.join('; ')} — ${text}` : text });
  if (r) return say(chat, r, { reply_parameters: { message_id: msg.message_id } });
}

export async function handle(u: any) {
  const msg = u.message, cb = u.callback_query;
  const chat: number | undefined = msg?.chat?.id ?? cb?.message?.chat?.id;
  if (!chat) return;
  // Pairing: the only thing an unpaired chat can do, and only a private chat (not a group others can type in).
  const start = /^\/start\s+(\S+)$/.exec(msg?.text ?? '');
  if (start && msg.chat.type === 'private' && code && code.value === start[1]) {
    const valid = Date.now() < code.until;
    code = null; // one-time, used or expired
    if (valid) {
      await sql`insert into cb.settings (key, value) values ('telegram_chat', ${sql.json({ chat_id: chat, paired_at: new Date().toISOString() })})
                on conflict (key) do update set value = excluded.value`;
      await sql`delete from cb.telegram_messages where chat_id <> ${chat}`;
      await sql`select pg_notify('cb', 'settings')`; // the dashboard flips to connected
      await say(chat, 'Paired. Questions waiting on you come here; tap an option or reply to answer.');
      forget(); // what the old chat refused, this one may take
      await reconcile();
      return;
    }
  }
  if (chat !== (await pairedChat())) return; // every other chat: ignored, silently
  // a 403 (the bot blocked) ends when Ahmed starts the bot again, and his chat writes in: try those again (#4629)
  let unblocked = false;
  for (const [k, t] of tries) if (t.refused === 403) { tries.delete(k); unblocked = true; }
  if (unblocked) void reconcile();
  if (cb) return onButton(cb, chat);
  if (typeof msg?.text === 'string') return onText(msg, chat);
}

async function poll() {
  let offset = 0, wait = 1000;
  while (!stop!.signal.aborted) {
    try {
      if (!bot) { bot = (await tg('getMe')).username; await reconcile(); } // questions opened while the server was down
      const ups = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      wait = 1000;
      for (const u of ups) {
        offset = u.update_id + 1; // not persisted: a restart may see a few again, and act() refuses a second answer
        await handle(u).catch((e) => console.error(`telegram: update ${u.update_id}: ${e.message}`));
      }
    } catch (e: any) {
      if (stop!.signal.aborted) break;
      console.error(`telegram: ${e.message}; retrying in ${wait / 1000}s`);
      await sleep(wait);
      wait = Math.min(wait * 2, 30_000);
    }
  }
}

/** Runs the bot until stopTelegram(). Never throws: network trouble backs off and retries. */
export function startTelegram(o: { token: string; api: string }) {
  cfg = { token: o.token, api: o.api.replace(/\/$/, '') };
  stop = new AbortController();
  loop = poll();
}
export async function stopTelegram() {
  stop?.abort();
  clearRetry();
  await loop;
  await running;
  clearRetry(); // a pass that was running when stop came may have set one
  cfg = null; bot = null; loop = null; failWait = RETRY_MIN; forget();
}

// The dashboard's side (server/main.ts routes, page-only).
export async function telegramStatus() {
  const [s] = await sql`select value from cb.settings where key = 'telegram_chat'`;
  // #4629: what did not reach Telegram, for the dashboard's card (the server log has the detail)
  let refused = 0, unrecorded = 0;
  for (const t of tries.values()) if (t.refused) refused++; else if (t.sent !== undefined) unrecorded++;
  return { configured: !!cfg, bot, paired: !!s, paired_at: s?.value?.paired_at ?? null, refused, unrecorded };
}
export function telegramConnect() {
  if (!cfg || !bot) throw new Error(cfg ? 'the bot has not reached Telegram yet: try again in a minute' : 'TELEGRAM_BOT_TOKEN is not set');
  code = { value: randomBytes(12).toString('base64url'), until: Date.now() + 10 * 60_000 };
  return { link: `https://t.me/${bot}?start=${code.value}`, expires_at: new Date(code.until).toISOString() };
}
export async function telegramDisconnect() {
  code = null; forget();
  await sql`delete from cb.settings where key = 'telegram_chat'`;
  await sql`delete from cb.telegram_messages`;
  await sql`select pg_notify('cb', 'settings')`;
}
