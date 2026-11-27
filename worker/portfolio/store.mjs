import { normalizeTransaction } from "./ledger.mjs";

export const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const maximumRecords = 2_000;
const maxAuditRecords = 20_000;
const txQuery = "SELECT * FROM portfolio_transactions";
const settingsQuery = "SELECT fund_code,history_complete FROM portfolio_funds ORDER BY fund_code";
const auditQuery = "SELECT * FROM portfolio_audit";
const transactionRow = ({document,...row}) => ({...row,...JSON.parse(document)});
const settingsRow = ({fund_code,history_complete}) => ({fund_code,history_complete:history_complete===1});
const auditRow = ({before_doc,after_doc,...row}) => ({...row,before:JSON.parse(before_doc),after:JSON.parse(after_doc)});

export async function readLedger(db) {
  const [records,settings] = await db.batch([
    db.prepare(txQuery+" WHERE deleted_at IS NULL ORDER BY created_at,id"), db.prepare(settingsQuery),
  ]);
  return {records:records.results.map(transactionRow),settings:settings.results.map(settingsRow)};
}

export async function createTransaction(db,input,timestamp) {
  const document = normalizeTransaction(input);
  const id = crypto.randomUUID();
  const row = await db.prepare(`INSERT INTO portfolio_transactions(id,document,revision,created_at,updated_at)
    SELECT ?,?,1,?,? WHERE (SELECT COUNT(*) FROM portfolio_transactions)<? RETURNING *`
  ).bind(id,JSON.stringify(document),timestamp,timestamp,maximumRecords).first();
  return row ? transactionRow(row) : null;
}

export async function changeTransaction(db,id,input,revision,timestamp) {
  const statement = input === null
    ? db.prepare(`UPDATE portfolio_transactions SET revision=revision+1,updated_at=?,deleted_at=?
      WHERE id=? AND revision=? AND deleted_at IS NULL RETURNING *`).bind(timestamp,timestamp,id,revision)
    : db.prepare(`UPDATE portfolio_transactions SET revision=revision+1,updated_at=?,document=?
      WHERE id=? AND revision=? AND deleted_at IS NULL RETURNING *`).bind(timestamp,JSON.stringify(normalizeTransaction(input)),id,revision);
  const row = await statement.first();
  return row ? transactionRow(row) : null;
}

export async function saveSetting(db,code,complete) {
  const row = await db.prepare(`INSERT INTO portfolio_funds VALUES(?,?)
    ON CONFLICT(fund_code) DO UPDATE SET history_complete=excluded.history_complete RETURNING *`
  ).bind(code,Number(complete)).first();
  return settingsRow(row);
}

export async function auditFor(db,id) {
  const {results} = await db.prepare(auditQuery+" WHERE transaction_id=? ORDER BY id").bind(id).all();
  return results.map(auditRow);
}

export async function backupLedger(db,timestamp) {
  const [records,settings,audit] = await db.batch([
    db.prepare(txQuery+" ORDER BY created_at,id"),db.prepare(settingsQuery),db.prepare(auditQuery+" ORDER BY id"),
  ]);
  return {format:"sdc-personal-portfolio", version:1, exported_at:timestamp,
    transactions:records.results.map(transactionRow), funds:settings.results.map(settingsRow), audit:audit.results.map(auditRow)};
}

function validTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
}
function checkedId(id) {
  if (typeof id !== "string" || !uuid.test(id)) throw new Error("备份包含无效交易编号。");
  return id;
}
function checkedRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1_000_000) throw new Error("备份包含无效记录版本。");
  return revision;
}

function imports(backup) {
  if (backup?.format !== "sdc-personal-portfolio" || backup.version !== 1 ||
      !Array.isArray(backup.transactions) || backup.transactions.length > maximumRecords ||
      !Array.isArray(backup.funds) || backup.funds.length > maximumRecords ||
      !Array.isArray(backup.audit) || backup.audit.length > maxAuditRecords)
    throw new Error("备份格式或记录数量不受支持。");
  const ids = new Set();
  const transactions = backup.transactions.map((row)=>{
    const id = checkedId(row?.id);
    if (ids.has(id) || !validTimestamp(row.created_at) || !validTimestamp(row.updated_at) ||
      row.updated_at < row.created_at || (row.deleted_at !== null && row.deleted_at !== row.updated_at))
      throw new Error("备份包含重复交易或无效时间。");
    ids.add(id);
    return {id, revision:checkedRevision(row.revision), created_at:row.created_at,updated_at:row.updated_at,
      deleted_at:row.deleted_at,document:normalizeTransaction(row)};
  });
  const codes = new Set();
  const funds = backup.funds.map((row)=>{
    if (!/^\d{6}$/.test(row?.fund_code??"") || typeof row.fund_code!=="string" ||
      typeof row.history_complete!=="boolean" || codes.has(row.fund_code)) throw new Error("备份基金设置无效。");
    codes.add(row.fund_code);
    return {fund_code:row.fund_code,history_complete:Number(row.history_complete)};
  });
  const logIds = new Set();
  const audit = backup.audit.map((row)=>{
    if (!Number.isSafeInteger(row?.id) || row.id < 1 || logIds.has(row.id) ||
      !["create","edit","delete","restore"].includes(row.action) || !validTimestamp(row.occurred_at) ||
      (row.action === "restore" ? row.transaction_id !== null || row.revision !== null :
        !ids.has(checkedId(row.transaction_id)) || !checkedRevision(row.revision)))
      throw new Error("备份审计记录无效。");
    if ((row.action === "create" && (!!row.before || !row.after)) ||
        (row.action === "edit" && (!row.before || !row.after)) ||
        (row.action === "delete" && (!row.before || !!row.after)) ||
        (row.action === "restore" && (!!row.before || !!row.after))) throw new Error("备份审计内容无效。");
    logIds.add(row.id);
    return {id:row.id,transaction_id:row.transaction_id,action:row.action,revision:row.revision,occurred_at:row.occurred_at,
      before:row.before ? normalizeTransaction(row.before) : null, after:row.after ? normalizeTransaction(row.after) : null};
  });
  const latestAudit = new Map();
  for (const entry of audit) if (entry.transaction_id && (latestAudit.get(entry.transaction_id)?.id??0) < entry.id)
    latestAudit.set(entry.transaction_id,entry);
  for (const row of transactions) {
    const last=latestAudit.get(row.id);
    if (!last || last.revision!==row.revision || last.occurred_at!==row.updated_at ||
        (row.deleted_at ? last.action!=="delete" : last.action==="delete") ||
        JSON.stringify(last.after??last.before)!==JSON.stringify(row.document))
      throw new Error("备份交易与审计末次记录不一致。");
  }
  return {transactions,funds,audit};
}

function statements(db,query,rows) {
  const result = [];
  // Small bound JSON arrays support restoration without one statement per row.
  for (let i=0;i<rows.length;i+=125) result.push(db.prepare(query).bind(JSON.stringify(rows.slice(i,i+125))));
  return result;
}

export async function restoreLedger(db,backup,timestamp) {
  const {transactions,funds,audit} = imports(backup);
  const queries = [
    db.prepare(`INSERT INTO portfolio_restore_guard VALUES(CASE WHEN EXISTS(SELECT 1 FROM portfolio_transactions)
      OR EXISTS(SELECT 1 FROM portfolio_funds) OR EXISTS(SELECT 1 FROM portfolio_audit) THEN 0 ELSE 1 END)`),
    ...statements(db,`INSERT INTO portfolio_transactions SELECT
      value->>'id',value->'document',value->>'revision',value->>'created_at',value->>'updated_at',value->>'deleted_at' FROM json_each(?)`,transactions),
    ...statements(db,`INSERT INTO portfolio_funds SELECT value->>'fund_code',value->>'history_complete' FROM json_each(?)`,funds),
    ...statements(db,`INSERT INTO portfolio_audit SELECT value->>'id',value->>'transaction_id',value->>'action',
      value->>'revision',value->>'occurred_at',NULLIF(value->'before','null'),NULLIF(value->'after','null') FROM json_each(?)`,audit),
    db.prepare("INSERT INTO portfolio_audit(action,occurred_at) VALUES('restore',?)").bind(timestamp),
    db.prepare("DELETE FROM portfolio_restore_guard"),
  ];
  try { await db.batch(queries); }
  catch (error) {
    if (String(error.message).includes("CHECK constraint failed: id = 1")) return false;
    throw error;
  }
  return true;
}
