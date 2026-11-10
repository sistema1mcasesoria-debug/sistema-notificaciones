import { DatabaseSync } from 'node:sqlite';
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
  sha256Hex,
} from '../security/crypto.js';
import type {
  CheckStatus,
  ClientCredentials,
  LoginMode,
  SunatNotificationItem,
} from '../scraper/types.js';

export interface ClientSummary {
  id: number;
  label: string;
  loginMode: LoginMode;
  docNumber: string;
  solUserMasked: string;
  active: boolean;
  lastCheckedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  unreadAlertsCount: number;
}

export interface StoredNotification {
  id: number;
  clientId: number;
  clientLabel: string;
  docNumber: string;
  sunatCode: string | null;
  subject: string;
  sender: string | null;
  notificationType: string | null;
  publishedAt: string | null;
  readStatusSunat: string | null;
  isNewAlert: boolean;
  firstSeenAt: string;
  rawRow: Record<string, string>;
  attachmentPath: string | null;
  attachmentName: string | null;
}

export interface CheckRunSummary {
  id: number;
  clientId: number;
  clientLabel: string;
  docNumber: string;
  startedAt: string;
  finishedAt: string;
  status: string;
  totalFound: number;
  newFound: number;
  errorMessage: string | null;
}

export interface DashboardStats {
  totalClients: number;
  activeClients: number;
  unreadAlerts: number;
  errorClients: number;
  lastCheckedAt: string | null;
}

export class ClientService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly encryptionKey: string,
  ) {}

  addClient(input: {
    label: string;
    loginMode: LoginMode;
    docNumber: string;
    solUser?: string;
    solPassword: string;
  }): number {
    const label = input.label.trim();
    const docNumber = input.docNumber.trim();
    const solUser = (input.solUser ?? '').trim().toUpperCase();
    const solPassword = input.solPassword;

    if (!label) throw new Error('El nombre/etiqueta del cliente es obligatorio.');
    if (input.loginMode === 'RUC' && !/^\d{11}$/.test(docNumber)) {
      throw new Error('El RUC debe tener exactamente 11 digitos numericos.');
    }
    if (input.loginMode === 'DNI' && !/^\d{8}$/.test(docNumber)) {
      throw new Error('El DNI debe tener exactamente 8 digitos numericos.');
    }
    if (input.loginMode === 'RUC' && !solUser) {
      throw new Error('El usuario SOL es obligatorio cuando el ingreso es por RUC.');
    }
    if (!solPassword || solPassword.length < 4) {
      throw new Error('La Clave SOL es obligatoria.');
    }

    const solUserEnc = solUser ? encryptSecret(solUser, this.encryptionKey) : null;
    const solPasswordEnc = encryptSecret(solPassword, this.encryptionKey);

    const stmt = this.db.prepare(`
      INSERT INTO clients (label, login_mode, doc_number, sol_user_enc, sol_password_enc, active)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(login_mode, doc_number) DO UPDATE SET
        label = excluded.label,
        sol_user_enc = excluded.sol_user_enc,
        sol_password_enc = excluded.sol_password_enc,
        active = 1,
        updated_at = datetime('now', 'localtime')
    `);

    stmt.run(label, input.loginMode, docNumber, solUserEnc, solPasswordEnc);

    const row = this.db
      .prepare('SELECT id FROM clients WHERE login_mode = ? AND doc_number = ?')
      .get(input.loginMode, docNumber) as { id: number };

    return row.id;
  }

  listClients(): ClientSummary[] {
    const rows = this.db
      .prepare(`
        SELECT
          c.id,
          c.label,
          c.login_mode,
          c.doc_number,
          c.sol_user_enc,
          c.active,
          c.last_checked_at,
          c.last_status,
          c.last_error,
          (SELECT COUNT(*) FROM notifications n WHERE n.client_id = c.id AND n.is_new_alert = 1) AS unread_alerts
        FROM clients c
        ORDER BY c.id ASC
      `)
      .all() as Array<{
      id: number;
      label: string;
      login_mode: LoginMode;
      doc_number: string;
      sol_user_enc: string | null;
      active: number;
      last_checked_at: string | null;
      last_status: string | null;
      last_error: string | null;
      unread_alerts: number;
    }>;

    return rows.map((row) => {
      let maskedUser = '-';
      if (row.sol_user_enc) {
        try {
          maskedUser = maskSecret(decryptSecret(row.sol_user_enc, this.encryptionKey));
        } catch {
          maskedUser = '[ERROR LLAVE]';
        }
      }

      return {
        id: row.id,
        label: row.label,
        loginMode: row.login_mode,
        docNumber: row.doc_number,
        solUserMasked: maskedUser,
        active: row.active === 1,
        lastCheckedAt: row.last_checked_at,
        lastStatus: row.last_status,
        lastError: row.last_error,
        unreadAlertsCount: row.unread_alerts,
      };
    });
  }

  getActiveCredentials(clientId?: number): ClientCredentials[] {
    const query = clientId
      ? 'SELECT id, label, login_mode, doc_number, sol_user_enc, sol_password_enc FROM clients WHERE id = ?'
      : 'SELECT id, label, login_mode, doc_number, sol_user_enc, sol_password_enc FROM clients WHERE active = 1 ORDER BY id ASC';

    const rows = (clientId
      ? this.db.prepare(query).all(clientId)
      : this.db.prepare(query).all()) as Array<{
      id: number;
      label: string;
      login_mode: LoginMode;
      doc_number: string;
      sol_user_enc: string | null;
      sol_password_enc: string;
    }>;

    return rows.map((row) => ({
      clientId: row.id,
      label: row.label,
      loginMode: row.login_mode,
      docNumber: row.doc_number,
      solUser: row.sol_user_enc
        ? decryptSecret(row.sol_user_enc, this.encryptionKey)
        : '',
      solPassword: decryptSecret(row.sol_password_enc, this.encryptionKey),
    }));
  }

  toggleClient(id: number): boolean {
    const existing = this.db
      .prepare('SELECT active FROM clients WHERE id = ?')
      .get(id) as { active: number } | undefined;

    if (!existing) {
      throw new Error(`No existe un cliente con ID ${id}.`);
    }

    const nextActive = existing.active === 1 ? 0 : 1;
    this.db
      .prepare("UPDATE clients SET active = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
      .run(nextActive, id);

    return nextActive === 1;
  }

  removeClient(id: number): boolean {
    const result = this.db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    return result.changes > 0;
  }

  recordCheckResult(params: {
    clientId: number;
    startedAt: string;
    finishedAt: string;
    status: CheckStatus;
    notifications: SunatNotificationItem[];
    errorMessage?: string;
  }): { totalFound: number; newFound: number; newItems: SunatNotificationItem[] } {
    const { clientId, startedAt, finishedAt, status, notifications, errorMessage } = params;

    let newFound = 0;
    const newItems: SunatNotificationItem[] = [];

    const insertNotif = this.db.prepare(`
      INSERT OR IGNORE INTO notifications (
        client_id, external_hash, sunat_code, subject, sender,
        notification_type, published_at, read_status_sunat, is_new_alert, raw_row_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of notifications) {
      const fingerprintSource = [
        item.sunatCode ?? '',
        item.publishedAt ?? '',
        item.subject,
        item.sender ?? '',
        item.notificationType ?? '',
      ].join('|');

      const externalHash = sha256Hex(fingerprintSource);
      const initialIsNewAlert = item.readStatusSunat === 'Leído' ? 0 : 1;
      const res = insertNotif.run(
        clientId,
        externalHash,
        item.sunatCode,
        item.subject,
        item.sender,
        item.notificationType,
        item.publishedAt,
        item.readStatusSunat,
        initialIsNewAlert,
        JSON.stringify(item.rawRow),
      );

      if (res.changes > 0) {
        if (initialIsNewAlert === 1) {
          newFound++;
          newItems.push(item);
        }
      }
    }

    this.db
      .prepare(`
        UPDATE clients
        SET last_checked_at = ?,
            last_status = ?,
            last_error = ?,
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `)
      .run(finishedAt, status, errorMessage ?? null, clientId);

    this.db
      .prepare(`
        INSERT INTO check_runs (client_id, started_at, finished_at, status, total_found, new_found, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        clientId,
        startedAt,
        finishedAt,
        status,
        notifications.length,
        newFound,
        errorMessage ?? null,
      );

    return {
      totalFound: notifications.length,
      newFound,
      newItems,
    };
  }

  listNotifications(options?: {
    onlyNew?: boolean;
    clientId?: number;
    query?: string;
    limit?: number;
  }): StoredNotification[] {
    const onlyNew = options?.onlyNew ?? false;
    const clientId = options?.clientId;
    const query = options?.query?.trim() ?? '';
    const limit = options?.limit ?? 100;

    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (onlyNew) {
      conditions.push('n.is_new_alert = 1');
    }
    if (clientId && Number.isFinite(clientId)) {
      conditions.push('n.client_id = ?');
      params.push(clientId);
    }
    if (query) {
      conditions.push(
        '(n.subject LIKE ? OR COALESCE(n.sunat_code, \'\') LIKE ? OR COALESCE(n.sender, \'\') LIKE ? OR c.label LIKE ? OR c.doc_number LIKE ?)',
      );
      const pattern = `%${query}%`;
      params.push(pattern, pattern, pattern, pattern, pattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const rows = this.db
      .prepare(`
        SELECT
          n.id,
          n.client_id,
          c.label AS client_label,
          c.doc_number,
          n.sunat_code,
          n.subject,
          n.sender,
          n.notification_type,
          n.published_at,
          n.read_status_sunat,
          n.is_new_alert,
          n.raw_row_json,
          n.first_seen_at,
          n.attachment_path,
          n.attachment_name
        FROM notifications n
        INNER JOIN clients c ON c.id = n.client_id
        ${whereClause}
        ORDER BY n.is_new_alert DESC, n.first_seen_at DESC, n.id DESC
        LIMIT ?
      `)
      .all(...params) as Array<{
      id: number;
      client_id: number;
      client_label: string;
      doc_number: string;
      sunat_code: string | null;
      subject: string;
      sender: string | null;
      notification_type: string | null;
      published_at: string | null;
      read_status_sunat: string | null;
      is_new_alert: number;
      raw_row_json: string | null;
      first_seen_at: string;
      attachment_path: string | null;
      attachment_name: string | null;
    }>;

    return rows.map((r) => {
      let rawRow: Record<string, string> = {};
      if (r.raw_row_json) {
        try {
          rawRow = JSON.parse(r.raw_row_json) as Record<string, string>;
        } catch {
          rawRow = {};
        }
      }

      return {
        id: r.id,
        clientId: r.client_id,
        clientLabel: r.client_label,
        docNumber: r.doc_number,
        sunatCode: r.sunat_code,
        subject: r.subject,
        sender: r.sender,
        notificationType: r.notification_type,
        publishedAt: r.published_at,
        readStatusSunat: r.read_status_sunat,
        isNewAlert: r.is_new_alert === 1,
        firstSeenAt: r.first_seen_at,
        rawRow,
        attachmentPath: r.attachment_path || null,
        attachmentName: r.attachment_name || null,
      };
    });
  }

  markNotificationAsReviewed(id: number): boolean {
    const result = this.db
      .prepare('UPDATE notifications SET is_new_alert = 0 WHERE id = ? AND is_new_alert = 1')
      .run(id);
    return Number(result.changes) > 0;
  }

  saveNotificationAttachment(id: number, attachmentPath: string, attachmentName: string): boolean {
    const res = this.db
      .prepare('UPDATE notifications SET attachment_path = ?, attachment_name = ? WHERE id = ?')
      .run(attachmentPath, attachmentName, id);
    return Number(res.changes) > 0;
  }

  getNotificationById(id: number): StoredNotification | null {
    const row = this.db
      .prepare(`
        SELECT
          n.id,
          n.client_id,
          c.label AS client_label,
          c.doc_number,
          n.sunat_code,
          n.subject,
          n.sender,
          n.notification_type,
          n.published_at,
          n.read_status_sunat,
          n.is_new_alert,
          n.raw_row_json,
          n.first_seen_at,
          n.attachment_path,
          n.attachment_name
        FROM notifications n
        INNER JOIN clients c ON c.id = n.client_id
        WHERE n.id = ?
      `)
      .get(id) as
      | {
          id: number;
          client_id: number;
          client_label: string;
          doc_number: string;
          sunat_code: string | null;
          subject: string;
          sender: string | null;
          notification_type: string | null;
          published_at: string | null;
          read_status_sunat: string | null;
          is_new_alert: number;
          raw_row_json: string | null;
          first_seen_at: string;
          attachment_path: string | null;
          attachment_name: string | null;
        }
      | undefined;

    if (!row) return null;

    let rawRow: Record<string, string> = {};
    if (row.raw_row_json) {
      try {
        rawRow = JSON.parse(row.raw_row_json);
      } catch {
        rawRow = {};
      }
    }

    return {
      id: row.id,
      clientId: row.client_id,
      clientLabel: row.client_label,
      docNumber: row.doc_number,
      sunatCode: row.sunat_code,
      subject: row.subject,
      sender: row.sender,
      notificationType: row.notification_type,
      publishedAt: row.published_at,
      readStatusSunat: row.read_status_sunat,
      isNewAlert: row.is_new_alert === 1,
      firstSeenAt: row.first_seen_at,
      rawRow,
      attachmentPath: row.attachment_path || null,
      attachmentName: row.attachment_name || null,
    };
  }

  markNotificationAsReadSunat(id: number): boolean {
    const result = this.db
      .prepare(`
        UPDATE notifications
        SET read_status_sunat = 'Leído', is_new_alert = 0
        WHERE id = ?
      `)
      .run(id);
    return Number(result.changes) > 0;
  }

  markAllAlertsAsReviewed(clientId?: number): number {
    const result = clientId
      ? this.db
          .prepare('UPDATE notifications SET is_new_alert = 0 WHERE is_new_alert = 1 AND client_id = ?')
          .run(clientId)
      : this.db
          .prepare('UPDATE notifications SET is_new_alert = 0 WHERE is_new_alert = 1')
          .run();
    return Number(result.changes);
  }

  getDashboardStats(): DashboardStats {
    const row = this.db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM clients) AS total_clients,
          (SELECT COUNT(*) FROM clients WHERE active = 1) AS active_clients,
          (SELECT COUNT(*) FROM notifications WHERE is_new_alert = 1) AS unread_alerts,
          (SELECT COUNT(*) FROM clients WHERE active = 1 AND last_status IN ('AUTH_ERROR', 'CAPTCHA', 'SESSION_ACTIVE', 'ERROR')) AS error_clients,
          (SELECT MAX(last_checked_at) FROM clients) AS last_checked_at
      `)
      .get() as {
      total_clients: number;
      active_clients: number;
      unread_alerts: number;
      error_clients: number;
      last_checked_at: string | null;
    };

    return {
      totalClients: row.total_clients,
      activeClients: row.active_clients,
      unreadAlerts: row.unread_alerts,
      errorClients: row.error_clients,
      lastCheckedAt: row.last_checked_at,
    };
  }

  listCheckRuns(limit = 40): CheckRunSummary[] {
    const rows = this.db
      .prepare(`
        SELECT
          r.id,
          r.client_id,
          c.label AS client_label,
          c.doc_number,
          r.started_at,
          r.finished_at,
          r.status,
          r.total_found,
          r.new_found,
          r.error_message
        FROM check_runs r
        INNER JOIN clients c ON c.id = r.client_id
        ORDER BY r.id DESC
        LIMIT ?
      `)
      .all(limit) as Array<{
      id: number;
      client_id: number;
      client_label: string;
      doc_number: string;
      started_at: string;
      finished_at: string;
      status: string;
      total_found: number;
      new_found: number;
      error_message: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      clientLabel: r.client_label,
      docNumber: r.doc_number,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      totalFound: r.total_found,
      newFound: r.new_found,
      errorMessage: r.error_message,
    }));
  }
}
