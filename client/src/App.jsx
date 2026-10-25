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
  { id: 'REELS', label: 'Reels', accept: 'video/*', multiple: true, help: 'Choose up to 5 videos. Each publishes as a separate Reel.' },
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
  const [statusError, setStatusError] = useState(null);
  const [page, setPage] = useState('posts');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [mediaType, setMediaType] = useState('REELS');
  const [files, setFiles] = useState([]);
  const [videoAccounts, setVideoAccounts] = useState([]);
  const [caption, setCaption] = useState('');
  const [selectedAccounts, setSelectedAccounts] = useState([]);
  const [publishing, setPublishing] = useState(false);
  const [publishedFrom, setPublishedFrom] = useState('');
  const [publishedTo, setPublishedTo] = useState('');
  const [message, setMessage] = useState(null);
  const [results, setResults] = useState([]);

  const loadStatus = useCallback(async () => {
    const next = await api('/api/auth/status');
    setStatus(next);
    setSelectedAccounts((current) => current.filter((id) => next.accounts.some((account) => account.id === id)));
    setVideoAccounts((current) => current.map((ids) => ids.filter((id) => next.accounts.some((account) => account.id === id))));
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
    loadStatus().catch((error) => setStatusError(error.message));
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

  function toggleVideoAccount(videoIndex, id) {
    setVideoAccounts((current) => current.map((accountIds, index) => index !== videoIndex
      ? accountIds
      : accountIds.includes(id) ? accountIds.filter((value) => value !== id) : [...accountIds, id]));
  }

  function setVideoAccountsForAll(videoIndex, accountIds) {
    setVideoAccounts((current) => current.map((selected, index) => index === videoIndex ? accountIds : selected));
  }

  function selectFiles(fileList) {
    const selected = Array.from(fileList || []);
    if (mediaType === 'REELS' && selected.length > 5) {
      setFiles([]);
      setVideoAccounts([]);
      setMessage({ type: 'error', text: 'Choose no more than 5 videos at a time.' });
      return;
    }
    const expectedType = mediaType === 'REELS' ? 'video/' : 'image/';
    if (selected.some((file) => !file.type.startsWith(expectedType))) {
      setFiles([]);
      setVideoAccounts([]);
      setMessage({ type: 'error', text: `Choose ${mediaType === 'REELS' ? 'video' : 'image'} files for this post type.` });
      return;
    }
    setFiles(selected);
    setVideoAccounts(mediaType === 'REELS' ? selected.map(() => [...selectedAccounts]) : []);
    setMessage(null);
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
    const hasPublishTargets = mediaType === 'REELS'
      ? videoAccounts.length === files.length && videoAccounts.every((accountIds) => accountIds.length > 0)
      : selectedAccounts.length > 0;
    if (!files.length || !hasPublishTargets) return;
    setPublishing(true);
    setResults([]);
    setMessage({ type: 'info', text: 'Uploading media and publishing to the selected accounts…' });
    try {
      const mediaUrls = await Promise.all(files.map(uploadFile));
      const payload = mediaType === 'REELS'
        ? { mediaType, videos: mediaUrls.map((mediaUrl, index) => ({ mediaUrl, accountIds: videoAccounts[index] })), caption }
        : { mediaType, mediaUrls, caption, accountIds: selectedAccounts };
      const response = await api('/api/instagram/publish', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setResults(response.results);
      const successes = response.results.filter((result) => result.ok);
      if (successes.length) saveCsv('instagram-published-posts.csv', successes);
      const historyWarning = successes.find((result) => result.error)?.error;
      setMessage({
        type: response.results.every((result) => result.ok) ? 'success' : 'error',
        text: `${successes.length} of ${response.results.length} post(s) published successfully.${successes.length ? ' A CSV of this publish run was downloaded.' : ''}${historyWarning ? ` ${historyWarning}` : ''}`,
      });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setPublishing(false);
      loadStatus().catch(() => {});
    }
  }

  if (!status) return <main className="loading">{statusError ? `Publisher unavailable: ${statusError}` : 'Loading publisher…'}</main>;

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
  const videoAssignmentsComplete = videoAccounts.length === selectedFiles.length
    && videoAccounts.every((accountIds) => accountIds.length > 0);
  const publishTargetCount = mediaType === 'REELS'
    ? videoAccounts.reduce((total, accountIds) => total + accountIds.length, 0)
    : selectedAccounts.length;
  const canPublish = !publishing && (mediaType === 'REELS' ? videoAssignmentsComplete : selectedAccounts.length > 0) && selectedFiles.length > 0
    && (mediaType === 'REELS' ? selectedFiles.length <= 5
      : mediaType !== 'CAROUSEL' || (selectedFiles.length >= 2 && selectedFiles.length <= 10));
  const historyParams = new URLSearchParams();
  if (publishedFrom) historyParams.set('from', publishedFrom);
  if (publishedTo) historyParams.set('to', publishedTo);
  const historyQuery = historyParams.toString();
  const historyUrl = `/api/instagram/history.csv${historyQuery ? `?${historyQuery}` : ''}`;

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
            <div className="csv-history">
              <div className="csv-history-copy"><strong>Publishing history</strong><p className="muted">Download published posts within a date range.</p></div>
              <div className="csv-history-controls">
                <label>From<input type="date" max={publishedTo || undefined} value={publishedFrom} onChange={(event) => setPublishedFrom(event.target.value)} /></label>
                <label>To<input type="date" min={publishedFrom || undefined} value={publishedTo} onChange={(event) => setPublishedTo(event.target.value)} /></label>
                <a className="button secondary" href={historyUrl}>Download CSV</a>
              </div>
            </div>
          </section>
        ) : (
          <form className="composer-grid" onSubmit={publish}>
            <div className="composer-main">
              <section className="content-card">
                <div className="section-title"><span className="step">01</span><div><h2>Choose a format</h2><p className="muted">Select the kind of post you want to share.</p></div></div>
                <div className="format-options">{mediaTypes.map((type) => <button type="button" key={type.id} className={`format-option ${mediaType === type.id ? 'selected' : ''}`} onClick={() => { setMediaType(type.id); setFiles([]); setVideoAccounts([]); }}><span className="format-icon">{type.id === 'REELS' ? '▶' : type.id === 'IMAGE' ? '▧' : '▦'}</span><span><strong>{type.label}</strong><small>{type.id === 'REELS' ? 'Short-form video' : type.id === 'IMAGE' ? 'Single photo' : 'Multiple photos'}</small></span>{mediaType === type.id && <span className="radio-dot" />}</button>)}</div>
              </section>
              <section className="content-card">
                <div className="section-title"><span className="step">02</span><div><h2>Add your media</h2><p className="muted">Files are securely uploaded to Cloudinary before publishing.</p></div></div>
                <label className="upload-zone"><input type="file" accept={media.accept} multiple={media.multiple} onChange={(event) => { selectFiles(event.target.files); event.target.value = ''; }} /><span className="upload-icon">↑</span><strong>Choose {mediaType === 'CAROUSEL' ? 'images' : mediaType === 'REELS' ? 'videos' : 'an image'}</strong><span className="muted">{media.help}</span><span className="upload-link">Browse files</span></label>
                {mediaType === 'REELS' && selectedFiles.length > 0 ? (
                  <div className="video-assignments">
                    {selectedFiles.map((file, videoIndex) => {
                      const assignedAccounts = videoAccounts[videoIndex] || [];
                      return (
                        <div className="video-assignment" key={`${file.name}-${file.size}-${videoIndex}`}>
                          <div className="video-assignment-heading"><strong>Video {videoIndex + 1}: {file.name}</strong><small>{(file.size / (1024 * 1024)).toFixed(1)} MB</small></div>
                          <div className="video-account-heading"><span>Select accounts for this video ({assignedAccounts.length})</span><button type="button" className="text-button" disabled={!status.accounts.length} onClick={() => setVideoAccountsForAll(videoIndex, assignedAccounts.length === status.accounts.length ? [] : status.accounts.map((account) => account.id))}>{assignedAccounts.length === status.accounts.length && status.accounts.length ? 'Clear' : 'Select all'}</button></div>
                          {status.accounts.length ? (
                            <div className="video-account-list">{status.accounts.map((account) => (
                              <label className="account-choice" key={account.id}>
                                <input type="checkbox" checked={assignedAccounts.includes(account.id)} onChange={() => toggleVideoAccount(videoIndex, account.id)} />
                                <span className="account-avatar small">{account.username.slice(0, 1).toUpperCase()}</span>
                                <span>@{account.username}</span>
                              </label>
                            ))}</div>
                          ) : <div className="inline-empty">Connect an Instagram account before assigning this video.</div>}
                        </div>
                      );
                    })}
                  </div>
                ) : selectedFiles.length > 0 && <ul className="file-list">{selectedFiles.map((file, index) => <li key={`${file.name}-${file.size}-${index}`}>▧ <span>{file.name}</span><small>{(file.size / (1024 * 1024)).toFixed(1)} MB</small></li>)}</ul>}
              </section>
              <section className="content-card">
                <div className="section-title"><span className="step">03</span><div><h2>Write a caption</h2><p className="muted">Share the story behind your post.</p></div></div>
                <textarea className="caption-input" rows="5" maxLength="2200" value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Write a caption… add hashtags or mention someone" />
                <div className="character-count">{caption.length} / 2,200</div>
              </section>
            </div>
            <aside className="composer-side">
              {mediaType !== 'REELS' && <section className="content-card account-picker">
                <div className="side-title"><div><span className="step">04</span><h2>Publish to</h2></div><button type="button" className="text-button" disabled={!status.accounts.length} onClick={() => setSelectedAccounts(selectedAccounts.length === status.accounts.length ? [] : status.accounts.map((account) => account.id))}>{selectedAccounts.length === status.accounts.length && status.accounts.length ? 'Clear' : 'Select all'}</button></div>
                <p className="muted">Choose one or more accounts.</p>
                {!status.accounts.length ? <div className="inline-empty">No accounts yet. <a href="/api/auth/instagram/login">Connect Instagram</a></div> : status.accounts.map((account) => <label className="account-choice" key={account.id}><input type="checkbox" checked={selectedAccounts.includes(account.id)} onChange={() => toggleAccount(account.id)} /><span className="account-avatar small">{account.username.slice(0, 1).toUpperCase()}</span><span>@{account.username}</span></label>)}
                <div className="publish-divider" />
                <button className="button primary full publish-button" disabled={!canPublish}>{publishing ? 'Publishing…' : 'Publish now'} <span>↗</span></button>
                <p className="publish-note">Your post will be published to {selectedAccounts.length} {selectedAccounts.length === 1 ? 'account' : 'accounts'}.</p>
              </section>}
              {mediaType === 'REELS' && <section className="content-card account-picker"><p className="muted">{publishTargetCount} total video-to-account assignment{publishTargetCount === 1 ? '' : 's'}. Assign each video to at least one account.</p><div className="publish-divider" /><button className="button primary full publish-button" disabled={!canPublish}>{publishing ? 'Publishing…' : 'Publish now'} <span>↗</span></button></section>}
              {results.length > 0 && <section className="content-card publish-results"><h2>Publish results</h2>{results.map((result) => <div key={`${result.accountId}-${result.mediaIndex}`} className="result-row"><span className={result.ok ? 'result-ok' : 'result-fail'}>{result.ok ? '✓' : '!'}</span><span>@{result.username}{mediaType === 'REELS' ? ` · Video ${result.mediaIndex}` : ''}</span>{result.postUrl && <a href={result.postUrl} target="_blank" rel="noreferrer">View post ↗</a>}<small>{result.error || ''}</small></div>)}</section>}
            </aside>
          </form>
        )}
      </main>
    </div>
  );
}
