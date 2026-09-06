# 12. Guía de arranque

Guía corta para poner en marcha Code Hive Factory sobre un repositorio propio. Todo lo que
aparece aquí está tomado del código del repositorio.

## 12.1 Requisitos previos

- **Node.js 22 o superior.** Es lo que exige el campo `engines.node` de `package.json`
  (`>=22`).
- **npm.** El repositorio incluye `package-lock.json`, así que la instalación reproducible
  es `npm ci`; `npm install` también sirve.
- **better-sqlite3** (dependencia `^11.10.0`). Es un módulo nativo y se instala con el
  resto de dependencias. Si en tu equipo no hay binario precompilado para tu versión de
  Node, npm intentará compilarlo y necesitarás las herramientas de compilación del
  sistema.
- **CLI de Claude Code instalado y con sesión iniciada.** El motor lo busca en
  `~/.local/bin/claude.exe` en Windows y en `~/.local/bin/claude`,
  `/usr/local/bin/claude` o `/opt/homebrew/bin/claude` en el resto de sistemas. Si no
  aparece ninguno, el arranque falla con un mensaje pidiendo instalarlo. Al arrancar se
  ejecuta `claude --version` y, si falla, el servicio no llega a escuchar.
- **El repositorio que vas a gestionar tiene que ser un repositorio de Git.** Si no lo es,
  el arranque termina con el aviso de ejecutar `git init` antes.

Variables de entorno que lee el arranque (todas opcionales):

| Variable | Para qué sirve | Valor por omisión |
| --- | --- | --- |
| `CODEHIVE_REPO` | Ruta del repositorio a gestionar | el argumento de la línea de órdenes; si tampoco está, el directorio actual |
| `CODEHIVE_DB` | Fichero de base de datos SQLite | `data/codehive.db` bajo el directorio actual |
| `CODEHIVE_PORT` | Puerto de escucha | `4610` |
| `CODEHIVE_CLAUDE_PATH` | Ruta del ejecutable de Claude Code | búsqueda automática en las rutas de arriba |
| `CODEHIVE_WORKSPACES` | Carpeta donde se crean los espacios de trabajo de cada tarea | `workspaces` bajo el directorio actual |

## 12.2 Cómo registrar un proyecto

Hoy no hay ningún endpoint ni pantalla para dar de alta un proyecto: en `src/server/api.ts`
las rutas de proyectos son solo de lectura (`GET /api/projects`, `GET /api/projects/:id`,
etc.). **Pendiente:** el alta de proyectos desde la web no está implementada todavía, así
que el único procedimiento disponible es el que ocurre al arrancar.

El registro lo hace la función `ensureProject` de `src/app.ts` cuando levantas el servicio:

1. Apunta el servicio al repositorio, por variable de entorno o como argumento.
2. Al arrancar, se lee `codehive.project.json` en la raíz de ese repositorio. Si el fichero
   no existe se usan valores por omisión y el nombre del proyecto pasa a ser el de la
   carpeta.
3. Se crea la fila del proyecto y los cuatro agentes del equipo (orquestador, builder,
   reviewer, investigador).
4. Si ese repositorio ya estaba registrado, se reutiliza. Volver a arrancar no duplica nada.

Ejemplo de `codehive.project.json`:

```json
{
  "name": "Mi proyecto",
  "main_branch": "main",
  "verify_command": "npm test",
  "install_command": "npm ci",
  "max_concurrent_runs": 4,
  "max_task_attempts": 3,
  "run_timeout_ms": 900000,
  "protected_paths": [],
  "model": null
}
```

Comprobación de que quedó registrado, y primer encargo desde la API:

```bash
curl http://localhost:4610/api/projects
curl -X POST http://localhost:4610/api/projects/<id-del-proyecto>/chat \
  -H "Content-Type: application/json" \
  -d '{"body": "Quiero una pantalla de acceso con usuario y contraseña."}'
```

Desde la web es lo mismo escribiendo ese texto en el panel de chat: la web toma el primer
proyecto de `GET /api/projects` y envía el mensaje a `POST /api/projects/:id/chat`, que
despierta al orquestador para que cree las tareas.

## 12.3 Cómo arrancar el servicio

Comandos, todos definidos en `package.json`:

```bash
npm ci                 # instalar dependencias
npm run dev            # desarrollo: tsx watch src/index.ts
npm run build          # compilar servidor (tsc) y web (vite build)
npm start              # producción: node dist/index.js
npm test               # pruebas: vitest run
```

Para indicar el repositorio a gestionar, en PowerShell:

```powershell
$env:CODEHIVE_REPO = "C:\AreaDeTrabajo\mi-proyecto"
npm run dev
```

El servidor escucha en el puerto **4610** (o `CODEHIVE_PORT`) y en el host **0.0.0.0**, es
decir, en todas las interfaces de red. Por consola imprime la dirección local y las de la
red local.

La interfaz web se sirve de dos formas distintas:

- **En producción**, `npm run build` deja la web compilada en `web-dist` y el servidor la
  sirve como ficheros estáticos en el mismo puerto 4610. Si esa carpeta no existe, el
  servidor responde con un aviso de que hay que compilar la web.
- **En desarrollo**, `npm run dev:web` levanta Vite en el puerto **4611** y redirige las
  llamadas a `/api` hacia `http://127.0.0.1:4610`. Hacen falta los dos procesos: `npm run
  dev` para el servicio y `npm run dev:web` para la web.

## 12.4 Cómo abrir la web desde el móvil

El móvil tiene que estar en la misma red local que el equipo.

1. **Obtén la IP local del equipo.** En Windows, en PowerShell o en el símbolo del sistema:

   ```powershell
   ipconfig
   ```

   Busca el adaptador de tu red (Wi-Fi o Ethernet) y anota la línea `Dirección IPv4`, por
   ejemplo `192.168.1.42`. El propio servicio también imprime esa dirección al arrancar,
   en la línea «Desde el móvil en la misma red».

2. **Abre en el móvil** `http://192.168.1.42:4610`, sustituyendo la IP por la tuya. Usa el
   puerto 4610 (el del servicio con la web compilada), no el 4611 de Vite.

3. **Requisitos para que la conexión funcione:**
   - El servidor ya escucha en `0.0.0.0`, así que acepta conexiones desde otros equipos sin
     cambiar nada.
   - Hace falta una regla de entrada en el Firewall de Windows que permita el puerto 4610.
     En una consola de PowerShell como administrador:

     ```powershell
     New-NetFirewallRule -DisplayName "Code Hive Factory" -Direction Inbound `
       -Protocol TCP -LocalPort 4610 -Action Allow -Profile Private
     ```

   - La red del equipo debe estar marcada como privada; en redes públicas Windows bloquea
     este tipo de conexiones.

**Pendiente:** no hay autenticación en la API ni en la web, así que cualquiera en la misma
red local puede usarla. Úsalo solo en redes de confianza.
