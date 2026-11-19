export type LoginMode = 'RUC' | 'DNI';

export type CheckStatus = 'OK' | 'AUTH_ERROR' | 'CAPTCHA' | 'SESSION_ACTIVE' | 'ERROR';

export type PortalType = 'SUNAT' | 'SUNAFIL';

export type MailboxSource =
  | 'NOTIFICACIONES'
  | 'MENSAJES'
  | 'FISCALIZACION'
  | 'COBRANZA'
  | 'ACCIONES_PREVIAS'
  | 'ORIENTACION';

export interface ClientCredentials {
  clientId: number;
  label: string;
  loginMode: LoginMode;
  docNumber: string;
  solUser: string;
  solPassword: string;
}

export interface SunatNotificationItem {
  portal?: PortalType;
  sunatCode: string | null;
  subject: string;
  sender: string | null;
  notificationType: string | null;
  mailboxSource?: MailboxSource;
  publishedAt: string | null;
  readStatusSunat: string | null;
  deadlineAt?: string | null;
  termDays?: string | null;
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
  portal?: PortalType;
  subject: string;
  sunatCode: string | null;
  publishedAt: string | null;
  notificationType: string | null;
  mailboxSource?: MailboxSource;
  deadlineAt?: string | null;
  termDays?: string | null;
}

export interface AttachmentDownloadResult {
  found: boolean;
  filename?: string;
  filePath?: string;
  constanciaFilename?: string;
  constanciaPath?: string;
  message?: string;
}
