const CHUNK_BYTES = 450_000;
const MAX_CHUNKS = 12;
const MAX_JSON_BYTES = 20_000_000;
const LEASE_MS = 45_000;
export const RETENTION_MS = 7 * 86_400_000;

async function transform(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function createRecord(snapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  if (bytes.length > MAX_JSON_BYTES) throw new Error("快照超出原始数据大小限制。");
  const gzip = await transform(bytes, new CompressionStream("gzip"));
  const chunks = [];
  for (let offset = 0; offset < gzip.length; offset += CHUNK_BYTES) {
    chunks.push(gzip.slice(offset, offset + CHUNK_BYTES).buffer);
  }
  if (chunks.length > MAX_CHUNKS) throw new Error("快照超出压缩存储大小限制。");
  return {bytes:bytes.length, compressed_bytes:gzip.length, chunks};
}

export function snapshotStore(binding) {
  if (!binding?.prepare) throw new Error("快照存储未配置。");
  // Use primary for every independent request. No replica can lag behind an ID
  // that another isolate just returned after its publish transaction committed.
  const db = binding.withSession?.("first-primary") ?? binding;
  const statement = (sql, ...args) => db.prepare(sql).bind(...args);

  async function load(head) {
    if (!head) return null;
    const {results} = await statement(
      "SELECT part, body FROM analysis_snapshot_chunks WHERE id=? ORDER BY part", head.id
    ).all();
    if (results.length !== head.chunks || results.some((row, i) => row.part !== i)) {
      throw new Error("快照存储不完整。");
    }
    const blobs = results.map(({body})=>new Uint8Array(body));
    const size = blobs.reduce((sum, part)=>sum+part.length, 0);
    if (!size || size > CHUNK_BYTES * MAX_CHUNKS) throw new Error("快照存储大小无效。");
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const part of blobs) {
      joined.set(part, offset);
      offset += part.length;
    }
    const decoded = await transform(joined, new DecompressionStream("gzip"));
    if (decoded.length > MAX_JSON_BYTES) throw new Error("快照解析超出大小限制。");
    const snapshot = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(decoded));
    if (snapshot.schema_version !== 1 || snapshot.snapshot_id !== head.id ||
        snapshot.symbol !== head.symbol || snapshot.asset_type !== head.asset_type) {
      throw new Error("快照版本或标的校验失败。");
    }
    return snapshot;
  }

  return {
    latest:(key, now)=>statement(
      "SELECT * FROM analysis_snapshots WHERE cache_key=? AND expires_at>? ORDER BY created_at DESC,rowid DESC LIMIT 1", key, now
    ).first().then(load),
    header:(id)=>statement("SELECT * FROM analysis_snapshots WHERE id=?", id).first(),
    load,
    async lease(key, now) {
      const token = crypto.randomUUID();
      const entry = await statement(`
        INSERT INTO analysis_snapshot_leases(cache_key,token,expires_at) VALUES(?,?,?)
        ON CONFLICT(cache_key) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at,failure=NULL
        WHERE analysis_snapshot_leases.expires_at<=?
        RETURNING token`, key, token, now+LEASE_MS, now).first();
      return entry?.token ?? null;
    },
    release:(key, token)=>statement(
      "DELETE FROM analysis_snapshot_leases WHERE cache_key=? AND token=?", key, token
    ).run(),
    failure:(key, now)=>statement(
      "SELECT failure FROM analysis_snapshot_leases WHERE cache_key=? AND expires_at>?",key,now
    ).first().then((row)=>row?.failure??null),
    cooldown:(key, token, now)=>statement(
      "UPDATE analysis_snapshot_leases SET token='', failure='data_unavailable', expires_at=? WHERE cache_key=? AND token=?",
      now+15_000,key,token
    ).run(),
    async publish(key, token, snapshot, record, now) {
      const expires = Date.parse(snapshot.expires_at);
      const {snapshot_id:id, asset_type:type, symbol} = snapshot;
      const results = await db.batch([
        statement(`INSERT INTO analysis_snapshots
          SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (
            SELECT 1 FROM analysis_snapshot_leases WHERE cache_key=? AND token=? AND expires_at>?
          )`, id,key,type,symbol,now,expires,expires+RETENTION_MS,record.chunks.length,key,token,now),
        ...record.chunks.map((body,part)=>statement(
          "INSERT INTO analysis_snapshot_chunks SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM analysis_snapshots WHERE id=?)",
          id,part,body,id
        )),
        statement("DELETE FROM analysis_snapshot_leases WHERE cache_key=? AND token=?",key,token),
        statement("DELETE FROM analysis_snapshots WHERE id IN (SELECT id FROM analysis_snapshots WHERE purge_at<=? LIMIT 8)",now),
        statement("DELETE FROM analysis_snapshot_leases WHERE cache_key IN (SELECT cache_key FROM analysis_snapshot_leases WHERE expires_at<=? LIMIT 8)",now),
      ]);
      if (results[0]?.meta?.changes !== 1) throw new Error("快照构建已失去写入锁。");
    },
  };
}
