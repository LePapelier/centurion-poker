import './styles.css';
import { App } from './ui/app.js';

const app = new App();
app.mount();

// Point d'entrée pour inspecter une partie depuis la console du navigateur.
if (import.meta.env.DEV) window.__poker = app;
