// The firmware bundled with the page: firmware/manifest.json, written by
// firmware/tools/package_web.py.

export async function loadManifest(url = 'firmware/manifest.json') {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`No se pudo cargar la lista de firmware (HTTP ${response.status}).`);
    const manifest = await response.json();
    manifest.base = new URL('.', new URL(url, location.href)).href;
    return manifest;
}

export async function fetchBytes(url) {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`No se pudo descargar ${url} (HTTP ${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
}
