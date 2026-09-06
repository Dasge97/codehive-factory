import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const raiz = document.getElementById('raiz');
if (!raiz) throw new Error('Falta el elemento raíz en la página.');

createRoot(raiz).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
