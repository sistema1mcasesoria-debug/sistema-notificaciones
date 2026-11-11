export type LoginMode = 'RUC' | 'DNI';

export type CheckStatus = 'OK' | 'AUTH_ERROR' | 'CAPTCHA' | 'SESSION_ACTIVE' | 'ERROR';

export type MailboxSource = 'NOTIFICACIONES' | 'MENSAJES';

export interface ClientCredentials {
  clientId: number;
  label: string;
  loginMode: LoginMode;
  docNumber: string;
  solUser: string;
  solPassword: string;
}

export interface SunatNotificationItem {
  sunatCode: string | null;
  subject: string;
  sender: string | null;
  notificationType: string | null;
  mailboxSource?: MailboxSource;
  publishedAt: string | null;
  readStatusSunat: string | null;
  rawRow: Record<string, string>;
}

export interface ScrapeResult {
  status: CheckStatus;
  notifications: SunatNotificationItem[];
  message?: string;
  debugScreenshotPath?: string;
}

export interface DownloadAttachmentTarget {
  id?: number;
  subject: string;
  sunatCode: string | null;
  publishedAt: string | null;
  notificationType: string | null;
  mailboxSource?: MailboxSource;
}

export interface AttachmentDownloadResult {
  found: boolean;
  filename?: string;
  filePath?: string;
  message?: string;
}
