import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getConfig, requireEncryptionKey } from '../config/env.js';
import { closeDatabase, getDatabase } from '../db/database.js';
import type { LoginMode } from '../scraper/types.js';
import { ClientService } from '../services/clientService.js';

async function promptSecret(question: string): Promise<string> {
  if (!input.isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }

  return new Promise((resolve, reject) => {
    output.write(question);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let secret = '';

    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          output.write('\n');
          cleanup();
          resolve(secret);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl+C
          output.write('\n');
          cleanup();
          reject(new Error('Operacion cancelada por el usuario.'));
          return;
        }
        if (ch === '\u0008' || ch === '\u007f') {
          // Backspace / Delete
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
            output.write('\b \b');
          }
        } else if (ch >= ' ') {
          secret += ch;
          output.write('*');
        }
      }
    };

    input.on('data', onData);
  });
}

async function handleAdd(service: ClientService): Promise<void> {
  const rl = readline.createInterface({ input, output });
  let loginMode: LoginMode = 'RUC';
  let label = '';
  let docNumber = '';
  let solUser = '';

  try {
    console.log('\n=== Registrar Cliente SUNAT (almacenamiento cifrado AES-256-GCM) ===');
    console.log('Consejo: Usa un Usuario Secundario SOL con permiso solo de Buzon Electronico.\n');

    const modeAns = (await rl.question('Tipo de acceso [1 = RUC (por defecto), 2 = DNI]: ')).trim();
    loginMode = modeAns === '2' || modeAns.toUpperCase() === 'DNI' ? 'DNI' : 'RUC';

    label = (await rl.question('Nombre o etiqueta del cliente (ej. Comercial Peru SAC): ')).trim();
    docNumber = (
      await rl.question(loginMode === 'RUC' ? 'Numero de RUC (11 digitos): ' : 'Numero de DNI (8 digitos): ')
    ).trim();

    if (loginMode === 'RUC') {
      solUser = (await rl.question('Usuario SOL (se convertira a mayusculas): ')).trim().toUpperCase();
    }
  } finally {
    rl.close();
  }

  const solPassword = await promptSecret('Clave SOL (oculta al escribir): ');

  const clientId = service.addClient({
    label,
    loginMode,
    docNumber,
    solUser,
    solPassword,
  });

  console.log(`\n[OK] Cliente "${label}" guardado de forma segura con ID ${clientId}.\n`);
}

function handleList(service: ClientService): void {
  const clients = service.listClients();
  if (clients.length === 0) {
    console.log('\nNo hay clientes registrados. Ejecuta: npm run client:add\n');
    return;
  }

  console.log('\n=== Clientes Registrados ===');
  console.table(
    clients.map((c) => ({
      ID: c.id,
      Cliente: c.label,
      Modo: c.loginMode,
      Documento: c.docNumber,
      Usuario: c.solUserMasked,
      Activo: c.active ? 'SI' : 'NO',
      Estado: c.lastStatus ?? 'Pendiente',
      UltimaRevision: c.lastCheckedAt ?? '-',
      NuevasAlertas: c.unreadAlertsCount,
    })),
  );
}

function handleToggle(service: ClientService, idArg?: string): void {
  const id = Number.parseInt(idArg ?? '', 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('Debes indicar el ID numerico del cliente. Ej: npm run client:toggle -- 1');
  }
  const active = service.toggleClient(id);
  console.log(`\nCliente ID ${id} ahora esta: ${active ? 'ACTIVO' : 'PAUSADO'}.\n`);
}

function handleRemove(service: ClientService, idArg?: string): void {
  const id = Number.parseInt(idArg ?? '', 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('Debes indicar el ID numerico del cliente. Ej: npm run client:remove -- 1');
  }
  const removed = service.removeClient(id);
  if (!removed) {
    console.log(`\nNo se encontro cliente con ID ${id}.\n`);
    return;
  }
  console.log(`\nCliente ID ${id} y sus notificaciones fueron eliminados.\n`);
}

function handleNotifications(service: ClientService, args: string[]): void {
  if (args.includes('--ack')) {
    const updated = service.markAllAlertsAsReviewed();
    console.log(`\nSe marcaron ${updated} alerta(s) nueva(s) como revisadas.\n`);
    return;
  }

  const onlyNew = args.includes('--new');
  const rows = service.listNotifications({ onlyNew, limit: 50 });

  if (rows.length === 0) {
    console.log(
      onlyNew
        ? '\nNo hay alertas nuevas pendientes de revisar.\n'
        : '\nAun no se han registrado notificaciones en la base de datos.\n',
    );
    return;
  }

  console.log(`\n=== ${onlyNew ? 'Alertas Nuevas' : 'Ultimas Notificaciones'} (${rows.length}) ===`);
  console.table(
    rows.map((r) => ({
      ID: r.id,
      Cliente: r.clientLabel,
      Documento: r.docNumber,
      FechaSUNAT: r.publishedAt ?? '-',
      Codigo: r.sunatCode ?? '-',
      Asunto: r.subject.length > 60 ? `${r.subject.slice(0, 57)}...` : r.subject,
      Nueva: r.isNewAlert ? 'SI' : 'No',
      Detectada: r.firstSeenAt,
    })),
  );
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const config = getConfig();
  const key = requireEncryptionKey(config);
  const db = getDatabase(config.dbPath);
  const service = new ClientService(db, key);

  try {
    switch (command) {
      case 'add':
        await handleAdd(service);
        break;
      case 'list':
        handleList(service);
        break;
      case 'toggle':
        handleToggle(service, rest[0]);
        break;
      case 'remove':
        handleRemove(service, rest[0]);
        break;
      case 'notifications':
        handleNotifications(service, rest);
        break;
      default:
        console.log('Comandos disponibles: add | list | toggle <id> | remove <id> | notifications [--new|--ack]');
    }
  } finally {
    closeDatabase();
  }
}

main().catch((err) => {
  console.error('\n[Error]', err instanceof Error ? err.message : String(err));
  closeDatabase();
  process.exit(1);
});
