CREATE TABLE portfolio_sessions (
  token_hash TEXT PRIMARY KEY,
  auth_version TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX portfolio_session_expiry ON portfolio_sessions(expires_at);
CREATE TABLE portfolio_login_limit (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE TABLE portfolio_funds (
  fund_code TEXT PRIMARY KEY,
  history_complete INTEGER NOT NULL CHECK (history_complete IN (0,1))
);
CREATE TABLE portfolio_transactions (
  id TEXT PRIMARY KEY,
  document TEXT NOT NULL CHECK (json_valid(document)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE portfolio_audit (
  id INTEGER PRIMARY KEY,
  transaction_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('create','edit','delete','restore')),
  revision INTEGER,
  occurred_at TEXT NOT NULL,
  before_doc TEXT,
  after_doc TEXT
);
CREATE INDEX portfolio_audit_transaction ON portfolio_audit(transaction_id,id);
CREATE TABLE portfolio_restore_guard (id INTEGER NOT NULL CHECK (id = 1));

CREATE TRIGGER portfolio_audit_insert AFTER INSERT ON portfolio_transactions
WHEN NOT EXISTS (SELECT 1 FROM portfolio_restore_guard)
BEGIN
  INSERT INTO portfolio_audit(transaction_id,action,revision,occurred_at,after_doc)
  VALUES(NEW.id,'create',NEW.revision,NEW.updated_at,NEW.document);
END;
CREATE TRIGGER portfolio_audit_update AFTER UPDATE ON portfolio_transactions
WHEN NOT EXISTS (SELECT 1 FROM portfolio_restore_guard)
BEGIN
  INSERT INTO portfolio_audit(transaction_id,action,revision,occurred_at,before_doc,after_doc)
  VALUES(NEW.id,CASE WHEN NEW.deleted_at IS NULL THEN 'edit' ELSE 'delete' END,
    NEW.revision,NEW.updated_at,OLD.document,CASE WHEN NEW.deleted_at IS NULL THEN NEW.document END);
END;
