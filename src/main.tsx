import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// The whole visual layer in one plain stylesheet (no CSS-in-JS in this package — the
// component libraries and @emotion were removed for the rebuild). Imported once, here, so
// there is exactly one place that decides what the shipped bundle looks like.
import './dashboard/styles/app.css';

const container = document.getElementById('root');

if (!container) {
    // A missing #root is a broken index.html, not a runtime condition to recover from;
    // failing loudly beats a blank page that looks like a stalled loop (L-24).
    throw new Error('Storyline needs a #root element in index.html');
}

createRoot(container).render(
    <StrictMode>
        <App />
    </StrictMode>
);
