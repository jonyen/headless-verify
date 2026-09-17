// Snippet tables used to render bench/fixture-app/app.template.js and
// styles.template.css into the served app.js/styles.css for each variant.
// This module is never served — only bench/server.mjs imports it — so it is
// the one place that may name variants and describe their differences.

const okCaptionsSetup = `const video = document.createElement('video');
video.id = 'clip';
video.src = 'clip.mp4';
video.preload = 'auto';
video.controls = true;
video.width = 320;
const sync = () => highlight(video.currentTime);
video.addEventListener('timeupdate', sync);
video.addEventListener('seeked', sync);
document.getElementById('player-slot').append(video);`;

const brokenCaptionsSetup = `const earlyVideo = document.getElementById('clip');
const video = document.createElement('video');
video.id = 'clip';
video.src = 'clip.mp4';
video.preload = 'auto';
video.controls = true;
video.width = 320;
earlyVideo?.addEventListener('timeupdate', () => highlight(earlyVideo.currentTime));
document.getElementById('player-slot').append(video);`;

export const variants = {
  ok: {
    loadHandler: "  document.getElementById('load-result').textContent = 'Loaded 3 items';",
    previewX: 'e.clientX - rect.left',
    captionsSetup: okCaptionsSetup,
    emailId: 'email',
    toolbarWrap: 'wrap',
  },
  bug: {
    // Widget 1: the first click is silently swallowed.
    loadHandler: "  if (clickCount === 1) return;\n  document.getElementById('load-result').textContent = 'Loaded 3 items';",
    // Widget 2: the track's left offset is never subtracted from clientX.
    previewX: 'e.clientX',
    // Widget 3: the timeupdate listener is bound to a lookup taken before
    // the <video> element is inserted into the DOM, so it binds to null.
    captionsSetup: brokenCaptionsSetup,
    // Widget 5: the handler reads a field id that does not exist.
    emailId: 'e-mail',
    // Widget 4: wrapping is disabled, so the last item overflows the toolbar.
    toolbarWrap: 'nowrap',
  },
};
