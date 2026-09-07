import type { Db } from './db.js';
import { currentDecisions, protectedPaths, requireProject } from './projects.js';
import { pendingNotices, requireTask, taskPathPatterns } from './tasks.js';
import { pendingForAgent, teamDirectory } from './agent-messages.js';
import type { Assignment, Finding, Run, Task } from '../shared/types.js';

/**
 * Reúne todo lo que un agente necesita saber para hacer su tarea.
 *
 * Incluye el objetivo del proyecto, las decisiones vigentes, el alcance propio y las
 * relaciones con otros trabajos. No incluye el historial de los demás agentes: el listado
 * del equipo dice quién existe y qué rol tiene, que es lo que pide el requisito A06.
 */
export function buildAssignment(db: Db, taskId: string): Assignment {
  const task = requireTask(db, taskId);
  const project = requireProject(db, task.project_id);

  const dependencies = db
    .prepare(
      `SELECT t.id, t.title, t.status,
              (SELECT r.summary FROM runs r
               WHERE r.task_id = t.id AND r.summary IS NOT NULL
               ORDER BY r.started_at DESC LIMIT 1) AS result
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_id
       WHERE d.task_id = ?`,
    )
    .all(taskId) as Assignment['dependencies'];

  const equipo = teamDirectory(db, task.project_id).map((a) => ({
    agent_id: a.agent_id,
    name: a.name,
    role: a.role,
    available: a.available,
  }));

  const previa = db
    .prepare(
      `SELECT id, summary, engine_session_id FROM runs
       WHERE task_id = ? AND status <> 'running'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(taskId) as Pick<Run, 'id' | 'summary' | 'engine_session_id'> | undefined;

  return {
    task: {
      id: task.id,
      kind: task.kind,
      title: task.title,
      goal: task.goal,
      scope: task.scope,
      acceptance: task.acceptance,
      priority: task.priority,
    },
    project: {
      id: project.id,
      name: project.name,
      goal: project.goal,
      main_branch: project.main_branch,
      verify_command: project.verify_command,
    },
    workspace:
      task.workspace_path && task.branch
        ? { path: task.workspace_path, branch: task.branch, base_commit: task.base_commit ?? '' }
        : null,
    decisions: currentDecisions(db, task.project_id).map((d) => ({
      title: d.title,
      body: d.body,
      revision: d.revision,
    })),
    dependencies,
    locks: taskPathPatterns(db, taskId),
    protected_paths: protectedPaths(project),
    findings: findingsForTask(db, task),
    team: equipo,
    notices: [
      ...pendingNotices(db, taskId),
      ...(task.assigned_agent_id
        ? pendingForAgent(db, task.assigned_agent_id).map((m) => ({
            from: m.from_agent_id,
            body: `[${m.kind}] ${m.body}`,
          }))
        : []),
    ],
    previous_run: previa ?? null,
  };
}

/**
 * Hallazgos que el agente tiene que tener delante.
 *
 * Una tarea de corrección recibe los hallazgos que la originaron. Cualquier otra tarea
 * recibe los que siguen abiertos sobre su propio trabajo.
 */
function findingsForTask(db: Db, task: Task): Assignment['findings'] {
  const filas =
    task.kind === 'fix'
      ? (db
          .prepare("SELECT * FROM findings WHERE fix_task_id = ? AND status = 'open'")
          .all(task.id) as Finding[])
      : (db
          .prepare("SELECT * FROM findings WHERE source_task_id = ? AND status = 'open'")
          .all(task.id) as Finding[]);

  return filas.map((f) => ({
    id: f.id,
    severity: f.severity,
    title: f.title,
    detail: f.detail,
    resolution: f.resolution,
  }));
}

// ---------------------------------------------------------------------------
// Redacción del encargo
// ---------------------------------------------------------------------------

function seccion(titulo: string, cuerpo: string | null | undefined): string {
  return cuerpo && cuerpo.trim() ? `## ${titulo}\n${cuerpo.trim()}\n` : '';
}

/**
 * Convierte el encargo en el texto que se envía al motor.
 *
 * El texto va por la entrada estándar del proceso, así que puede ser tan largo como haga
 * falta y no sufre problemas de comillas (apartado 11.3 del documento de capacidades).
 */
export function renderAssignment(assignment: Assignment): string {
  const partes: string[] = [];

  partes.push(`# Tarea: ${assignment.task.title}`);
  partes.push(`Identificador: ${assignment.task.id}. Tipo: ${assignment.task.kind}.\n`);

  partes.push(seccion('Objetivo', assignment.task.goal));
  partes.push(seccion('Alcance', assignment.task.scope));
  partes.push(seccion('Criterios de aceptación', assignment.task.acceptance));

  partes.push(
    seccion(
      'Proyecto',
      [
        `Nombre: ${assignment.project.name}.`,
        assignment.project.goal ? `Objetivo actual: ${assignment.project.goal}` : null,
        assignment.project.verify_command
          ? `Comando de verificación: ${assignment.project.verify_command}`
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  );

  if (assignment.workspace) {
    partes.push(
      seccion(
        'Espacio de trabajo',
        [
          `Directorio: ${assignment.workspace.path}`,
          `Rama: ${assignment.workspace.branch}`,
          `Commit de partida: ${assignment.workspace.base_commit}`,
          'Trabaja solo dentro de este directorio. No hagas push a ningún remoto ni fusiones en la rama principal.',
        ].join('\n'),
      ),
    );
  }

  if (assignment.locks.length > 0) {
    partes.push(
      seccion(
        'Ficheros reservados para esta tarea',
        [
          assignment.locks.map((l) => `- ${l}`).join('\n'),
          '',
          'Si necesitas tocar algo fuera de esta lista, termina con outcome igual a blocked y explica qué fichero y por qué.',
        ].join('\n'),
      ),
    );
  }

  if (assignment.protected_paths.length > 0) {
    partes.push(
      seccion(
        'Ficheros protegidos del proyecto',
        [
          assignment.protected_paths.map((p) => `- ${p}`).join('\n'),
          '',
          'No los modifiques bajo ningún concepto, ni siquiera si tu tarea parece pedirlo.',
          'El sistema comprueba los ficheros de tu commit: si tocas alguno de estos, tu trabajo no se publica y la tarea queda bloqueada.',
          'Si crees que el trabajo no se puede hacer sin tocarlos, termina con outcome igual a blocked y explica cuál y por qué.',
        ].join('\n'),
      ),
    );
  }

  if (assignment.decisions.length > 0) {
    partes.push(
      seccion(
        'Decisiones vigentes del proyecto',
        assignment.decisions.map((d) => `### ${d.title} (revisión ${d.revision})\n${d.body}`).join('\n\n'),
      ),
    );
  }

  if (assignment.dependencies.length > 0) {
    partes.push(
      seccion(
        'Trabajos de los que depende esta tarea',
        assignment.dependencies
          .map((d) => `- ${d.title} (${d.status})${d.result ? `: ${d.result}` : ''}`)
          .join('\n'),
      ),
    );
  }

  if (assignment.findings.length > 0) {
    partes.push(
      seccion(
        'Hallazgos que debes resolver',
        assignment.findings
          .map(
            (f) =>
              `### [${f.severity}] ${f.title}\n${f.detail}\n\nSe da por resuelto cuando: ${f.resolution}`,
          )
          .join('\n\n'),
      ),
    );
  }

  if (assignment.notices.length > 0) {
    partes.push(
      seccion(
        'Avisos que han llegado mientras trabajabas',
        assignment.notices.map((n) => `- De ${n.from}: ${n.body}`).join('\n'),
      ),
    );
  }

  if (assignment.previous_run?.summary) {
    partes.push(seccion('Lo que hiciste en el intento anterior', assignment.previous_run.summary));
  }

  partes.push(
    seccion(
      'Equipo',
      [
        assignment.team
          .map((a) => `- ${a.name} (${a.role}): ${a.available ? 'disponible' : 'ocupado'}`)
          .join('\n'),
        '',
        'Si necesitas algo que sabe hacer otro rol, decláralo en el campo needs de tu resultado.',
        'Se convertirá en una tarea con responsable, y tu tarea la esperará.',
      ].join('\n'),
    ),
  );

  partes.push(
    seccion(
      'Cómo terminar',
      'Devuelve el resultado con el formato acordado. El campo summary lo lee una persona, así que escríbelo en lenguaje llano.',
    ),
  );

  return partes.filter(Boolean).join('\n');
}
