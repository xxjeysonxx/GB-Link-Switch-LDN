// Pega tu URL en localStorage desde la consola del navegador (una sola vez):
//   localStorage.setItem('discordWebhook', 'https://discord.com/api/webhooks/...')
// así no queda escrita en el código ni en git.
const buf = [];

export const discordLog = (line) => buf.push(line);

async function flush() {
  const url = localStorage.getItem('discordWebhook');
  if (!url || !buf.length) return;
  const text = buf.splice(0).join('\n');
  for (let i = 0; i < text.length; i += 1900) {
    const content = '```\n' + text.slice(i, i + 1900) + '\n```';
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (r.status === 429) {
        const { retry_after } = await r.json();
        await new Promise((ok) => setTimeout(ok, retry_after * 1000));
        i -= 1900; // reintenta este trozo
      }
    } catch {}
  }
}

setInterval(flush, 2000);