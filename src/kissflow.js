// Thin Kissflow REST client. All calls use the account's admin access key (same
// credentials as the Kissflow app build itself — set these as environment variables
// on whatever host you deploy this to; never commit them to source control).

const DOMAIN = process.env.KF_DOMAIN;
const ACCOUNT_ID = process.env.KF_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.KF_ACCESS_KEY_ID;
const ACCESS_KEY_SECRET = process.env.KF_ACCESS_KEY_SECRET;
const APP_ID = process.env.KF_APP_ID || "FMCG_POS_Bank_Reconciliation_A00";

if (!DOMAIN || !ACCOUNT_ID || !ACCESS_KEY_ID || !ACCESS_KEY_SECRET) {
  throw new Error("Missing KF_DOMAIN / KF_ACCOUNT_ID / KF_ACCESS_KEY_ID / KF_ACCESS_KEY_SECRET env vars");
}

const BASE = `https://${DOMAIN}`;
const headers = {
  "X-Access-Key-Id": ACCESS_KEY_ID,
  "X-Access-Key-Secret": ACCESS_KEY_SECRET,
  "Content-Type": "application/json",
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Transient infrastructure errors (gateway/proxy hiccups, not our request being wrong) —
// retried with backoff. Everything else (4xx, a real 500 FormError, etc.) fails immediately,
// since retrying a bad request just repeats the same failure.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 4;

/**
 * A single 502 killed an entire ~8,000-record run outright — verified live, 2026-08-27: a
 * real Kissflow 502 Bad Gateway (their infra, an HTML Cloudflare-style error page, not a
 * response to anything wrong with our request) hit partway through, and since nothing
 * retried, the whole run's remaining work was lost with no way to resume mid-run. At this
 * call volume, hitting at least one transient blip is close to inevitable, so transient
 * statuses now retry with exponential backoff (500ms, 1s, 2s, 4s) before giving up.
 */
async function call(method, path, body) {
  let attempt = 0;
  for (;;) {
    let res, text;
    try {
      res = await fetch(BASE + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      text = await res.text();
    } catch (networkErr) {
      // A network-level failure (fetch itself threw — DNS blip, connection reset, etc.)
      // is just as transient as a 502; retry it the same way.
      if (attempt < MAX_RETRIES) { attempt++; await sleep(500 * 2 ** (attempt - 1)); continue; }
      throw new Error(`Kissflow ${method} ${path} -> network error after ${MAX_RETRIES} retries: ${networkErr.message}`);
    }
    if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      attempt++;
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (res.status >= 300) {
      throw new Error(`Kissflow ${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
    }
    return json;
  }
}

// --- Form CRUD -------------------------------------------------------------

/**
 * Create one item in a Form-type flow. `fields` is {fieldId: value}.
 *
 * Two real API calls, not one — a Form's plain `POST` only ever creates/overwrites a
 * DRAFT (response comes back with `_id: "draft_<userId>"` and `_is_draft: true` — the
 * SAME draft slot every time, per user, regardless of flow). It must be finalized with a
 * second call, `POST {flowId}/{draft_id}/submit`, which is what actually returns a real,
 * distinct, persisted record id. Skipping this step doesn't error — it just silently
 * overwrites the same one draft record on every call, so e.g. bulk-creating 80 stores in
 * a loop produced exactly one leftover record. Verified live, 2026-08-27, after a bulk
 * import appeared to "succeed" (each call returned 200) but only one record existed
 * afterward. Process items do NOT have this problem — their `POST` returns a real,
 * unique `InstanceId` directly, confirmed throughout this whole build.
 */
export async function createFormItem(flowId, fields) {
  const draft = await call("POST", `/form/2/${ACCOUNT_ID}/${flowId}?_application_id=${APP_ID}`, fields);
  const draftId = draft._id;
  if (!draftId) throw new Error(`createFormItem ${flowId}: draft response had no _id: ${JSON.stringify(draft).slice(0, 300)}`);
  return call("POST", `/form/2/${ACCOUNT_ID}/${flowId}/${draftId}/submit?_application_id=${APP_ID}`, {});
}

/** Create one item in a Process flow (raises it at the Start step). */
export async function createProcessItem(flowId, fields) {
  return call("POST", `/process/2/${ACCOUNT_ID}/${flowId}?_application_id=${APP_ID}`, fields);
}

/** Update one item in a Form-type flow. */
export async function updateFormItem(flowId, itemId, fields) {
  return call("PATCH", `/form/2/${ACCOUNT_ID}/${flowId}/${itemId}?_application_id=${APP_ID}`, fields);
}

/**
 * Update one item in a Process flow's own business fields (not a workflow step action).
 * Uses the "(Admin)" endpoint — the only one that can read/write a Process item's actual
 * field values; the plain (non-admin) process endpoints only ever expose workflow
 * metadata (status/step/assignee), never business data. Requires the access key's user
 * to have Process Admin rights on this flow (the account admin key used throughout this
 * build already qualifies — verified live, 2026-08-26).
 */
export async function updateProcessItem(flowId, itemId, fields) {
  return call("PUT", `/process/2/${ACCOUNT_ID}/admin/${flowId}/${itemId}`, fields);
}

/**
 * List items in a Form-type flow, with optional sort. See Kissflow REST docs for filter
 * shape (though `Filter` is unusable — see loadCarryForwardState()'s note in reconcile.js).
 * For Process-type flows use listProcessItems() instead — the shapes and even the HTTP
 * method differ (GET+query-params vs. POST+body), because Process listing only works at
 * all through the "(Admin)" endpoint (see updateProcessItem's note).
 *
 * Pagination gotcha (verified live, 2026-08-27): the page-size query param is
 * `page_size`/`page_number` (snake_case), NOT `pageSize`/`pageNumber` — the camelCase
 * form is silently ignored rather than rejected, capping every list at the server's
 * default page size (10) regardless of what's passed. This went unnoticed for an entire
 * session because a 10-row page still looks like a plausible success — it only surfaced
 * once a real table held more than 10 rows and a dedup-by-existing-records check (in
 * import-masters.mjs) silently mis-detected records as new that had actually already been
 * created, causing duplicate creates on every re-run. Fixed by using the correct param
 * name AND looping pages defensively (belt-and-braces — 1000 comfortably covers every
 * table in this app today, but a table that ever grows past one page should not silently
 * go back to returning only page 1).
 */
export async function listItems(flowId, { filter, sortBy, pageSize = 1000 } = {}) {
  const all = [];
  let pageNumber = 1;
  let meta = null;
  for (;;) {
    const q = new URLSearchParams({
      _application_id: APP_ID, _response_type: "full",
      page_size: String(pageSize), page_number: String(pageNumber),
    });
    if (sortBy) q.set("sortBy", sortBy);
    const body = filter ? { Filter: filter } : {};
    const res = await call("POST", `/form/2/${ACCOUNT_ID}/${flowId}/list?${q}`, body);
    meta = res;
    const page = res?.Data || [];
    all.push(...page);
    if (page.length < pageSize || all.length >= (res?.count ?? all.length)) break;
    pageNumber++;
  }
  return { ...meta, Data: all };
}

/** List items in a Process-type flow, with full business field values (Admin endpoint). */
export async function listProcessItems(flowId, { pageNumber = 1, pageSize = 100 } = {}) {
  const q = new URLSearchParams({ page_number: String(pageNumber), page_size: String(pageSize), apply_preference: "false" });
  return call("GET", `/process/2/${ACCOUNT_ID}/admin/${flowId}/item?${q}`);
}

/** Fetch one item by id from a Form-type flow. */
export async function getItem(flowId, itemId) {
  return call("GET", `/form/2/${ACCOUNT_ID}/${flowId}/${itemId}?_application_id=${APP_ID}`);
}

/** Fetch one item by id from a Process-type flow, with full business field values (Admin endpoint). */
export async function getProcessItem(flowId, itemId) {
  return call("GET", `/process/2/${ACCOUNT_ID}/admin/${flowId}/${itemId}`);
}

// --- File download -----------------------------------------------------------

/**
 * Download one attachment from a Process form field (Admin endpoint — the only one that
 * works for a Process; there is no plain "Preview_URL" on the field value the way there
 * might be for a Form). The endpoint 302-redirects to a signed, time-limited storage URL;
 * `fetch` follows redirects by default, so this just works as a single call. Verified live,
 * 2026-08-27: downloaded a real 4.4MB attachment, byte-for-byte correct.
 *
 * `field` is one entry from a Process item's Attachment-type field array, i.e.
 * `run.bank_statement_file[0]` — needs its `id` (the attachment id) plus knowledge of
 * which field it came from (fieldId), the flow, and the item.
 */
export async function downloadProcessAttachment(flowId, instanceId, fieldId, attachmentId) {
  const res = await fetch(`${BASE}/process/2/${ACCOUNT_ID}/admin/${flowId}/${instanceId}/${fieldId}/attachment/${attachmentId}`,
    { headers: { "X-Access-Key-Id": ACCESS_KEY_ID, "X-Access-Key-Secret": ACCESS_KEY_SECRET } });
  if (res.status >= 300) throw new Error(`downloadProcessAttachment ${flowId}/${instanceId}/${fieldId}/${attachmentId} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Wrap a plain record id for a Reference field's payload shape. A bare string id on a
 * Reference field silently 500s on create ("An unexpected error has occurred") with no
 * indication the field is the cause — verified live, 2026-08-27, by reproducing the exact
 * same generic FormError with a minimal payload, then bisecting field-by-field until
 * dropping the Reference field alone made it succeed. The API wants `{_id: "..."}` instead;
 * reads already come back in this same `{_id, Name, ...}` shape everywhere in this app
 * (e.g. `run.bank`, `item.store` on a Reconciliation Line), so this just mirrors that on
 * the way out. Pass through undefined/null so optional references stay omittable.
 */
export function ref(id) {
  return id == null ? id : { _id: id };
}

export const ids = { ACCOUNT_ID, APP_ID };
