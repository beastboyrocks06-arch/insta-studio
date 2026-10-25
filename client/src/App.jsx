import { useCallback, useEffect, useState } from 'react';

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    credentials: 'include',
    ...opts,
    headers: { ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...opts.headers },
  });
  if (res.status === 401) throw Object.assign(new Error('Please sign in again.'), { status: 401 });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { body });
  return body;
};

const mediaTypes = [
  { id: 'REELS', label: 'Reel', accept: 'video/*', multiple: false, help: 'Choose one video file.' },
  { id: 'IMAGE', label: 'Image', accept: 'image/*', multiple: false, help: 'Choose one image file.' },
  { id: 'CAROUSEL', label: 'Carousel', accept: 'image/*', multiple: true, help: 'Choose 2–10 images.' },
];

function saveCsv(filename, rows) {
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const content = [['date', 'account', 'mediaType', 'postUrl', 'mediaId'], ...rows.map((row) => [
    row.date || new Date().toISOString(), row.username, row.mediaType, row.postUrl, row.mediaId,
  ])].map((row) => row.map(escape).join(',')).join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [page, setPage] = useState('posts');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [mediaType, setMediaType] = useState('REELS');
  const [files, setFiles] = useState([]);
  const [caption, setCaption] = useState('');
  const [selectedAccounts, setSelectedAccounts] = useState([]);
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState(null);
  const [results, setResults] = useState([]);

  const loadStatus = useCallback(async () => {
    const next = await api('/api/auth/status');
    setStatus(next);
    setSelectedAccounts((current) => current.filter((id) => next.accounts.some((account) => account.id === id)));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('connected')) {
      setMessage({ type: 'success', text: 'Instagram account connected.' });
      window.history.replaceState({}, '', '/');
    } else if (params.has('error')) {
      setMessage({ type: 'error', text: params.get('error') });
      window.history.replaceState({}, '', '/');
    }
    loadStatus().catch((error) => setMessage({ type: 'error', text: error.message }));
  }, [loadStatus]);

  async function login(event) {
    event.preventDefault();
    setLoginBusy(true);
    setMessage(null);
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      setPassword('');
      await loadStatus();
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      setStatus((current) => ({ ...current, authenticated: false, accounts: [] }));
      setSelectedAccounts([]);
      setMessage(null);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  }

  async function disconnectAccount(account) {
    try {
      await api(`/api/auth/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
      await loadStatus();
      setMessage({ type: 'success', text: `@${account.username} disconnected.` });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  }

  function toggleAccount(id) {
    setSelectedAccounts((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  async function uploadFile(file) {
    const resourceType = file.type.startsWith('video/') ? 'video' : 'image';
    const signed = await api('/api/media/signature', {
      method: 'POST',
      body: JSON.stringify({ resourceType }),
    });
    const data = new FormData();
    data.append('file', file);
    data.append('api_key', signed.apiKey);
    data.append('timestamp', String(signed.timestamp));
    data.append('folder', signed.folder);
    data.append('signature', signed.signature);
    const response = await fetch(`https://api.cloudinary.com/v1_1/${signed.cloudName}/${resourceType}/upload`, {
      method: 'POST',
      body: data,
    });
    const uploaded = await response.json().catch(() => ({}));
    if (!response.ok || !uploaded.secure_url) throw new Error(uploaded.error?.message || 'Cloudinary upload failed.');
    return uploaded.secure_url;
  }

  async function publish(event) {
    event.preventDefault();
    if (!files.length || !selectedAccounts.length) return;
    setPublishing(true);
    setResults([]);
    setMessage({ type: 'info', text: 'Uploading media and publishing to the selected accounts…' });
    try {
      const mediaUrls = await Promise.all(files.map(uploadFile));
      const response = await api('/api/instagram/publish', {
        method: 'POST',
        body: JSON.stringify({ mediaType, mediaUrls, caption, accountIds: selectedAccounts }),
      });
      setResults(response.results);
      const successes = response.results.filter((result) => result.ok);
      if (successes.length) saveCsv('instagram-published-posts.csv', successes);
      const historyWarning = successes.find((result) => result.error)?.error;
      setMessage({
        type: response.results.every((result) => result.ok) ? 'success' : 'error',
        text: `${successes.length} of ${response.results.length} account(s) published successfully.${successes.length ? ' A CSV of this publish run was downloaded.' : ''}${historyWarning ? ` ${historyWarning}` : ''}`,
      });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setPublishing(false);
      loadStatus().catch(() => {});
    }
  }

  if (!status) return <main className="loading">Loading publisher…</main>;

  if (!status.authenticated) {
    return (
      <main className="login-layout">
        <section className="login-card">
          <div className="brand-mark">ig</div>
          <p className="eyebrow">PRIVATE PUBLISHING WORKSPACE</p>
          <h1>Welcome back</h1>
          <p className="muted">Sign in to manage your Instagram publishing.</p>
          {message && <div className={`notice ${message.type}`}>{message.text}</div>}
          <form onSubmit={login}>
            <label>Username<input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
            <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <button className="button primary full" disabled={loginBusy}>{loginBusy ? 'Signing in…' : 'Sign in'}</button>
          </form>
          {status.authConfigProblems.length > 0 && <p className="setup-note">Set APP_USERNAME and APP_PASSWORD in the server .env file to enable sign in.</p>}
        </section>
      </main>
    );
  }

  const media = mediaTypes.find((type) => type.id === mediaType);
  const selectedFiles = Array.from(files);
  const canPublish = !publishing && selectedAccounts.length > 0 && selectedFiles.length > 0
    && (mediaType !== 'CAROUSEL' || (selectedFiles.length >= 2 && selectedFiles.length <= 10));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage('posts'); }}><span className="brand-mark">ig</span><span>Studio<span className="brand-sub">PUBLISHER</span></span></a>
        <p className="nav-label">WORKSPACE</p>
        <button className={`nav-item ${page === 'posts' ? 'active' : ''}`} onClick={() => setPage('posts')}><span>↗</span> Create post</button>
        <button className={`nav-item ${page === 'accounts' ? 'active' : ''}`} onClick={() => setPage('accounts')}><span>◎</span> Accounts <span className="count">{status.accounts.length}</span></button>
        <div className="sidebar-bottom">
          <div className="profile-badge"><span className="avatar">U</span><span><strong>{status.displayName}</strong><small>Workspace owner</small></span></div>
          <button className="logout-button" onClick={logout}>Log out <span>↗</span></button>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">SOCIAL MEDIA / {page === 'posts' ? 'COMPOSER' : 'CONNECTED PROFILES'}</p><h1>{page === 'posts' ? 'Create a post' : 'Accounts'}</h1></div>
          <div className="topbar-right"><span className="secure-dot" /> Private workspace</div>
        </header>
        {message && <div className={`notice ${message.type}`}>{message.text}</div>}
        {page === 'accounts' ? (
          <section className="content-card account-card">
            <div className="card-heading"><div><p className="eyebrow">INSTAGRAM PROFILES</p><h2>Manage accounts</h2><p className="muted">Connect professional Instagram profiles to publish to them.</p></div><a className="button primary" href="/api/auth/instagram/login">＋ Connect account</a></div>
            {!status.accounts.length ? <div className="empty-state"><span>◎</span><h3>No accounts connected</h3><p>Connect an Instagram Business or Creator profile to get started.</p></div> : (
              <div className="account-list">{status.accounts.map((account) => <div className="account-row" key={account.id}><span className="account-avatar">{account.username.slice(0, 1).toUpperCase()}</span><div className="account-details"><strong>@{account.username}</strong><small>Instagram professional account · ID {account.id}</small></div><span className="connected-label"><span className="secure-dot" /> Connected</span><button className="text-button" onClick={() => disconnectAccount(account)}>Disconnect</button></div>)}</div>
            )}
            <div className="csv-history"><div><strong>Publishing history</strong><p className="muted">Download the append-only CSV log of published post URLs.</p></div><a className="button secondary" href="/api/instagram/history.csv">Download history CSV</a></div>
          </section>
        ) : (
          <form className="composer-grid" onSubmit={publish}>
            <div className="composer-main">
              <section className="content-card">
                <div className="section-title"><span className="step">01</span><div><h2>Choose a format</h2><p className="muted">Select the kind of post you want to share.</p></div></div>
                <div className="format-options">{mediaTypes.map((type) => <button type="button" key={type.id} className={`format-option ${mediaType === type.id ? 'selected' : ''}`} onClick={() => { setMediaType(type.id); setFiles([]); }}><span className="format-icon">{type.id === 'REELS' ? '▶' : type.id === 'IMAGE' ? '▧' : '▦'}</span><span><strong>{type.label}</strong><small>{type.id === 'REELS' ? 'Short-form video' : type.id === 'IMAGE' ? 'Single photo' : 'Multiple photos'}</small></span>{mediaType === type.id && <span className="radio-dot" />}</button>)}</div>
              </section>
              <section className="content-card">
                <div className="section-title"><span className="step">02</span><div><h2>Add your media</h2><p className="muted">Files are securely uploaded to Cloudinary before publishing.</p></div></div>
                <label className="upload-zone"><input type="file" accept={media.accept} multiple={media.multiple} onChange={(event) => setFiles(event.target.files)} /><span className="upload-icon">↑</span><strong>Choose {mediaType === 'CAROUSEL' ? 'images' : mediaType === 'REELS' ? 'a video' : 'an image'}</strong><span className="muted">{media.help}</span><span className="upload-link">Browse files</span></label>
                {selectedFiles.length > 0 && <ul className="file-list">{selectedFiles.map((file) => <li key={`${file.name}-${file.size}`}>▧ <span>{file.name}</span><small>{(file.size / (1024 * 1024)).toFixed(1)} MB</small></li>)}</ul>}
              </section>
              <section className="content-card">
                <div className="section-title"><span className="step">03</span><div><h2>Write a caption</h2><p className="muted">Share the story behind your post.</p></div></div>
                <textarea className="caption-input" rows="5" maxLength="2200" value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Write a caption… add hashtags or mention someone" />
                <div className="character-count">{caption.length} / 2,200</div>
              </section>
            </div>
            <aside className="composer-side">
              <section className="content-card account-picker">
                <div className="side-title"><div><span className="step">04</span><h2>Publish to</h2></div><button type="button" className="text-button" disabled={!status.accounts.length} onClick={() => setSelectedAccounts(selectedAccounts.length === status.accounts.length ? [] : status.accounts.map((account) => account.id))}>{selectedAccounts.length === status.accounts.length && status.accounts.length ? 'Clear' : 'Select all'}</button></div>
                <p className="muted">Choose one or more accounts.</p>
                {!status.accounts.length ? <div className="inline-empty">No accounts yet. <a href="/api/auth/instagram/login">Connect Instagram</a></div> : status.accounts.map((account) => <label className="account-choice" key={account.id}><input type="checkbox" checked={selectedAccounts.includes(account.id)} onChange={() => toggleAccount(account.id)} /><span className="account-avatar small">{account.username.slice(0, 1).toUpperCase()}</span><span>@{account.username}</span></label>)}
                <div className="publish-divider" />
                <button className="button primary full publish-button" disabled={!canPublish}>{publishing ? 'Publishing…' : 'Publish now'} <span>↗</span></button>
                <p className="publish-note">Your post will be published to {selectedAccounts.length} {selectedAccounts.length === 1 ? 'account' : 'accounts'}.</p>
              </section>
              {results.length > 0 && <section className="content-card publish-results"><h2>Publish results</h2>{results.map((result) => <div key={result.accountId} className="result-row"><span className={result.ok ? 'result-ok' : 'result-fail'}>{result.ok ? '✓' : '!'}</span><span>@{result.username}</span>{result.postUrl && <a href={result.postUrl} target="_blank" rel="noreferrer">View post ↗</a>}<small>{result.error || ''}</small></div>)}</section>}
            </aside>
          </form>
        )}
      </main>
    </div>
  );
}
