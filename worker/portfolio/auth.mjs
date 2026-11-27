const cookieName = "__Host-fund-portfolio";
const iterations = 600_000;
const lifetime = 8 * 60 * 60;
const windowSeconds = 15 * 60;
const attemptsPerWindow = 8;
const encoder = new TextEncoder();

function toBase64(array) {
  return btoa(String.fromCharCode(...new Uint8Array(array))).replaceAll("+","-").replaceAll("/","_").replace(/=+$/, "");
}
function fromBase64(value) {
  return Uint8Array.from(atob(value.replaceAll("-","+").replaceAll("_","/")), (c)=>c.charCodeAt(0));
}
const digest = async (value) => toBase64(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

function equal(a,b) {
  let mismatched = a.length ^ b.length;
  for (let i=0; i<a.length; i++) mismatched |= a.charCodeAt(i) ^ (b.charCodeAt(i)||0);
  return mismatched === 0;
}

async function derive(password,salt) {
  const key = await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);
  return toBase64(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations},key,256));
}

export async function passwordVerifier(password) {
  if (typeof password !== "string" || password.length < 16 || encoder.encode(password).length > 256)
    throw new Error("管理员密码至少 16 个字符，UTF-8 编码最多 256 字节。");
  const salt = crypto.getRandomValues(new Uint8Array(24));
  return ["pbkdf2-sha256", iterations, toBase64(salt), await derive(password,salt)].join("$");
}

function configuration(env) {
  const name = env.PORTFOLIO_ADMIN_USER, verifier = env.PORTFOLIO_ADMIN_HASH;
  const match = /^pbkdf2-sha256\$600000\$([A-Za-z0-9_-]{32})\$([A-Za-z0-9_-]{43})$/.exec(verifier??"");
  if (typeof name !== "string" || !name || name.length > 100 || !match) return null;
  return {name, verifier, salt:fromBase64(match[1]), hash:match[2]};
}

function cookie(value,maxAge) {
  return `${cookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function token(request) {
  const match = (request.headers.get("Cookie")??"").match(/(?:^|;\s*)__Host-fund-portfolio=([A-Za-z0-9_-]{43})(?:;|$)/);
  return match?.[1] ?? null;
}

export async function authenticate(request,env,now) {
  const config = configuration(env), value = token(request);
  if (!config || !value) return null;
  const [tokenHash,version] = await Promise.all([digest(value),digest(JSON.stringify([config.name,config.verifier]))]);
  const row = await env.PORTFOLIO_DB.prepare(
    "SELECT 1 FROM portfolio_sessions WHERE token_hash=? AND auth_version=? AND expires_at>?"
  ).bind(tokenHash,version,now).first();
  return row ? tokenHash : null;
}

export async function login(input,env,now) {
  const config = configuration(env);
  if (!config) return {status:503,error:"not_configured"};
  const allowed = await env.PORTFOLIO_DB.prepare(`
    INSERT INTO portfolio_login_limit(id,window,attempts) VALUES(1,?,1)
    ON CONFLICT(id) DO UPDATE SET window=excluded.window,
      attempts=CASE WHEN portfolio_login_limit.window=excluded.window THEN attempts+1 ELSE 1 END
    WHERE portfolio_login_limit.window<excluded.window OR attempts<?
    RETURNING id`
  ).bind(Math.floor(now/windowSeconds), attemptsPerWindow).first();
  if (!allowed) return {status:429,error:"login_limited",retry:windowSeconds-now%windowSeconds};
  if (typeof input.username !== "string" || input.username.length > 100 ||
      typeof input.password !== "string" || encoder.encode(input.password).length > 256)
    return {status:401,error:"invalid_credentials"};
  const [candidate,name,expectedName] = await Promise.all([
    derive(input.password,config.salt),digest(input.username),digest(config.name),
  ]);
  if (!(equal(candidate,config.hash) & equal(name,expectedName))) return {status:401,error:"invalid_credentials"};
  const value = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  const [hash,version] = await Promise.all([digest(value),digest(JSON.stringify([config.name,config.verifier]))]);
  await env.PORTFOLIO_DB.batch([
    env.PORTFOLIO_DB.prepare("DELETE FROM portfolio_sessions WHERE expires_at<=?").bind(now),
    env.PORTFOLIO_DB.prepare("INSERT INTO portfolio_sessions VALUES (?,?,?)").bind(hash,version,now+lifetime),
  ]);
  return {status:200,cookie:cookie(value,lifetime)};
}

export async function logout(hash,db) {
  await db.prepare("DELETE FROM portfolio_sessions WHERE token_hash=?").bind(hash).run();
  return cookie("",0);
}
