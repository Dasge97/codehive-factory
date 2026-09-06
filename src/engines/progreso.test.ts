import { describe, it, expect } from 'vitest';
import { describirResultado, describirUsoDeHerramienta, nombreCorto, recortar } from './progreso.js';

describe('descripción del uso de una herramienta', () => {
  it('dice qué fichero toca, no el objeto entero de argumentos', () => {
    expect(describirUsoDeHerramienta('Read', { file_path: 'C:/proyecto/src/core/roles.ts' })).toBe(
      'lee core/roles.ts',
    );
    expect(describirUsoDeHerramienta('Write', { file_path: 'src/a.ts', content: 'x'.repeat(5000) })).toBe(
      'escribe src/a.ts',
    );
    expect(describirUsoDeHerramienta('Edit', { file_path: 'src/b.ts' })).toBe('edita src/b.ts');
  });

  it('con Bash dice el comando', () => {
    expect(describirUsoDeHerramienta('Bash', { command: 'npm test' })).toBe('npm test');
  });

  it('un comando largo se recorta a lo que cabe', () => {
    const largo = describirUsoDeHerramienta('Bash', { command: 'git log '.repeat(40) });
    expect(largo.length).toBeLessThanOrEqual(101);
    expect(largo.endsWith('…')).toBe(true);
  });

  it('con las búsquedas dice qué busca', () => {
    expect(describirUsoDeHerramienta('Glob', { pattern: '**/*.ts' })).toBe('busca ficheros **/*.ts');
    expect(describirUsoDeHerramienta('Grep', { pattern: 'validarNombre' })).toBe('busca validarNombre');
  });

  it('sin argumentos útiles dice al menos qué herramienta usa', () => {
    expect(describirUsoDeHerramienta('Read', {})).toBe('lee un fichero');
    expect(describirUsoDeHerramienta('HerramientaRara', {})).toBe('usa HerramientaRara');
  });

  it('una herramienta desconocida con un texto corto lo enseña', () => {
    expect(describirUsoDeHerramienta('aihub.ocr', { archivo: 'factura.pdf' })).toBe(
      'aihub.ocr: factura.pdf',
    );
  });

  it('la entrega del resultado no vuelca el resumen entero', () => {
    const texto = describirUsoDeHerramienta('StructuredOutput', {
      outcome: 'completed',
      summary: '## Puntos del código\n'.repeat(200),
    });
    expect(texto).toBe('entrega su resultado');
  });

  it('ninguna descripción pasa de lo que cabe en el panel', () => {
    const largo = describirUsoDeHerramienta('HerramientaRara', { dato: 'x'.repeat(119) });
    expect(largo.length).toBeLessThanOrEqual(141);
  });

  it('nunca devuelve el objeto entero de argumentos', () => {
    const texto = describirUsoDeHerramienta('Write', {
      file_path: 'src/a.ts',
      content: 'una línea\n'.repeat(500),
    });
    expect(texto).not.toContain('{');
    expect(texto.length).toBeLessThan(60);
  });
});

describe('nombre corto de un fichero', () => {
  it('deja la carpeta y el nombre, no la ruta del disco', () => {
    expect(nombreCorto('C:\\AreaDeTrabajo\\proyecto\\src\\core\\db.ts')).toBe('core/db.ts');
    expect(nombreCorto('/home/x/proyecto/README.md')).toBe('proyecto/README.md');
    expect(nombreCorto('README.md')).toBe('README.md');
  });
});

describe('recorte de texto', () => {
  it('deja intacto lo que ya cabe', () => {
    expect(recortar('corto', 20)).toBe('corto');
  });

  it('corta por un espacio cuando puede', () => {
    expect(recortar('una frase bastante larga que no cabe', 20)).toBe('una frase bastante…');
  });

  it('junta los espacios y saltos de línea', () => {
    expect(recortar('con   varios\n\nespacios', 40)).toBe('con varios espacios');
  });
});

describe('resumen de un resultado', () => {
  it('una salida corta se enseña entera', () => {
    expect(describirResultado('todo correcto', false)).toBe('todo correcto');
  });

  it('una salida de muchas líneas dice cuántas son', () => {
    const resultado = describirResultado('línea\n'.repeat(50), false);
    expect(resultado).toContain('51 líneas');
  });

  it('un error se enseña con su mensaje', () => {
    expect(describirResultado('Permission denied', true)).toBe('Permission denied');
  });

  it('un fallo sin salida se explica igual', () => {
    expect(describirResultado('   ', true)).toBe('falla sin decir por qué');
  });
});
