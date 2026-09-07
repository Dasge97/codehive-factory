import { describe, it, expect } from 'vitest';
import { ficherosProtegidos, motivoDeBloqueo, rutaProtegida } from './protected-paths.js';

describe('coincidencia de una ruta con un patrón protegido', () => {
  it('un nombre de fichero protege ese fichero y nada más', () => {
    expect(rutaProtegida('package-lock.json', ['package-lock.json'])).toBe('package-lock.json');
    expect(rutaProtegida('package.json', ['package-lock.json'])).toBeNull();
  });

  it('un nombre de carpeta protege todo lo que hay dentro', () => {
    expect(rutaProtegida('.github/workflows/publica.yml', ['.github'])).toBe('.github');
  });

  it('dos asteriscos cubren cualquier número de carpetas', () => {
    expect(rutaProtegida('.github/workflows/publica.yml', ['.github/**'])).toBe('.github/**');
    expect(rutaProtegida('.github/CODEOWNERS', ['.github/**'])).toBe('.github/**');
  });

  it('un asterisco solo no salta de carpeta', () => {
    expect(rutaProtegida('src/db.ts', ['src/*.ts'])).toBe('src/*.ts');
    expect(rutaProtegida('src/core/db.ts', ['src/*.ts'])).toBeNull();
  });

  it('las barras invertidas de Windows se tratan como barras normales', () => {
    expect(rutaProtegida('.github\\workflows\\publica.yml', ['.github/**'])).toBe('.github/**');
  });

  it('un patrón que empieza por dos asteriscos alcanza también la raíz', () => {
    expect(rutaProtegida('secreto.env', ['**/secreto.env'])).toBe('**/secreto.env');
    expect(rutaProtegida('config/secreto.env', ['**/secreto.env'])).toBe('**/secreto.env');
  });

  it('sin patrones no hay nada protegido', () => {
    expect(ficherosProtegidos(['cualquier/cosa.ts'], [])).toEqual([]);
  });
});

describe('ficheros de un cambio que tocan lo protegido', () => {
  const patrones = ['package-lock.json', '.github/**'];

  it('devuelve solo los ficheros protegidos, con el patrón que los cubre', () => {
    const tocados = ficherosProtegidos(
      ['src/app.ts', 'package-lock.json', '.github/workflows/ci.yml', 'README.md'],
      patrones,
    );
    expect(tocados).toEqual([
      { file: 'package-lock.json', pattern: 'package-lock.json' },
      { file: '.github/workflows/ci.yml', pattern: '.github/**' },
    ]);
  });

  it('un cambio que no toca nada protegido devuelve la lista vacía', () => {
    expect(ficherosProtegidos(['src/app.ts', 'README.md'], patrones)).toEqual([]);
  });

  it('el motivo nombra el fichero y el patrón, para que se entienda sin mirar el código', () => {
    const motivo = motivoDeBloqueo(ficherosProtegidos(['package-lock.json'], patrones));
    expect(motivo).toContain('package-lock.json');
    expect(motivo).toContain('no se ha publicado');
  });
});
