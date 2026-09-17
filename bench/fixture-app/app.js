const bug = new URLSearchParams(location.search).get('variant') === 'bug';
if (bug) document.body.classList.add('bug');

// 1. Load: the buggy version ignores the first click.
let clicks = 0;
document.getElementById('load-btn').addEventListener('click', () => {
  clicks += 1;
  if (bug && clicks === 1) return;
  document.getElementById('load-result').textContent = 'Loaded 3 items';
});

// 2. Preview: track spans 0–60 s. The buggy version forgets the track's left offset.
const track = document.getElementById('track');
track.addEventListener('mousemove', (e) => {
  const rect = track.getBoundingClientRect();
  const x = bug ? e.clientX : e.clientX - rect.left;
  const seconds = Math.max(0, Math.min(60, Math.round((x / rect.width) * 60)));
  document.getElementById('preview').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
});

// 3. Captions: highlight the word for the current second. The buggy version
// binds to the video before it exists, so nothing ever updates.
function highlight(t) {
  for (const span of document.querySelectorAll('#captions span')) {
    span.classList.toggle('active', Math.floor(t) === Number(span.dataset.start));
  }
}
const earlyVideo = document.getElementById('clip');
const video = document.createElement('video');
video.id = 'clip';
video.src = 'clip.mp4';
video.preload = 'auto';
video.controls = true;
video.width = 320;
if (bug) {
  earlyVideo?.addEventListener('timeupdate', () => highlight(earlyVideo.currentTime));
} else {
  const sync = () => highlight(video.currentTime);
  video.addEventListener('timeupdate', sync);
  video.addEventListener('seeked', sync);
}
document.getElementById('player-slot').append(video);

// 4. Toolbar: styling only (body.bug disables wrapping).

// 5. Form: the buggy version reads a field that does not exist.
document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = bug ? document.getElementById('e-mail').value : document.getElementById('email').value;
  if (email) document.getElementById('form-status').textContent = 'Saved';
});
