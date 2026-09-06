import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp, describeTeam } from './app.js';

/** Direcciones IPv4 de la red local por las que se puede abrir la web desde el móvil. */
function direccionesLocales(): string[] {
  const salida: string[] = [];
  for (const interfaz of Object.values(networkInterfaces())) {
    for (const dato of interfaz ?? []) {
      if (dato.family === 'IPv4' && !dato.internal) salida.push(dato.address);
    }
  }
  return salida;
}

async function main(): Promise<void> {
  const repoPath = resolve(process.env['CODEHIVE_REPO'] ?? process.argv[2] ?? process.cwd());
  const dbPath = process.env['CODEHIVE_DB'] ?? join(process.cwd(), 'data', 'codehive.db');
  const port = Number(process.env['CODEHIVE_PORT'] ?? 4610);

  const app = await createApp({ dbPath, repoPath, port });
  const { port: puerto } = await app.start();

  console.log(`\nCode Hive Factory en marcha.`);
  console.log(`Proyecto: ${app.project.name} (${app.project.repo_path})`);
  console.log(`Equipo: ${describeTeam(app.db, app.project.id)}`);
  console.log(`\nAbre http://localhost:${puerto}`);
  for (const ip of direccionesLocales()) {
    console.log(`Desde el móvil en la misma red: http://${ip}:${puerto}`);
  }

  const parar = async (senal: string) => {
    console.log(`\nRecibido ${senal}. Parando el trabajo en curso.`);
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void parar('SIGINT'));
  process.on('SIGTERM', () => void parar('SIGTERM'));
}

main().catch((e) => {
  console.error(`No se pudo arrancar: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
