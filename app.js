(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const audio = $('#audio');
  const state = {
    db: null, songs: [], urls: new Map(), coverUrls: new Map(), currentId: null,
    queue: [], page: 'home', query: '', sort: 'title', shuffle: false,
    repeat: 'none', timer: null, timerMode: '', toastTimer: null, artistFilter: '',
    albumFilter: '', folderFilter: '', recentIds: []
  };

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const formatTime = seconds => {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const s = Math.floor(seconds);
    return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  };
  const currentSong = () => state.songs.find(song => song.id === state.currentId) || null;
  const showToast = message => {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  };
  const coverTone = song => `cover-${(song?.coverTone ?? (song?.title?.length || 0)) % 6}`;
  function coverMarkup(song, cls = '') {
    const tone = coverTone(song);
    const url = song?.coverUrl || '';
    return `<div class="cover-art ${tone} ${cls}">${url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(song?.album || song?.title || '专辑封面')}" loading="lazy">` : `<span class="cover-glyph">♫</span>`}</div>`;
  }
  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('当前浏览器不支持本地音乐库'));
      const request = indexedDB.open('melody-local-music-v1', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开本地音乐库'));
    });
  }
  function dbRequest(store, mode, action) {
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(store, mode);
      const req = action(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || tx.error || new Error('本地存储失败'));
      tx.onabort = () => reject(tx.error || new Error('本地存储事务失败'));
    });
  }
  const dbGetAll = () => dbRequest('songs', 'readonly', store => store.getAll());
  const persistentRecord = record => {
    const {audioUrl, coverUrl, ...stored} = record;
    return stored;
  };
  const dbPut = record => dbRequest('songs', 'readwrite', store => store.put(persistentRecord(record)));
  const dbPutMany = records => new Promise((resolve, reject) => {
    const tx = state.db.transaction('songs', 'readwrite');
    const store = tx.objectStore('songs');
    records.forEach(record => store.put(persistentRecord(record)));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('保存歌曲失败'));
    tx.onabort = () => reject(tx.error || new Error('保存歌曲失败'));
  });
  const dbDelete = id => dbRequest('songs', 'readwrite', store => store.delete(id));
  const dbSetting = async (key, value) => {
    if (value === undefined) return dbRequest('settings', 'readonly', store => store.get(key));
    return dbRequest('settings', 'readwrite', store => store.put({key, value}));
  };
  function attachUrls(song) {
    if (song.audioUrl && !state.urls.has(song.id)) delete song.audioUrl;
    if (song.coverUrl && !state.coverUrls.has(song.id)) delete song.coverUrl;
    if (!song.audioUrl && song.blob) {
      song.audioUrl = URL.createObjectURL(song.blob);
      state.urls.set(song.id, song.audioUrl);
    }
    if (!song.coverUrl && song.coverBlob) {
      song.coverUrl = URL.createObjectURL(song.coverBlob);
      state.coverUrls.set(song.id, song.coverUrl);
    }
    return song;
  }
  function revokeSongUrls(id) {
    if (state.urls.has(id)) URL.revokeObjectURL(state.urls.get(id));
    if (state.coverUrls.has(id)) URL.revokeObjectURL(state.coverUrls.get(id));
    state.urls.delete(id); state.coverUrls.delete(id);
  }
  function baseTitle(file) {
    return file.name.replace(/\.[^.]+$/, '').replace(/\s+/g, ' ').trim() || '未知曲目';
  }
  function fallbackTags(file) {
    const title = baseTitle(file);
    const split = title.match(/^(.+?)\s[-–—]\s(.+)$/);
    return {title: split ? split[2].trim() : title, artist: split ? split[1].trim() : '未知歌手', album: '未知专辑', year: '', coverBlob: null};
  }
  function syncSafe(bytes, offset) {
    return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
  }
  function readFrameText(bytes, encoding) {
    let decoder;
    try { decoder = new TextDecoder(encoding === 1 ? 'utf-16' : encoding === 2 ? 'utf-16be' : encoding === 3 ? 'utf-8' : 'iso-8859-1'); }
    catch { decoder = new TextDecoder(); }
    return decoder.decode(bytes).replace(/[\u0000\uFEFF]+/g, ' ').trim();
  }
  function parseId3(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const tags = {};
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return tags;
    const version = bytes[3];
    const flags = bytes[5];
    let end = Math.min(bytes.length, 10 + syncSafe(bytes, 6));
    let offset = 10;
    if (flags & 0x40) {
      const extSize = version === 4 ? syncSafe(bytes, offset) : view.getUint32(offset);
      offset += extSize + (version === 3 ? 4 : 0);
    }
    const textMap = {TIT2:'title',TPE1:'artist',TALB:'album',TYER:'year',TDRC:'year'};
    while (offset + 10 <= end) {
      const id = String.fromCharCode(...bytes.slice(offset, offset + 4));
      if (!/^[A-Z0-9]{4}$/.test(id) || id.startsWith('\u0000')) break;
      const size = version === 4 ? syncSafe(bytes, offset + 4) : view.getUint32(offset + 4);
      if (!size || offset + 10 + size > end) break;
      const frameStart = offset + 10;
      const frame = bytes.slice(frameStart, frameStart + size);
      if (textMap[id] && frame.length > 1) tags[textMap[id]] = readFrameText(frame.slice(1), frame[0]);
      if (id === 'APIC' && frame.length > 8 && !tags.coverBlob) {
        try {
          const enc = frame[0];
          let cursor = 1;
          while (cursor < frame.length && frame[cursor] !== 0) cursor++;
          const mime = String.fromCharCode(...frame.slice(1, cursor)) || 'image/jpeg';
          cursor += 2; // MIME terminator + picture type
          if (enc === 1 || enc === 2) {
            while (cursor + 1 < frame.length && !(frame[cursor] === 0 && frame[cursor + 1] === 0)) cursor += 2;
            cursor += 2;
          } else {
            while (cursor < frame.length && frame[cursor] !== 0) cursor++;
            cursor++;
          }
          if (cursor < frame.length) tags.coverBlob = new Blob([frame.slice(cursor)], {type: mime});
        } catch { /* Invalid embedded artwork falls back to generated cover. */ }
      }
      offset += 10 + size;
    }
    return tags;
  }
  async function getFileTags(file) {
    const fallback = fallbackTags(file);
    if (!/\.(mp3)$/i.test(file.name)) return fallback;
    try {
      const buffer = await file.slice(0, Math.min(file.size, 10 * 1024 * 1024)).arrayBuffer();
      const parsed = parseId3(buffer);
      return {...fallback, ...Object.fromEntries(Object.entries(parsed).filter(([,value]) => value))};
    } catch { return fallback; }
  }
  function readDuration(blob) {
    return new Promise(resolve => {
      const probe = document.createElement('audio');
      const url = URL.createObjectURL(blob);
      let finished = false;
      const done = value => {
        if (finished) return;
        finished = true;
        probe.removeAttribute('src'); probe.load(); URL.revokeObjectURL(url);
        resolve(Number.isFinite(value) ? value : 0);
      };
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => done(probe.duration);
      probe.onerror = () => done(0);
      setTimeout(() => done(0), 8000);
      probe.src = url;
    });
  }
  async function mapLimit(items, limit, mapper) {
    const result = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
      while (next < items.length) {
        const index = next++;
        try { result[index] = await mapper(items[index], index); }
        catch { result[index] = null; }
      }
    }));
    return result;
  }
  async function importFiles(fileList) {
    const files = [...fileList].filter(file => file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|flac|ogg|opus|aiff|wma)$/i.test(file.name));
    if (!files.length) return showToast('没有找到可播放的音频文件');
    const existing = new Set(state.songs.map(song => song.signature));
    const newFiles = files.filter(file => !existing.has(`${file.name}:${file.size}:${file.lastModified}`));
    if (!newFiles.length) return showToast('这些歌曲已经在音乐库里了');
    showToast(`正在读取 ${newFiles.length} 首歌曲…`);
    const records = await mapLimit(newFiles, 4, async file => {
      const tags = await getFileTags(file);
      const duration = await readDuration(file);
      const relative = file.webkitRelativePath || file.relativePath || '';
      const folder = relative ? relative.split('/').slice(0, -1).join('/') || '音乐' : '已导入的音乐';
      const song = {
        id: crypto.randomUUID(), signature: `${file.name}:${file.size}:${file.lastModified}`,
        name: file.name, title: tags.title || baseTitle(file), artist: tags.artist || '未知歌手',
        album: tags.album || '未知专辑', year: tags.year || '', duration,
        blob: file, coverBlob: tags.coverBlob || null, coverTone: Math.abs(hash(file.name)) % 6,
        folder, favorite: false, addedAt: Date.now(), playedAt: 0, mime: file.type
      };
      return song;
    });
    const goodRecords = records.filter(Boolean);
    if (!goodRecords.length) return showToast('导入失败，请检查文件格式');
    try {
      await dbPutMany(goodRecords);
      goodRecords.forEach(attachUrls);
      state.songs.push(...goodRecords);
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      render();
      showToast(`已添加 ${goodRecords.length} 首歌曲`);
      if (goodRecords.length === 1 && !state.currentId) playSong(goodRecords[0].id, false, [goodRecords[0].id]);
    } catch (error) {
      console.error(error);
      showToast('保存失败：设备本地空间可能不足');
    }
  }
  function hash(text) {
    let value = 0;
    for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) | 0;
    return value >>> 0;
  }
  const pageNames = {home:'音乐首页',songs:'全部歌曲',albums:'专辑',artists:'歌手',folders:'文件夹',favorites:'我的最爱',recent:'最近播放',player:'正在播放'};
  function sortedSongs(list) {
    const copy = [...list];
    if (state.sort === 'recent') return copy.sort((a,b) => b.addedAt - a.addedAt);
    if (state.sort === 'artist') return copy.sort((a,b) => a.artist.localeCompare(b.artist, 'zh-CN') || a.title.localeCompare(b.title, 'zh-CN'));
    if (state.sort === 'duration') return copy.sort((a,b) => b.duration - a.duration);
    return copy.sort((a,b) => a.title.localeCompare(b.title, 'zh-CN'));
  }
  function pageSongs() {
    let list = state.songs;
    if (state.page === 'favorites') list = list.filter(song => song.favorite);
    if (state.page === 'recent') list = list.filter(song => song.playedAt).sort((a,b) => b.playedAt - a.playedAt);
    if (state.page === 'albums' && state.albumFilter) list = list.filter(song => song.album === state.albumFilter);
    if (state.page === 'artists' && state.artistFilter) list = list.filter(song => song.artist === state.artistFilter);
    if (state.page === 'folders' && state.folderFilter) list = list.filter(song => song.folder === state.folderFilter);
    if (state.query) {
      const q = state.query.toLocaleLowerCase();
      list = list.filter(song => `${song.title} ${song.artist} ${song.album} ${song.name}`.toLocaleLowerCase().includes(q));
    }
    return sortedSongs(list);
  }
  function songRows(list) {
    if (!list.length) return '';
    return `<div class="song-list">${list.map(song => `<article class="song-row ${song.id === state.currentId ? 'current' : ''}" data-song="${escapeHtml(song.id)}" tabindex="0" role="button" aria-label="播放 ${escapeHtml(song.title)}">${coverMarkup(song, 'song-cover')}<div class="song-meta"><div class="song-name">${escapeHtml(song.title)}</div><div class="song-byline">${escapeHtml(song.artist)}${song.album && song.album !== '未知专辑' ? ` · ${escapeHtml(song.album)}` : ''}</div></div><span class="song-duration">${formatTime(song.duration)}</span><button class="row-action row-fav ${song.favorite ? 'active' : ''}" data-favorite="${escapeHtml(song.id)}" aria-label="${song.favorite ? '取消最爱' : '加入最爱'}">${song.favorite ? '♥' : '♡'}</button><button class="row-action" data-more="${escapeHtml(song.id)}" aria-label="更多选项">⋮</button></article>`).join('')}</div>`;
  }
  function emptyState(title = '你的音乐库还空空的', copy = '选择设备里的音频文件导入。音乐只储存在这个浏览器的本地空间，不会上传。') {
    return `<div class="empty-state"><div class="empty-vinyl"><span></span></div><p class="empty-title">${escapeHtml(title)}</p><p class="empty-copy">${escapeHtml(copy)}</p><button class="import-button" data-action="import">＋ 导入本地音乐</button></div>`;
  }
  function heading(title, subtitle, kicker = 'YOUR LIBRARY', action = '') {
    return `<div class="page-heading ${action ? 'list-heading' : ''}"><div><p class="eyebrow">${escapeHtml(kicker)}</p><h1 class="page-title">${escapeHtml(title)}</h1><p class="page-subtitle">${escapeHtml(subtitle)}</p></div>${action ? `<div class="heading-action">${action}</div>` : ''}</div>`;
  }
  function renderHome() {
    const recent = sortedSongs(state.songs).slice(0, 4);
    const albumCount = new Set(state.songs.map(song => song.album)).size;
    const artistCount = new Set(state.songs.map(song => song.artist)).size;
    const favorites = state.songs.filter(song => song.favorite).length;
    return `${heading('你的音乐，随心播放', '本地收藏，一键开始。没有推荐算法，只有你喜欢的声音。', 'MELODY · YOUR SPACE')}
      <section class="hero-card"><div class="hero-copy"><div class="hero-kicker">A LITTLE SPACE FOR SOUND</div><div class="hero-title">让喜欢的旋律<br>陪你一会儿。</div><div class="hero-text">导入设备中的音乐，打造只属于你的离线音乐空间。</div><div class="hero-stat"><b>${state.songs.length}</b> 首本地歌曲 · 私密保存</div></div><div class="hero-record ${audio.paused ? '' : 'is-playing'}"><div class="hero-label">♫</div></div></section>
      <div class="tile-grid"><button class="library-tile" data-page="songs"><div class="tile-top"><span class="tile-icon">♫</span><span class="tile-count">${state.songs.length}</span></div><div><div class="tile-name">全部歌曲</div><div class="tile-hint">你的完整曲库</div></div></button><button class="library-tile" data-page="albums"><div class="tile-top"><span class="tile-icon">▣</span><span class="tile-count">${albumCount}</span></div><div><div class="tile-name">专辑</div><div class="tile-hint">按专辑浏览</div></div></button><button class="library-tile" data-page="artists"><div class="tile-top"><span class="tile-icon">♟</span><span class="tile-count">${artistCount}</span></div><div><div class="tile-name">歌手</div><div class="tile-hint">按歌手发现</div></div></button><button class="library-tile" data-page="folders"><div class="tile-top"><span class="tile-icon">▰</span><span class="tile-count">${new Set(state.songs.map(song => song.folder)).size}</span></div><div><div class="tile-name">文件夹</div><div class="tile-hint">查看导入来源</div></div></button><button class="library-tile" data-page="favorites"><div class="tile-top"><span class="tile-icon">♥</span><span class="tile-count">${favorites}</span></div><div><div class="tile-name">我的最爱</div><div class="tile-hint">留住最爱的歌</div></div></button><button class="library-tile" data-page="recent"><div class="tile-top"><span class="tile-icon">◷</span><span class="tile-count">${state.songs.filter(song => song.playedAt).length}</span></div><div><div class="tile-name">最近播放</div><div class="tile-hint">继续上次的音乐</div></div></button></div>
      <div class="section-head"><h2 class="section-title">最近加入</h2><button class="section-link" data-page="songs">查看全部　→</button></div>
      ${recent.length ? songRows(recent) : emptyState()}`;
  }
  function renderSongsPage() {
    const title = state.page === 'favorites' ? '我的最爱' : state.page === 'recent' ? '最近播放' : state.page === 'albums' && state.albumFilter ? state.albumFilter : state.page === 'artists' && state.artistFilter ? state.artistFilter : state.page === 'folders' && state.folderFilter ? state.folderFilter.split('/').pop() : '全部歌曲';
    const list = pageSongs();
    const sub = state.query ? `找到 ${list.length} 首匹配歌曲` : `${list.length} 首歌曲 · 点击曲目即可播放`;
    const canImportFolder = state.page === 'folders';
    const action = `<button class="soft-button" data-action="${canImportFolder ? 'import-folder' : 'import'}"><span class="button-symbol">＋</span>${canImportFolder ? '导入文件夹' : '添加歌曲'}</button>`;
    const order = `<select class="sort-select" id="sortSelect" aria-label="排序方式"><option value="title" ${state.sort==='title'?'selected':''}>按歌曲名</option><option value="artist" ${state.sort==='artist'?'selected':''}>按歌手</option><option value="recent" ${state.sort==='recent'?'selected':''}>最近添加</option><option value="duration" ${state.sort==='duration'?'selected':''}>按时长</option></select>`;
    return `${heading(title, sub, 'MUSIC LIBRARY', action)}<div class="list-toolbar"><span class="result-caption">${state.query ? `“${escapeHtml(state.query)}”` : '本地音乐 · 离线可用'}</span>${order}</div>${list.length ? songRows(list) : (state.songs.length ? `<div class="list-empty">这里还没有歌曲。导入本地音频，开始填满歌单。</div>` : emptyState())}`;
  }
  function groupSongs(key) {
    const map = new Map();
    for (const song of state.songs) {
      const name = song[key] || '未知';
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(song);
    }
    return [...map.entries()].sort((a,b) => a[0].localeCompare(b[0], 'zh-CN'));
  }
  function renderAlbums() {
    const groups = groupSongs('album');
    if (state.query) {
      const songs = pageSongs();
      return `${heading('专辑', `共 ${groups.length} 张专辑`, 'ALBUMS')}${songs.length ? songRows(songs) : `<div class="list-empty">没有找到匹配的歌曲。</div>`}`;
    }
    return `${heading(state.albumFilter || '专辑', `${groups.length} 张专辑 · ${state.songs.length} 首歌曲`, 'ALBUM COLLECTION', state.albumFilter ? `<button class="soft-button" data-action="clear-filter">← 返回专辑</button>` : '')}${state.albumFilter ? songRows(pageSongs()) : groups.length ? `<div class="album-grid">${groups.map(([name,songs],i) => `<button class="album-card" data-album="${escapeHtml(name)}"><div class="album-art cover-art ${coverTone(songs[0])}">${songs[0].coverUrl ? `<img src="${escapeHtml(songs[0].coverUrl)}" alt="${escapeHtml(name)}" loading="lazy">` : '<span class="cover-glyph">♫</span>'}</div><strong>${escapeHtml(name)}</strong><small>${escapeHtml(songs[0].artist)} · ${songs.length} 首</small></button>`).join('')}</div>` : emptyState('还没有专辑', '导入带有专辑标签的音乐，专辑会自动整理在这里。')}`;
  }
  function renderArtists() {
    const groups = groupSongs('artist');
    return `${heading(state.artistFilter || '歌手', `${groups.length} 位歌手 · ${state.songs.length} 首歌曲`, 'ARTISTS', state.artistFilter ? `<button class="soft-button" data-action="clear-filter">← 返回歌手</button>` : '')}${state.artistFilter ? songRows(pageSongs()) : groups.length ? `<div class="artist-list">${groups.map(([name,songs]) => `<button class="artist-card" data-artist="${escapeHtml(name)}"><span class="artist-avatar">${escapeHtml(name.slice(0,1))}</span><span><strong>${escapeHtml(name)}</strong><small>${songs.length} 首歌曲</small></span></button>`).join('')}</div>` : emptyState('还没有歌手', '导入本地歌曲后，歌手会根据音频标签自动整理。')}`;
  }
  function renderFolders() {
    const groups = groupSongs('folder');
    return `${heading(state.folderFilter ? state.folderFilter.split('/').pop() : '文件夹', `${groups.length} 个来源位置`, 'FOLDERS', state.folderFilter ? `<button class="soft-button" data-action="clear-filter">← 返回文件夹</button>` : `<button class="soft-button" data-action="import-folder"><span class="button-symbol">＋</span>导入文件夹</button>`)}${state.folderFilter ? songRows(pageSongs()) : groups.length ? `<div class="folder-list">${groups.map(([folder,songs]) => `<button class="folder-card" data-folder="${escapeHtml(folder)}"><span class="folder-icon">♫</span><span><strong>${escapeHtml(folder)}</strong><small>${songs.length} 首歌曲</small></span><span class="folder-count">›</span></button>`).join('')}</div>` : emptyState('还没有导入音乐', '可以选择多首音频，或导入一个音乐文件夹。')}`;
  }
  function renderNowPlaying() {
    const song = currentSong();
    if (!song) return `${heading('正在播放', '把喜欢的声音放进来。', 'NOW PLAYING')}${emptyState('还没有播放歌曲', '先导入设备里的音乐，然后选择一首开始播放。')}`;
    return `<section class="now-playing-page"><button class="now-back" data-page="${state.pageBeforePlayer || 'home'}">← 返回音乐库</button><div class="now-card"><div class="now-cover">${coverMarkup(song)}</div><div class="now-info"><h1 class="now-title">${escapeHtml(song.title)}</h1><div class="now-artist">${escapeHtml(song.artist)}</div><div class="now-album">${escapeHtml(song.album)}</div></div><div class="now-progress"><span id="nowCurrent">${formatTime(audio.currentTime)}</span><input id="nowSeek" type="range" min="0" max="1000" value="0" aria-label="播放进度"><span id="nowDuration">${formatTime(audio.duration || song.duration)}</span></div><div class="now-controls"><button id="nowShuffle" aria-label="随机播放">⤨</button><button id="nowPrev" aria-label="上一首">|◀</button><button id="nowPlay" class="now-play" aria-label="播放">${audio.paused ? '▶' : 'Ⅱ'}</button><button id="nowNext" aria-label="下一首">▶|</button><button id="nowRepeat" aria-label="循环模式">↻</button></div><div class="now-extra"><button id="nowFavorite" class="${song.favorite ? 'active' : ''}">${song.favorite ? '♥ 已收藏' : '♡ 收藏'}</button><button id="timerButtonNow">◷ 睡眠定时</button></div><div class="lyrics-box">本地歌词暂不可用<br><span class="lyrics-current">此刻，只听这一首。</span></div></div></section>`;
  }
  function render() {
    const page = state.page;
    const content = $('#pageContent');
    if (!content) return;
    if (page === 'home') content.innerHTML = renderHome();
    else if (page === 'albums') content.innerHTML = renderAlbums();
    else if (page === 'artists') content.innerHTML = renderArtists();
    else if (page === 'folders') content.innerHTML = renderFolders();
    else if (page === 'player') content.innerHTML = renderNowPlaying();
    else content.innerHTML = renderSongsPage();
    $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === (page === 'player' ? (state.pageBeforePlayer || 'home') : page)));
    $$('.mobile-tab,.mobile-bottom-item').forEach(item => item.classList.toggle('active', item.dataset.page === page));
    updatePlayer();
    if (page === 'player') bindNowControls();
  }
  function updatePlayer() {
    const song = currentSong();
    const playing = !!song && !audio.paused;
    $('#songCountNav').textContent = String(state.songs.length);
    $('#albumCountNav').textContent = String(new Set(state.songs.map(item => item.album)).size);
    $('#favoriteCountNav').textContent = String(state.songs.filter(item => item.favorite).length);
    const setText = (selector, text) => { const el = $(selector); if (el) el.textContent = text; };
    setText('#panelTitle', song?.title || '还没有播放歌曲');
    setText('#panelArtist', song?.artist || '导入音乐，开启你的播放时刻');
    setText('#miniTitle', song?.title || '—');
    setText('#miniArtist', song?.artist || '—');
    const panelCover = $('#panelCover');
    const miniCover = $('#miniCover');
    if (song) {
      panelCover.innerHTML = `${song.coverUrl ? `<img src="${escapeHtml(song.coverUrl)}" alt="">` : ''}<div class="record-label">♫</div>`;
      panelCover.className = `cover-art cover-large ${coverTone(song)}`;
      miniCover.innerHTML = song.coverUrl ? `<img src="${escapeHtml(song.coverUrl)}" alt="">` : '<span class="cover-glyph">♫</span>';
      miniCover.className = `cover-art cover-mini ${coverTone(song)}`;
    } else {
      panelCover.innerHTML = '<div class="record-label">♫</div>';
      panelCover.className = 'cover-art cover-large empty-record';
      miniCover.innerHTML = '<span class="cover-glyph">♫</span>';
      miniCover.className = 'cover-art cover-mini';
    }
    $('#miniPlayer').hidden = !song;
    $('#playButton').textContent = playing ? 'Ⅱ' : '▶';
    $('#playButton').setAttribute('aria-label', playing ? '暂停' : '播放');
    $('#miniPlay').textContent = playing ? 'Ⅱ' : '▶';
    $('#favoriteButton').classList.toggle('active', !!song?.favorite);
    $('#favoriteButton').innerHTML = `${song?.favorite ? '♥' : '♡'} <span>${song?.favorite ? '已收藏' : '最爱'}</span>`;
    $('#shuffleButton').classList.toggle('selected', state.shuffle);
    $('#repeatButton').classList.toggle('selected', state.repeat !== 'none');
    $('#repeatButton').title = state.repeat === 'one' ? '单曲循环' : state.repeat === 'all' ? '列表循环' : '顺序播放';
    $('.panel-equalizer')?.classList.toggle('is-playing', playing);
    $('.hero-record')?.classList.toggle('is-playing', playing);
    const duration = audio.duration || song?.duration || 0;
    const progress = duration ? Math.min(1, audio.currentTime / duration) : 0;
    $('#panelCurrent').textContent = formatTime(audio.currentTime);
    $('#panelDuration').textContent = formatTime(duration);
    $('#panelSeek').value = String(Math.round(progress * 1000));
    $('#miniProgress').style.setProperty('--progress', `${progress * 100}%`);
    const nowCurrent = $('#nowCurrent');
    const nowDuration = $('#nowDuration');
    const nowSeek = $('#nowSeek');
    if (nowCurrent) nowCurrent.textContent = formatTime(audio.currentTime);
    if (nowDuration) nowDuration.textContent = formatTime(duration);
    if (nowSeek) nowSeek.value = String(Math.round(progress * 1000));
    const nowPlay = $('#nowPlay');
    if (nowPlay) nowPlay.textContent = playing ? 'Ⅱ' : '▶';
    const nowFav = $('#nowFavorite');
    if (nowFav) { nowFav.textContent = song?.favorite ? '♥ 已收藏' : '♡ 收藏'; nowFav.classList.toggle('active', !!song?.favorite); }
    const nowShuffle = $('#nowShuffle');
    if (nowShuffle) nowShuffle.classList.toggle('active', state.shuffle);
    const nowRepeat = $('#nowRepeat');
    if (nowRepeat) nowRepeat.classList.toggle('active', state.repeat !== 'none');
  }
  function setPage(page) {
    if (!page) return;
    if (page !== 'player') {
      state.pageBeforePlayer = page;
      if (page !== 'albums') state.albumFilter = '';
      if (page !== 'artists') state.artistFilter = '';
      if (page !== 'folders') state.folderFilter = '';
    }
    state.page = page;
    $('.app-shell').classList.toggle('player-open', page === 'player');
    $('#sidebar').classList.remove('open');
    render();
    $('#mainContent').scrollTo({top:0,behavior:'smooth'});
  }
  function queueForPage() {
    const list = state.page === 'home' ? sortedSongs(state.songs) : pageSongs();
    return list.length ? list.map(song => song.id) : state.songs.map(song => song.id);
  }
  async function playSong(id, autoplay = true, queue = null) {
    const song = state.songs.find(item => item.id === id);
    if (!song) return;
    if (queue?.length) state.queue = [...queue];
    else if (!state.queue.length || !state.queue.includes(id)) state.queue = queueForPage();
    state.currentId = id;
    if (!state.queue.includes(id)) state.queue.unshift(id);
    attachUrls(song);
    if (audio.src !== song.audioUrl) audio.src = song.audioUrl;
    audio.currentTime = 0;
    song.playedAt = Date.now();
    dbPut(song).catch(() => {});
    updatePlayer(); render();
    if (autoplay) {
      try { await audio.play(); }
      catch { showToast('点击播放键，允许浏览器播放本地音频'); }
    }
    updateMediaSession(song);
  }
  async function togglePlayback() {
    if (!currentSong()) {
      const first = sortedSongs(state.songs)[0];
      if (!first) return showToast('先导入一些本地音乐吧');
      return playSong(first.id, true, queueForPage());
    }
    if (audio.paused) {
      try { await audio.play(); }
      catch { showToast('无法播放此音频格式'); }
    } else audio.pause();
    updatePlayer();
  }
  function nextSong(manual = false) {
    if (!state.songs.length) return;
    if (state.repeat === 'one' && !manual) { audio.currentTime = 0; audio.play(); return; }
    const queue = state.queue.length ? state.queue : state.songs.map(song => song.id);
    const currentIndex = queue.indexOf(state.currentId);
    let nextId;
    if (state.shuffle && queue.length > 1) {
      const choices = queue.filter(id => id !== state.currentId);
      nextId = choices[Math.floor(Math.random() * choices.length)];
    } else if (currentIndex >= 0 && currentIndex < queue.length - 1) nextId = queue[currentIndex + 1];
    else if (manual || state.repeat === 'all') nextId = queue[0];
    if (nextId) playSong(nextId, true, queue);
    else if (!manual) { audio.pause(); audio.currentTime = 0; updatePlayer(); }
  }
  function prevSong() {
    if (!state.songs.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    const queue = state.queue.length ? state.queue : state.songs.map(song => song.id);
    const index = queue.indexOf(state.currentId);
    const previous = index > 0 ? queue[index - 1] : (state.repeat === 'all' ? queue.at(-1) : null);
    if (previous) playSong(previous, true, queue);
    else audio.currentTime = 0;
  }
  function bindNowControls() {
    $('#nowPlay')?.addEventListener('click', togglePlayback);
    $('#nowNext')?.addEventListener('click', () => nextSong(true));
    $('#nowPrev')?.addEventListener('click', prevSong);
    $('#nowShuffle')?.addEventListener('click', () => { state.shuffle = !state.shuffle; updatePlayer(); });
    $('#nowRepeat')?.addEventListener('click', cycleRepeat);
    $('#nowFavorite')?.addEventListener('click', toggleFavorite);
    $('#timerButtonNow')?.addEventListener('click', openTimerModal);
    $('#nowSeek')?.addEventListener('input', event => seek(event.target.value));
  }
  function cycleRepeat() {
    state.repeat = state.repeat === 'none' ? 'all' : state.repeat === 'all' ? 'one' : 'none';
    showToast(state.repeat === 'one' ? '单曲循环' : state.repeat === 'all' ? '列表循环' : '顺序播放');
    updatePlayer();
  }
  async function toggleFavorite(id = state.currentId) {
    const song = state.songs.find(item => item.id === id);
    if (!song) return showToast('先选择一首歌曲');
    song.favorite = !song.favorite;
    await dbPut(song).catch(() => {});
    render();
    showToast(song.favorite ? '已加入我的最爱' : '已从最爱移除');
  }
  async function removeSong(id) {
    const song = state.songs.find(item => item.id === id);
    if (!song) return;
    const okay = await askConfirm(`从本地音乐库移除「${song.title}」？`, '歌曲文件不会从设备删除，只会移出此播放器。', '移除曲目');
    if (!okay) return;
    await dbDelete(id).catch(() => {});
    state.songs = state.songs.filter(item => item.id !== id);
    if (state.currentId === id) { audio.pause(); audio.removeAttribute('src'); state.currentId = null; }
    state.queue = state.queue.filter(item => item !== id);
    revokeSongUrls(id); render(); showToast('已从播放器移除');
  }
  function openModal(title, text, content) {
    $('#modalBody').innerHTML = `<h2 id="modalTitle">${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p>${content}`;
    $('#modalBackdrop').hidden = false;
    $('#modalClose').focus();
  }
  function closeModal() { $('#modalBackdrop').hidden = true; $('#modalBody').innerHTML = ''; }
  function askConfirm(title, text, confirmLabel) {
    return new Promise(resolve => {
      openModal(title, text, `<div class="modal-actions"><button class="secondary-button" data-modal-cancel>取消</button><button class="danger-button" data-modal-confirm>${escapeHtml(confirmLabel)}</button></div>`);
      $('#modalBody').onclick = event => {
        if (event.target.closest('[data-modal-confirm]')) { closeModal(); resolve(true); }
        if (event.target.closest('[data-modal-cancel]')) { closeModal(); resolve(false); }
      };
    });
  }
  function openTimerModal() {
    const choices = [
      ['off','关闭定时','不自动停止'],['15','15 分钟后','适合一小段放松时间'],['30','30 分钟后','慢慢听到入睡'],['60','60 分钟后','一小时后停止播放'],['track','当前歌曲结束','这首歌结束时停止']
    ];
    openModal('睡眠定时', '设定停止播放的时间。定时器仅在此播放器打开时生效。', `<div class="modal-options">${choices.map(([value,label,detail]) => `<button class="modal-option ${state.timerMode===value?'active':''}" data-timer="${value}"><span>${label}</span><small>${detail}</small></button>`).join('')}</div><p class="modal-note">如果关闭浏览器或系统结束应用，定时器可能会被中断。</p>`);
    $('#modalBody').onclick = event => {
      const option = event.target.closest('[data-timer]');
      if (!option) return;
      const value = option.dataset.timer;
      clearTimeout(state.timer); state.timer = null; state.timerMode = value;
      if (value === 'track') {
        if (audio.duration && Number.isFinite(audio.duration)) state.timer = setTimeout(() => audio.pause(), Math.max(0, audio.duration - audio.currentTime) * 1000);
        else showToast('开始播放歌曲后，定时将在歌曲结束时生效');
      } else if (value !== 'off') {
        state.timer = setTimeout(() => { audio.pause(); state.timerMode = ''; showToast('睡眠定时已结束，播放已停止'); updatePlayer(); }, Number(value) * 60 * 1000);
      }
      closeModal();
      showToast(value === 'off' ? '睡眠定时已关闭' : value === 'track' ? '歌曲结束后停止' : `${value} 分钟后停止播放`);
    };
  }
  function openMoreMenu(id) {
    const song = state.songs.find(item => item.id === id);
    if (!song) return;
    openModal(song.title, `${song.artist} · ${song.album}`, `<div class="modal-options"><button class="modal-option" data-more-play="${escapeHtml(id)}"><span>▶ 立即播放</span><small>开始聆听</small></button><button class="modal-option" data-more-fav="${escapeHtml(id)}"><span>${song.favorite ? '♥ 取消收藏' : '♡ 加入最爱'}</span><small>整理你的曲库</small></button><button class="modal-option" data-more-remove="${escapeHtml(id)}"><span>从播放器移除</span><small>不会删除原始音频文件</small></button></div>`);
    $('#modalBody').onclick = async event => {
      if (event.target.closest('[data-more-play]')) { closeModal(); playSong(id, true); }
      if (event.target.closest('[data-more-fav]')) { closeModal(); toggleFavorite(id); }
      if (event.target.closest('[data-more-remove]')) { closeModal(); removeSong(id); }
    };
  }
  function seek(value) {
    const duration = audio.duration || currentSong()?.duration || 0;
    if (duration) audio.currentTime = duration * Number(value) / 1000;
  }
  function updateMediaSession(song) {
    if (!('mediaSession' in navigator) || !song) return;
    try {
      const metadata = {title:song.title, artist:song.artist, album:song.album};
      if (song.coverUrl) metadata.artwork = [{src:song.coverUrl, sizes:'512x512', type:song.coverBlob?.type || 'image/jpeg'}];
      navigator.mediaSession.metadata = new MediaMetadata(metadata);
      navigator.mediaSession.setActionHandler('play', togglePlayback);
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', prevSong);
      navigator.mediaSession.setActionHandler('nexttrack', () => nextSong(true));
      navigator.mediaSession.setActionHandler('seekto', details => { if (Number.isFinite(details.seekTime)) audio.currentTime = details.seekTime; });
    } catch { /* Media Session support differs by browser. */ }
  }
  function updateClock() {
    const date = new Date();
    $('#clock').textContent = `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
  }
  function handleMainClick(event) {
    const page = event.target.closest('[data-page]');
    if (page) { setPage(page.dataset.page); return; }
    const importAction = event.target.closest('[data-action="import"]');
    if (importAction) { $('#fileInput').click(); return; }
    const folderImport = event.target.closest('[data-action="import-folder"]');
    if (folderImport) { $('#folderInput')?.click(); if (!$('#folderInput')) showToast('当前浏览器暂不支持文件夹选择，请直接导入多首歌曲'); return; }
    const clearFilter = event.target.closest('[data-action="clear-filter"]');
    if (clearFilter) { state.albumFilter=''; state.artistFilter=''; state.folderFilter=''; render(); return; }
    const fav = event.target.closest('[data-favorite]');
    if (fav) { event.stopPropagation(); toggleFavorite(fav.dataset.favorite); return; }
    const more = event.target.closest('[data-more]');
    if (more) { event.stopPropagation(); openMoreMenu(more.dataset.more); return; }
    const album = event.target.closest('[data-album]');
    if (album) { state.albumFilter=album.dataset.album; render(); return; }
    const artist = event.target.closest('[data-artist]');
    if (artist) { state.artistFilter=artist.dataset.artist; render(); return; }
    const folder = event.target.closest('[data-folder]');
    if (folder) { state.folderFilter=folder.dataset.folder; render(); return; }
    const row = event.target.closest('[data-song]');
    if (row) { playSong(row.dataset.song, true, pageSongs().map(song => song.id)); }
  }
  function handleMainKey(event) {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-song]')) {
      event.preventDefault(); playSong(event.target.dataset.song, true, pageSongs().map(song => song.id));
    }
  }
  function bindEvents() {
    $('#importButton').addEventListener('click', () => $('#fileInput').click());
    $('#sideImportButton').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', event => { importFiles(event.target.files); event.target.value = ''; });
    $('#folderInput')?.addEventListener('change', event => { importFiles(event.target.files); event.target.value = ''; });
    $('#mainContent').addEventListener('click', handleMainClick);
    $('#mainContent').addEventListener('keydown', handleMainKey);
    $('#mainContent').addEventListener('change', event => {
      if (event.target.id === 'sortSelect') {
        state.sort = event.target.value;
        dbSetting('sort', state.sort).catch(() => {});
        render();
      }
    });
    $('#playButton').addEventListener('click', togglePlayback);
    $('#miniPlay').addEventListener('click', togglePlayback);
    $('#miniPrev').addEventListener('click', prevSong);
    $('#miniNext').addEventListener('click', () => nextSong(true));
    $('#prevButton').addEventListener('click', prevSong);
    $('#nextButton').addEventListener('click', () => nextSong(true));
    $('#shuffleButton').addEventListener('click', () => { state.shuffle = !state.shuffle; showToast(state.shuffle ? '随机播放已开启' : '随机播放已关闭'); updatePlayer(); });
    $('#repeatButton').addEventListener('click', cycleRepeat);
    $('#favoriteButton').addEventListener('click', () => toggleFavorite());
    $('#timerButton').addEventListener('click', openTimerModal);
    $('#queueButton').addEventListener('click', () => {
      const queue = $('#panelQueue');
      if (!state.queue.length) state.queue = queueForPage();
      queue.innerHTML = state.queue.map(id => {
        const song = state.songs.find(item => item.id === id);
        return song ? `<button class="queue-item ${song.id===state.currentId?'current':''}" data-queue-song="${escapeHtml(id)}">${escapeHtml(song.title)}<small>${escapeHtml(song.artist)}</small></button>` : '';
      }).join('') || '<div class="queue-item">播放队列为空</div>';
      queue.hidden = !queue.hidden;
    });
    $('#panelQueue').addEventListener('click', event => { const item = event.target.closest('[data-queue-song]'); if (item) playSong(item.dataset.queueSong, true, state.queue); });
    $('#panelSeek').addEventListener('input', event => seek(event.target.value));
    $('#searchInput').addEventListener('input', event => {
      state.query = event.target.value.trim();
      if (state.query && state.page === 'home') state.page = 'songs';
      $('#clearSearch').classList.toggle('visible', !!state.query);
      render();
      const input = $('#searchInput'); input.focus(); input.setSelectionRange(input.value.length,input.value.length);
    });
    $('#clearSearch').addEventListener('click', () => { $('#searchInput').value=''; state.query=''; $('#clearSearch').classList.remove('visible'); render(); $('#searchInput').focus(); });
    $('#searchToggle').addEventListener('click', () => { $('#searchBox').classList.toggle('open'); if ($('#searchBox').classList.contains('open')) $('#searchInput').focus(); });
    $('#menuButton').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalBackdrop').addEventListener('click', event => { if (event.target === $('#modalBackdrop')) closeModal(); });
    $('#searchInput').addEventListener('keydown', event => { if (event.key === 'Escape') { $('#searchInput').value=''; state.query=''; render(); } });
    $('#miniTrackButton').addEventListener('click', () => { if (!currentSong()) return; state.pageBeforePlayer = state.page === 'player' ? (state.pageBeforePlayer || 'home') : state.page; setPage('player'); });
    $('#miniCoverButton').addEventListener('click', () => { if (!currentSong()) return; state.pageBeforePlayer = state.page === 'player' ? (state.pageBeforePlayer || 'home') : state.page; setPage('player'); });
    document.addEventListener('click', event => {
      const select = event.target.closest('[data-page]');
      if (select && !$('#mainContent').contains(select)) setPage(select.dataset.page);
      if (!event.target.closest('#queueButton,#panelQueue')) $('#panelQueue').hidden = true;
    });
    audio.addEventListener('play', updatePlayer);
    audio.addEventListener('pause', updatePlayer);
    audio.addEventListener('timeupdate', updatePlayer);
    audio.addEventListener('loadedmetadata', () => {
      const song = currentSong();
      if (song && Number.isFinite(audio.duration)) {
        song.duration = audio.duration;
        dbPut(song).catch(() => {});
      }
      if (state.timerMode === 'track' && song) {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => { audio.pause(); state.timerMode=''; showToast('歌曲已结束，播放已停止'); }, Math.max(0, audio.duration - audio.currentTime) * 1000);
      }
      updatePlayer();
    });
    audio.addEventListener('ended', () => nextSong(false));
    audio.addEventListener('error', () => { if (currentSong()) showToast('该音频格式可能无法在当前浏览器播放'); });
    document.addEventListener('keydown', event => {
      if (event.target.matches('input,textarea,select') || $('#modalBackdrop').hidden === false) return;
      if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
      if (event.key === 'ArrowRight' && currentSong()) audio.currentTime = Math.min(audio.duration || currentSong().duration, audio.currentTime + 5);
      if (event.key === 'ArrowLeft' && currentSong()) audio.currentTime = Math.max(0, audio.currentTime - 5);
    });
  }
  async function init() {
    bindEvents(); updateClock(); setInterval(updateClock, 30000);
    try {
      state.db = await openDatabase();
      const [songs, settings] = await Promise.all([dbGetAll(), dbSetting('sort')]);
      state.songs = songs.map(attachUrls);
      if (settings?.value) state.sort = settings.value;
      render();
    } catch (error) {
      console.error(error);
      render(); showToast('本地音乐库暂不可用，请使用最新版 Chrome 或 Edge');
    }
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    if ('storage' in navigator && navigator.storage.persisted) navigator.storage.persisted().then(persisted => { if (!persisted) navigator.storage.persist?.(); }).catch(() => {});
  }
  document.addEventListener('DOMContentLoaded', init);
})();
