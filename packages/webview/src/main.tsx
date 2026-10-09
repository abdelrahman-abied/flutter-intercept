import { render } from 'preact';
import { App } from './components/App';
import { createVsCodeHost } from './host';
import './styles.css';

function mount() {
  let root = document.getElementById('root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
  }
  render(<App host={createVsCodeHost()} />, root);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
