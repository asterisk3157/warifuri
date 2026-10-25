// The one-time login page. The token comes after the # of the URL that `warifuri serve`
// printed, so it never reaches a proxy or a server log. This posts it back once, drops it
// from the address bar and history, and goes on to the calendar.

const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
history.replaceState(null, '', location.pathname);

const say = (title, text) => {
  document.getElementById('title').textContent = title;
  document.getElementById('text').textContent = text;
};

const refused = () =>
  say('ログインできません', 'この URL は使えません。1回だけ、15分まで使えます。warifuri serve を動かし直すと、新しい URL を表示します。');

if (!token) {
  refused();
} else {
  fetch('/web/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
    .then(async (res) => {
      if (!res.ok) return refused();
      const { next } = await res.json();
      location.replace(next);
    })
    .catch(() => say('ログインできません', 'warifuri サーバーに届きませんでした。サーバーが動いているかを確かめて、もう一度開いてください。'));
}
