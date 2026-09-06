import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

// ---------------------------------------------------------------------------
// Servidor simulado: responde a las rutas de la API sin levantar nada.
// ---------------------------------------------------------------------------

const PROYECTO = 'prj_1';

let tareas: Array<Record<string, unknown>>;
let mensajes: Array<Record<string, unknown>>;
let autorizaciones: Array<Record<string, unknown>>;
let consumo: Array<Record<string, unknown>>;
let estadoProyecto: string;
let motoresInstalados: Array<Record<string, unknown>>;
let motoresAusentes: Array<Record<string, unknown>>;
let orquestadorTrabajando: boolean;
let peticiones: Array<{ metodo: string; ruta: string; cuerpo: unknown }>;

/** Escuchadores del canal de eventos, para poder empujar eventos desde una prueba. */
let alRecibirEvento: ((datos: string) => void) | null = null;

class EventSourceSimulada {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  cerrada = false;

  constructor(public url: string) {
    setTimeout(() => {
      this.onopen?.();
      alRecibirEvento = (datos) => this.onmessage?.({ data: datos });
    }, 0);
  }

  close() {
    this.cerrada = true;
    alRecibirEvento = null;
  }
}

function respuesta(cuerpo: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

function servidorSimulado(entrada: string | URL | Request, opciones?: RequestInit): Promise<Response> {
  const ruta = typeof entrada === 'string' ? entrada : entrada.toString();
  const metodo = opciones?.method ?? 'GET';
  const cuerpo = opciones?.body ? JSON.parse(String(opciones.body)) : null;
  peticiones.push({ metodo, ruta, cuerpo });

  if (ruta === '/api/projects') return respuesta([{ id: PROYECTO, name: 'Code Hive Factory' }]);

  if (ruta === `/api/projects/${PROYECTO}`) {
    return respuesta({
      project: {
        id: PROYECTO, name: 'Code Hive Factory', goal: 'Tener el área de proyectos',
        repo_path: '/proyecto', main_branch: 'main', verify_command: 'npm test',
        install_command: 'npm ci', max_concurrent_runs: 3, max_task_attempts: 3,
        status: estadoProyecto,
      },
      snapshot: { goal: 'Tener el área de proyectos', decisions: [], pending_approvals: autorizaciones },
      integrable: [],
      usage: consumo,
      active_work: [],
      orchestrator_busy: orquestadorTrabajando,
    });
  }

  if (ruta === `/api/projects/${PROYECTO}/tasks`) return respuesta(tareas);
  if (ruta === `/api/projects/${PROYECTO}/agents`) {
    return respuesta([
      {
        id: 'agt_1', name: 'Builder', role: 'builder', engine: 'claude_code', model: null,
        allowed_tools: ['Read', 'Write'], max_workers: 1, enabled: 1, busy_workers: 1,
        current_tasks: ['tsk_1'], queue_length: 2,
      },
      {
        id: 'agt_2', name: 'Reviewer', role: 'reviewer', engine: 'codex', model: null,
        allowed_tools: ['Read'], max_workers: 1, enabled: 1, busy_workers: 0,
        current_tasks: [], queue_length: 0,
      },
    ]);
  }

  if (ruta === `/api/projects/${PROYECTO}/chat`) {
    if (metodo === 'POST') {
      const nuevo = { id: 'm_nuevo', author: 'creator', body: (cuerpo as { body: string }).body, created_at: new Date().toISOString() };
      mensajes = [...mensajes, nuevo];
      return respuesta(nuevo, 201);
    }
    return respuesta(mensajes);
  }

  if (ruta.startsWith(`/api/projects/${PROYECTO}/activity`)) return respuesta([]);

  if (ruta === '/api/engines') {
    return respuesta({ available: motoresInstalados, unavailable: motoresAusentes });
  }

  if (ruta.endsWith('/pause')) {
    estadoProyecto = (cuerpo as { paused: boolean }).paused ? 'paused' : 'active';
    return respuesta({ status: estadoProyecto });
  }

  if (ruta.startsWith('/api/agents/')) return respuesta({ ok: true });

  if (ruta.endsWith('/orchestrator/stop')) {
    orquestadorTrabajando = false;
    return respuesta({ requested: true, running: true });
  }

  if (ruta.startsWith('/api/tasks/')) {
    const id = ruta.split('/')[3]!;
    const task = tareas.find((t) => t['id'] === id);
    return respuesta({
      task,
      waiting_for: null,
      runs: [
        {
          id: 'run_1', task_id: id, status: 'succeeded', summary: 'He escrito la validación.',
          error: null, cost_usd: 0.12, input_tokens: 100, output_tokens: 50,
          started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
        },
      ],
      increments: [
        {
          id: 'inc_1', commit_sha: 'a1b2c3d4e5f6', branch: 'task/uno', message: 'validación de nombres',
          files_json: JSON.stringify(['src/validate.ts']), review_status: 'rejected',
          created_at: new Date().toISOString(),
        },
      ],
      findings: [
        {
          id: 'fnd_1', severity: 'blocker', title: 'Acepta la cadena vacía',
          detail: 'La validación deja pasar un nombre vacío.',
          resolution: 'Un nombre vacío devuelve error.',
          file_path: 'src/validate.ts', line: 42, status: 'open', fix_task_id: 'tsk_fix',
          created_at: new Date().toISOString(),
        },
      ],
      integrable: { ready: false, reason: 'Quedan 1 hallazgos bloqueantes abiertos.' },
      approvals: [],
      notices: [],
      dependencies: [],
      locks: [{ id: 'lck_1', path_pattern: 'src/**', released_at: null }],
    });
  }

  return respuesta({ error: 'ruta no simulada: ' + ruta }, 404);
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  peticiones = [];
  autorizaciones = [];
  consumo = [];
  estadoProyecto = 'active';
  motoresInstalados = [
    {
      name: 'claude_code',
      capabilities: {
        resumeSession: true, resultSchema: true, usageReporting: true, costReporting: true,
        budgetLimit: true, permissionDenials: true, stop: true,
      },
    },
    {
      name: 'codex',
      capabilities: {
        resumeSession: true, resultSchema: true, usageReporting: false, costReporting: false,
        budgetLimit: false, permissionDenials: false, stop: true,
      },
    },
  ];
  motoresAusentes = [];
  orquestadorTrabajando = false;
  mensajes = [
    { id: 'm1', author: 'creator', body: 'Añade la validación de nombres', created_at: new Date().toISOString() },
    { id: 'm2', author: 'orchestrator', body: 'De acuerdo, se la paso al builder.', created_at: new Date().toISOString() },
  ];
  tareas = [
    {
      id: 'tsk_1', project_id: PROYECTO, parent_task_id: null, kind: 'build',
      title: 'Validación de nombres', goal: 'Implementar la validación', scope: null, acceptance: null,
      required_role: 'builder', priority: 40, status: 'in_progress', assigned_agent_id: 'agt_1',
      active_run_id: 'run_1', branch: 'task/uno', head_commit: null, attempts: 1,
      blocked_reason: null, needs_reeval: 0, findings_open: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
    {
      id: 'tsk_2', project_id: PROYECTO, parent_task_id: null, kind: 'build',
      title: 'Pantalla de listado', goal: 'Mostrar la lista', scope: null, acceptance: null,
      required_role: 'builder', priority: 60, status: 'blocked', assigned_agent_id: null,
      active_run_id: null, branch: null, head_commit: null, attempts: 0,
      blocked_reason: 'Falta decidir el formato de los nombres.', needs_reeval: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
  ];

  vi.stubGlobal('fetch', vi.fn(servidorSimulado));
  vi.stubGlobal('EventSource', EventSourceSimulada);
});

afterEach(() => {
  vi.unstubAllGlobals();
  alRecibirEvento = null;
});

/** Abre el cajón del trabajo, que es donde vive la lista de tareas. */
async function abrirCajonDelTrabajo() {
  // Primero hay que esperar a que la app haya cargado el proyecto.
  await screen.findByRole('button', { name: 'Ver el trabajo del proyecto' });

  if (!document.querySelector('.cajon')) {
    await userEvent.click(screen.getByRole('button', { name: 'Ver el trabajo del proyecto' }));
    await waitFor(() => expect(document.querySelector('.cajon')).not.toBeNull());
  }
}

/**
 * Abre una tarea desde la lista de trabajo.
 *
 * El título de una tarea aparece en dos sitios a la vez: en el panel del agente que la
 * tiene, y en su propia tarjeta. Buscar solo por texto encontraría las dos.
 */
async function abrirTarea(titulo: string) {
  await abrirCajonDelTrabajo();

  const tarjeta = await waitFor(() => {
    const encontrada = [...document.querySelectorAll('.rejilla-tareas .tarea')].find(
      (t) => t.querySelector('.titulo')?.textContent === titulo,
    );
    if (!encontrada) throw new Error();
    return encontrada as HTMLElement;
  });

  await userEvent.click(tarjeta);
  return waitFor(() => screen.getByRole('dialog'));
}

/** Espera a que la lista de trabajo tenga una tarea con ese título. */
async function esperarTarea(titulo: string) {
  await abrirCajonDelTrabajo();
  await waitFor(() => {
    const encontrada = [...document.querySelectorAll('.tarea .titulo')].some(
      (t) => t.textContent === titulo,
    );
    if (!encontrada) throw new Error();
  });
}

// ---------------------------------------------------------------------------

describe('pantalla principal', () => {
  it('dice en qué carpeta y en qué rama trabaja el equipo', async () => {
    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Code Hive Factory', level: 1 })).toBeDefined(),
    );

    // Sin esto, no se sabe dónde va a hacer el equipo lo que le pidas.
    expect(screen.getByText('/proyecto')).toBeDefined();
    expect(screen.getByText('rama main')).toBeDefined();
  });

  it('cada agente tiene su panel, con su rol y su motor', async () => {
    render(<App />);

    // Los agentes que no son el orquestador se ven siempre, uno por panel.
    await waitFor(() => expect(screen.getByText(/Construcción · claude_code/)).toBeDefined());
    expect(screen.getByText(/Revisión · codex/)).toBeDefined();
  });

});

describe('consumo de la suscripción', () => {
  it('no se muestra nada mientras el motor no haya informado', async () => {
    render(<App />);
    await esperarTarea('Pantalla de listado');
    expect(screen.queryByText(/Cuota/)).toBeNull();
  });

  it('con el dato del motor se muestra el porcentaje real', async () => {
    consumo = [
      {
        engine: 'claude_code', status: 'allowed', five_hour_util: 0.42,
        five_hour_resets: new Date().toISOString(), seven_day_util: 0.1,
        seven_day_resets: new Date().toISOString(), using_overage: 0,
        updated_at: new Date().toISOString(),
      },
    ];

    render(<App />);
    await waitFor(() => expect(screen.getByText('Cuota 42%')).toBeDefined());
  });

  it('sin cuota lo dice y explica que el trabajo está en pausa', async () => {
    consumo = [
      {
        engine: 'claude_code', status: 'exhausted', five_hour_util: 1,
        five_hour_resets: new Date().toISOString(), seven_day_util: 0.5,
        seven_day_resets: new Date().toISOString(), using_overage: 0,
        updated_at: new Date().toISOString(),
      },
    ];

    render(<App />);
    await waitFor(() => expect(screen.getByText(/se ha quedado sin cuota/)).toBeDefined());
    expect(screen.getByText(/conservan su estado/)).toBeDefined();
  });
});

describe('avisos que no se pueden ocultar', () => {
  it('una autorización pendiente sale en la pantalla principal', async () => {
    autorizaciones = [{ id: 'apr_1', task_id: 'tsk_1', request: 'Quiere usar WebFetch.' }];

    render(<App />);
    await waitFor(() => expect(screen.getByText(/necesita tu permiso/)).toBeDefined());
    expect(screen.getByRole('button', { name: 'Ver' })).toBeDefined();
  });
});

describe('detalle de una tarea', () => {
  it('el recorrido de un hallazgo se sigue sin salir de la vista', async () => {
    render(<App />);
    const panel = await abrirTarea('Validación de nombres');

    // El hallazgo, con su condición de resolución y su corrección.
    expect(panel.textContent).toContain('Acepta la cadena vacía');
    expect(panel.textContent).toContain('Se da por resuelto cuando: Un nombre vacío devuelve error.');
    expect(panel.textContent).toContain('src/validate.ts:42');
    expect(screen.getByRole('button', { name: 'Ver la corrección' })).toBeDefined();

    // El incremento revisado, y lo que hizo la ejecución.
    expect(panel.textContent).toContain('a1b2c3d4');
    expect(panel.textContent).toContain('Revisado con hallazgos');
    expect(panel.textContent).toContain('He escrito la validación.');

    // Y el motivo por el que todavía no se puede integrar.
    expect(panel.textContent).toContain('Quedan 1 hallazgos bloqueantes abiertos.');
  });

  it('no se ofrece integrar cuando no se puede', async () => {
    render(<App />);
    await abrirTarea('Validación de nombres');
    expect(screen.queryByRole('button', { name: /Integrar/ })).toBeNull();
  });

  it('se cierra al pulsar cerrar', async () => {
    render(<App />);
    await abrirTarea('Validación de nombres');
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('enviar un mensaje al orquestador', () => {
  it('llega al servidor y aparece en la conversación', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('Mensaje para el orquestador')).toBeDefined());

    await userEvent.type(screen.getByLabelText('Mensaje para el orquestador'), 'Añade también un filtro');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    await waitFor(() => {
      const envio = peticiones.find((p) => p.metodo === 'POST' && p.ruta.endsWith('/chat'));
      expect(envio).toBeDefined();
      expect((envio!.cuerpo as { body: string }).body).toBe('Añade también un filtro');
    });

    await waitFor(() => expect(screen.getByText('Añade también un filtro')).toBeDefined());
  });
});

describe('vista de tablero', () => {
  it('se cambia de vista sin perder el estado', async () => {
    render(<App />);
    await esperarTarea('Validación de nombres');

    await userEvent.click(screen.getByRole('button', { name: 'Ver por estados' }));

    await waitFor(() => expect(screen.getByText('Tablero por estados')).toBeDefined());
    // El chat sigue ahí, con su conversación.
    expect(screen.getByText('De acuerdo, se la paso al builder.')).toBeDefined();
  });
});

describe('eventos en vivo', () => {
  it('un evento nuevo hace que la web vuelva a pedir el estado', async () => {
    render(<App />);
    await esperarTarea('Validación de nombres');

    const antes = peticiones.filter((p) => p.ruta.endsWith('/tasks')).length;

    // Llega un evento por el canal en vivo.
    tareas[0]!['title'] = 'Validación de nombres, corregida';
    alRecibirEvento?.(
      JSON.stringify({
        id: 10, project_id: PROYECTO, type: 'increment.published', task_id: 'tsk_1',
        run_id: null, agent_id: null, payload: JSON.stringify({ message: 'corrección' }),
        created_at: new Date().toISOString(),
      }),
    );

    await waitFor(() => {
      expect(peticiones.filter((p) => p.ruta.endsWith('/tasks')).length).toBeGreaterThan(antes);
    });
    await esperarTarea('Validación de nombres, corregida');
  });
});

describe('ajustes', () => {
  /** Abre el panel de ajustes desde la cabecera. */
  async function abrirAjustes() {
    await esperarTarea('Validación de nombres');
    await userEvent.click(screen.getByRole('button', { name: 'Ajustes' }));
    return waitFor(() => screen.getByRole('dialog', { name: 'Ajustes' }));
  }

  it('muestra la configuración del proyecto', async () => {
    render(<App />);
    const panel = await abrirAjustes();

    expect(panel.textContent).toContain('/proyecto');
    expect(panel.textContent).toContain('npm test');
    expect(panel.textContent).toContain('activo');
  });

  it('el motor de cada agente se puede cambiar entre los instalados', async () => {
    render(<App />);
    await abrirAjustes();

    const selectores = screen.getAllByRole('combobox');
    expect(selectores).toHaveLength(2);

    // Solo se ofrecen los motores que están instalados de verdad.
    const opciones = [...selectores[0]!.querySelectorAll('option')].map((o) => o.textContent);
    expect(opciones).toEqual(['claude_code', 'codex']);

    await userEvent.selectOptions(selectores[0]!, 'codex');

    await waitFor(() => {
      const envio = peticiones.find((p) => p.metodo === 'POST' && p.ruta.endsWith('/engine'));
      expect(envio).toBeDefined();
      expect((envio!.cuerpo as { engine: string }).engine).toBe('codex');
    });
  });

  it('un motor que no está instalado se explica, no se ofrece', async () => {
    motoresInstalados = motoresInstalados.slice(0, 1);
    motoresAusentes = [{ engine: 'codex', reason: 'No se encuentra el ejecutable de Codex.' }];

    render(<App />);
    const panel = await abrirAjustes();

    expect(panel.textContent).toContain('No se encuentra el ejecutable de Codex.');
    // Con un solo motor no hay nada que elegir.
    expect(screen.getAllByRole('combobox')[0]).toHaveProperty('disabled', true);
  });

  it('dice qué sabe hacer cada motor, sin prometer lo que no hace', async () => {
    render(<App />);
    const panel = await abrirAjustes();

    expect(panel.textContent).toContain('informa del coste');
    expect(panel.textContent).toContain('no informa del consumo');
  });

  it('pausar el proyecto lo dice en la pantalla principal', async () => {
    render(<App />);
    await abrirAjustes();

    await userEvent.click(screen.getByRole('button', { name: 'Pausar el proyecto' }));

    await waitFor(() => {
      const envio = peticiones.find((p) => p.metodo === 'POST' && p.ruta.endsWith('/pause'));
      expect((envio!.cuerpo as { paused: boolean }).paused).toBe(true);
    });

    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    await waitFor(() => expect(screen.getByText(/El proyecto está en pausa/)).toBeDefined());
  });

  it('cambiar el número de workers llega al servidor', async () => {
    render(<App />);
    await abrirAjustes();

    const campos = screen.getAllByRole('spinbutton');
    await userEvent.clear(campos[0]!);
    await userEvent.type(campos[0]!, '3');
    await userEvent.tab();

    await waitFor(() => {
      const envio = peticiones.find((p) => p.metodo === 'POST' && p.ruta.endsWith('/workers'));
      expect((envio!.cuerpo as { max_workers: number }).max_workers).toBe(3);
    });
  });
});

describe('esperar al orquestador', () => {
  it('mientras trabaja se ve que hay que esperar, y se puede parar', async () => {
    orquestadorTrabajando = true;
    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Parar' })).toBeDefined());

    // Una animación acompaña la espera: sin ella, esperar y estar parado se ven igual.
    expect(document.querySelector('.girando')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Parar' }));

    await waitFor(() => {
      const envio = peticiones.find((p) => p.ruta.endsWith('/orchestrator/stop'));
      expect(envio).toBeDefined();
    });

    // Pedir la parada no es lo mismo que estar parado, y la web lo dice así.
    await waitFor(() => expect(screen.getByText(/Parada pedida/)).toBeDefined());
  });

  it('cuando no trabaja no hay ni espera ni botón de parar', async () => {
    render(<App />);
    await esperarTarea('Validación de nombres');

    expect(screen.queryByRole('button', { name: 'Parar' })).toBeNull();
    expect(document.querySelector('.girando')).toBeNull();
  });
});
