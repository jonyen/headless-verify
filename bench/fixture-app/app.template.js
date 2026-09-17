// 1. Load.
let clickCount = 0;
document.getElementById('load-btn').addEventListener('click', () => {
  clickCount += 1;
{{LOAD_HANDLER}}
});

// 2. Timeline: track spans 0-60 s.
const track = document.getElementById('track');
track.addEventListener('mousemove', (e) => {
  const rect = track.getBoundingClientRect();
  const x = {{PREVIEW_X}};
  const seconds = Math.max(0, Math.min(60, Math.round((x / rect.width) * 60)));
  document.getElementById('preview').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
});

// 3. Captions: highlight the word for the current second.
function highlight(t) {
  for (const span of document.querySelectorAll('#captions span')) {
    span.classList.toggle('active', Math.floor(t) === Number(span.dataset.start));
  }
}
{{CAPTIONS_SETUP}}

// 4. Toolbar: styling only, see styles.css.

// 5. Subscribe form.
document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = document.getElementById('{{EMAIL_ID}}').value;
  if (email) document.getElementById('form-status').textContent = 'Saved';
});
