import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Cada prueba empieza con el árbol vacío, para que una no arrastre el estado de otra.
afterEach(() => {
  cleanup();
});
