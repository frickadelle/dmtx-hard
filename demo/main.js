import { scanBlob } from '../dist/dmtx-hard.js';

const drop = document.getElementById('drop');
const file = document.getElementById('file');
const preview = document.getElementById('preview');
const results = document.getElementById('results');
const status = document.getElementById('status');

async function handle(f) {
  results.innerHTML = '';
  status.textContent = 'scanne …';
  preview.src = URL.createObjectURL(f);
  preview.hidden = false;
  const t0 = performance.now();
  try {
    const hits = await scanBlob(f);
    const ms = Math.round(performance.now() - t0);
    status.textContent = `${ms} ms`;
    results.innerHTML = hits.length
      ? hits.map((h) => `<div class="hit">${h.text} <small>[${h.source}${h.recipe ? ' ' + h.recipe : ''}]</small></div>`).join('')
      : '<div class="miss">kein DataMatrix gefunden</div>';
  } catch (e) {
    status.textContent = 'Fehler: ' + e.message;
  }
}

drop.addEventListener('click', () => file.click());
file.addEventListener('change', () => file.files[0] && handle(file.files[0]));
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]);
});
