import { render } from 'preact';
import { App } from './components/App';
import { createHost, scrubTokenFromAddressBar, wsUrl } from './host';
import './styles.css';

function mount() {
  let root = document.getElementById('root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
  }
  // Android Studio / IntelliJ (CONTRACTS §15.1): the sidecar page sets body.fi-ide too; added here in case it didn't.
  if (wsUrl()) {
    document.body.classList.add('fi-ide');
    scrubTokenFromAddressBar();
  }
  render(<App host={createHost()} />, root);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
