// "Get new songs by email": the 🔔 button at the top.
// The address goes to the Cloudflare helper (not GitHub, which is public). Craig's desktop
// publisher emails everyone when a new song is published (not for songs named "Trial …").
// Loaded after app.js, so it can use $, data.

const SUB = (() => {
  const KEY = 'subscribe-v1'; // {email, token} on this device, so we can show "subscribed" and unsubscribe
  const api = () => (data?.community?.api || '').replace(/\/+$/, '');
  const mine = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const save = (v) => { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch {} };

  function paint() {
    const m = mine();
    $('#sub-btn').classList.toggle('on', !!m);
    document.querySelector('.top').classList.toggle('subbed', !!m);
    $('#sub-btn').title = m ? "You're getting new songs by email" : 'Get new songs by email';
    $('#sub-form').hidden = !!m;
    $('#sub-done').hidden = !m;
    if (m) $('#sub-who').textContent = m.email;
  }
  function open() {
    paint();
    $('#sub-msg').textContent = ''; $('#sub-msg2').textContent = '';
    $('#sub-modal').hidden = false;
    document.body.classList.add('modal-open');
    if (!mine()) setTimeout(() => $('#sub-email').focus(), 50);
  }
  function close() {
    $('#sub-modal').hidden = true;
    document.body.classList.remove('modal-open');
  }
  async function post(path, body) {
    const res = await fetch(api() + path, { method: 'POST', body: JSON.stringify(body) }); // text/plain: no preflight
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(out.error || 'Something went wrong. Try again later.');
    return out;
  }

  $('#sub-go').onclick = async () => {
    const email = $('#sub-email').value.trim();
    const name = $('#sub-name').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { $('#sub-msg').textContent = 'Type your email address.'; return; }
    $('#sub-go').disabled = true; $('#sub-go').textContent = 'Signing up…';
    try {
      const out = await post('/subscribe', { email, name });
      save({ email: email.toLowerCase(), token: out.token });
      paint();
      toast(out.already ? "You're already on the list. 👍" : "You're subscribed! 🎉");
    } catch (e) {
      $('#sub-msg').textContent = e.message === 'Failed to fetch' ? "Couldn't connect. Check your internet and try again." : e.message;
    } finally { $('#sub-go').disabled = false; $('#sub-go').textContent = 'Subscribe'; }
  };
  $('#sub-stop').onclick = async () => {
    const m = mine();
    if (!m) return paint();
    $('#sub-stop').disabled = true;
    try {
      await post('/unsubscribe', { token: m.token });
      save(null); paint(); close();
      toast("You're unsubscribed.");
    } catch (e) { $('#sub-msg2').textContent = e.message; } finally { $('#sub-stop').disabled = false; }
  };
  $('#sub-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#sub-go').click(); });
  $('#sub-btn').onclick = open;
  $('#sub-ok').onclick = close;
  $('#sub-close').onclick = close;
  $('#sub-modal').addEventListener('click', (e) => { if (e.target.id === 'sub-modal') close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sub-modal').hidden) close(); });

  function init() {
    const on = !!api();
    $('#sub-btn').hidden = !on;
    document.querySelector('.top').classList.toggle('has-sub', on);
    paint();
    if (on && new URLSearchParams(location.search).has('subscribe')) open(); // a link Craig can send: …/?subscribe
  }
  return { init, open };
})();
