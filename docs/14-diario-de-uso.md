# 14 · Diario de uso

Registro de la fase 6 del documento 13: Code Hive Factory trabajando sobre un proyecto
real del creador. Cada entrada dice qué se pidió, qué hizo el sistema, qué tuvo que hacer
una persona, y qué se cambia en el sistema por ello. Las incidencias graves se marcan como
tales: algo llegó a la rama principal sin revisión, se perdió trabajo, o hubo que tocar la
base de datos a mano.

Proyecto: **saas-peluqueria**, un SaaS de reservas en Symfony 7.4 con PostgreSQL y Redis,
920 pruebas. Configuración en su `codehive.project.json`: verificación con
`php bin/phpunit`, una sola ejecución a la vez, 40 minutos de tope por ejecución.

## 9 de septiembre de 2026 · día 1

**Antes de empezar.** La batería pasa desde esta máquina en siete minutos contra los
contenedores del proyecto, con el PHP 8.5 local y la extensión `redis` ignorada en la
instalación. `composer stan` y `composer cs:check` fallan en `main` (tres errores de
análisis y cuatro ficheros de estilo), así que la verificación se queda en las pruebas y
la cadena de calidad completa es trabajo pendiente para el propio sistema.

**Ronda 1 · cada worktree con su propia base de pruebas.** Pedida por el chat a las 14:33.

- El orquestador leyó `config/packages/doctrine.yaml`, vio que ya existía un sufijo
  `TEST_TOKEN` para el nombre de la base, y creó una sola tarea con ese plan. Acertó.
- El builder tardó 27 minutos: escribió `tests/Support/WorktreeDatabase.php`, su prueba
  unitaria y el cambio en `tests/bootstrap.php`, ejecutó la batería entera y publicó un
  commit. Su resumen decía que las pruebas pasaban con código 0; en realidad había mirado
  el código de salida de `tail`, no el de PHPUnit.
- La verificación del sistema, ejecutada después en el mismo worktree, **no pasó**. La
  causa, averiguada después a mano: `phpunit.dist.xml` tiene `failOnDeprecation` y PHP
  8.5 marca obsoleta `imagedestroy()`, que llaman tres pruebas. Las 925 pruebas pasan, y
  el comando termina con código 1. En `main` pasa lo mismo; en el CI con PHP 8.4 no.
- El reviewer investigó a fondo: comprobó qué base usaba cada proceso, borró la base del
  worktree y volvió a ejecutar la batería desde cero. Su primer intento **se agotó a los
  40 minutos** (tres ejecuciones de la batería). El segundo intento retomó la sesión y
  aprobó en dos minutos, con un argumento correcto: los fallos que veía no eran del
  commit. Coste del reviewer: 0,97 dólares el intento que terminó; el agotado no informa.
- Al terminar, el reviewer había **vaciado la carpeta `vendor` del worktree** con una
  orden de limpieza de Git. El sistema solo instalaba dependencias al crear el worktree,
  así que el siguiente intento del builder se habría quedado sin ellas.
- La tarea quedó integrable. **No se integró**: con el código de salida 1 de PHPUnit en
  PHP 8.5, la integración habría fallado la verificación y deshecho la fusión.

**Qué tuvo que hacer una persona.** Reproducir la verificación fallida a mano para
entender la causa (el aviso solo decía «no pasa»), y reinstalar `vendor` en el worktree.

**Qué se cambia en el sistema.**

- El comando de instalación se ejecuta antes de cada ejecución, también antes de una
  revisión, y su fallo queda como aviso.
- El aviso de verificación fallida lleva el final de la salida del comando.
- El encargo del reviewer lleva lo que midió el sistema sobre el incremento, con la regla
  de que un fallo de verificación es un hallazgo salvo demostración en contra.
- El reviewer tiene prohibido borrar nada del worktree del builder.

**Qué se pide al proyecto.** Ronda 2: quitar las tres llamadas a `imagedestroy()`, para que
la batería termine con código 0 en PHP 8.5. Hasta que entre en `main`, ninguna tarea de
este proyecto puede integrarse desde esta máquina.

**Incidencias graves:** ninguna.
