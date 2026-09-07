import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * El diálogo de carpetas de Windows.
 *
 * Una página web no puede saber en qué sitio del disco está una carpeta: el navegador se
 * lo oculta a propósito. Quien sí lo sabe es el servicio, porque corre en el equipo. Así
 * que el diálogo lo abre el servicio, y la web solo recibe la ruta elegida.
 *
 * La ventana aparece en el equipo donde corre el servicio. Desde el móvil no sirve, y por
 * eso el explorador de carpetas de la web sigue estando.
 */

/** Cuánto se espera a que la persona elija antes de rendirse. */
const ESPERA_MAXIMA_MS = 240_000;

const GUION = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null

$dialogo = New-Object System.Windows.Forms.FolderBrowserDialog
$dialogo.Description = 'Elige la carpeta del proyecto'
$dialogo.ShowNewFolderButton = $false

# El árbol arranca en Este equipo. Con la raíz por omisión, que es el escritorio, el
# diálogo recorre también OneDrive, la red y las ubicaciones del perfil, y tarda segundos
# en aparecer.
$dialogo.RootFolder = [System.Environment+SpecialFolder]::MyComputer

# La carpeta de inicio solo se pone si existe. Con una ruta que no existe, el diálogo
# recorre el árbol entero buscándola antes de rendirse.
if ($env:CODEHIVE_CARPETA_INICIO -and (Test-Path -LiteralPath $env:CODEHIVE_CARPETA_INICIO)) {
  $dialogo.SelectedPath = $env:CODEHIVE_CARPETA_INICIO
}

# El diálogo se cuelga de una ventana siempre encima. Sin ella se abre detrás del
# navegador y parece que el sistema se ha quedado colgado.
$duenyo = New-Object System.Windows.Forms.Form
$duenyo.TopMost = $true

if ($dialogo.ShowDialog($duenyo) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialogo.SelectedPath)
}

$duenyo.Dispose()
$dialogo.Dispose()
`;

/** Si este equipo puede abrir el diálogo de carpetas del sistema. */
export function haySelectorNativo(): boolean {
  return process.platform === 'win32';
}

/**
 * Abre el diálogo de carpetas y devuelve la que se elija, o null si se cancela.
 *
 * El guion se escribe en un fichero temporal en vez de pasarse por la línea de órdenes:
 * un guion de varias líneas con comillas y símbolos de dólar no sobrevive entero como
 * argumento.
 */
export async function elegirCarpetaNativa(inicio?: string): Promise<string | null> {
  if (!haySelectorNativo()) {
    throw new Error('Este equipo no puede abrir el diálogo de carpetas del sistema.');
  }

  const temporal = mkdtempSync(join(tmpdir(), 'codehive-carpeta-'));
  const guion = join(temporal, 'elegir.ps1');
  writeFileSync(guion, GUION, 'utf8');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', guion],
      {
        timeout: ESPERA_MAXIMA_MS,
        windowsHide: true,
        env: { ...process.env, CODEHIVE_CARPETA_INICIO: inicio ?? '' },
      },
    );

    const elegida = stdout.trim();
    return elegida ? elegida : null;
  } catch (e) {
    const error = e as { killed?: boolean; message?: string };
    if (error.killed) {
      throw new Error('Se acabó el tiempo de espera del diálogo de carpetas.');
    }
    throw new Error(`No se pudo abrir el diálogo de carpetas: ${error.message ?? String(e)}`);
  } finally {
    rmSync(temporal, { recursive: true, force: true });
  }
}
