# Code Hive Factory

Sistema de orquestación de agentes de programación. El creador conversa con un agente
orquestador; un equipo de agentes construye, revisa y corrige el proyecto de forma
concurrente. El creador ve el estado en una web y puede cambiar el rumbo mientras el
trabajo avanza.

Estado: las fases 0, 1 y 2 están terminadas. El creador pide algo por el chat, el
orquestador reparte, el builder construye con Claude Code, el reviewer revisa con Codex y
el creador integra desde la web.

## Documentación

| Documento | Contenido |
| --- | --- |
| [01 · Visión y requisitos](docs/01-vision-y-requisitos.md) | Qué se construye, para quién y qué se considera éxito. |
| [02 · Decisiones](docs/02-decisiones.md) | Todas las decisiones tomadas, con su motivo y sus alternativas descartadas. |
| [03 · Arquitectura](docs/03-arquitectura.md) | Componentes, procesos y flujo de información. |
| [04 · Modelo de datos](docs/04-modelo-de-datos.md) | Esquema SQLite completo. |
| [05 · Contratos](docs/05-contratos.md) | Tarea, evento, mensaje, hallazgo y adaptador de motor. |
| [06 · Roles](docs/06-roles.md) | Instrucciones y límites de cada agente. |
| [07 · Flujo de trabajo](docs/07-flujo-de-trabajo.md) | Ciclo de vida de una tarea, reclamación, revisión, integración y Git. |
| [08 · Interfaz web](docs/08-interfaz-web.md) | Pantallas, datos que muestra y criterios de aceptación. |
| [09 · Plan de implementación](docs/09-plan-implementacion.md) | Fases y tareas numeradas con dependencias. |
| [10 · Pruebas de aceptación](docs/10-pruebas-aceptacion.md) | Qué hay que demostrar para dar por buena cada fase. |
| [11 · Capacidades de Claude Code](docs/11-capacidades-claude-code.md) | Qué permite el motor realmente, comprobado en la fase 0. |
| [12 · Guía de arranque](docs/12-guia-de-arranque.md) | Cómo poner el sistema en marcha. Escrita por el propio sistema. |

El documento de partida se conserva en [docs/archivo/](docs/archivo/). No es la
referencia vigente: está superado por los documentos de la tabla.

## Aviso sobre este repositorio

Este repositorio es público. No debe contener credenciales, tokens, rutas de proyectos
privados del creador, volcados de la base de datos ni el contenido de los espacios de
trabajo de los agentes. El fichero `.gitignore` bloquea esas rutas, pero la
responsabilidad de no pegar datos sensibles en la documentación es de quien escribe.

## Motores

Cada rol se ejecuta con el motor que le asigna la constante `ENGINE_POR_ROL` en
`src/core/roles.ts`.

| Rol | Motor |
| --- | --- |
| orchestrator | claude_code |
| builder | claude_code |
| reviewer | codex |
| researcher | claude_code |
