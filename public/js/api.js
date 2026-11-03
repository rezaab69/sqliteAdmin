// Thin client for the server API. Every call is a POST carrying the X-SQLite-Admin header.
import { saveBlob } from './util.js';

const HEADERS = { 'X-SQLite-Admin': '1' };
let authHandler = null;

export class ApiError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.status = status;
    // A machine-readable cause the UI can act on, e.g. 'unverified' for an unconfirmed email address.
    this.reason = reason;
  }
}

export function onAuthRequired(fn) {
  authHandler = fn;
}

async function failure(res) {
  let message = `${res.status} ${res.statusText}`;
  let data = {};
  if ((res.headers.get('content-type') || '').includes('json')) {
    data = await res.json().catch(() => ({}));
    if (data.error) message = data.error;
  }
  if (res.status === 401 && data.loginRequired && authHandler) authHandler();
  return new ApiError(message, res.status, data.reason);
}

/** Call a JSON API method. */
export async function api(name, body = {}) {
  let res;
  try {
    res = await fetch(`/api/${name}`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the server. Is it still running?', 0);
  }
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** Call an API method that returns a file and save it. */
export async function apiDownload(name, body = {}) {
  const res = await fetch(`/api/${name}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="([^"]+)"/i.exec(cd);
  saveBlob(blob, m ? decodeURIComponent(m[1]) : 'download');
  return blob.size;
}

/** Fetch a binary API response as a Blob. */
export async function apiBlob(name, body = {}) {
  const res = await fetch(`/api/${name}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  return res.blob();
}

/** Send a raw body (file or text) with query parameters, reporting upload progress. */
export function apiUpload(name, query, data, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/${name}?${new URLSearchParams(query)}`);
    xhr.setRequestHeader('X-SQLite-Admin', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else {
        if (xhr.status === 401 && body.loginRequired && authHandler) authHandler();
        reject(new ApiError(body.error || `${xhr.status} ${xhr.statusText}`, xhr.status));
      }
    };
    xhr.onerror = () => reject(new ApiError('Upload failed: cannot reach the server', 0));
    xhr.send(data);
  });
}
