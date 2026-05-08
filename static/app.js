// Global state
let currentInput = null;
let spotifyUpdateInterval = null;
let currentSource = null;
let currentStationName = null;
let currentRadioTrack = '';
let radioMetadataInterval = null;
const RADIO_SOURCES = new Set(['NET', 'IRADIO', 'NETWORK']);
const RADIO_METADATA_INTERVAL_MS = 15000;

function isRadioSource(source) {
    return RADIO_SOURCES.has(source);
}

function setHeaderTitle(title) {
    const headerEl = document.getElementById('current-station');
    if (headerEl) {
        headerEl.textContent = title || 'DENON AVR';
    }
}

function setHeaderSubtitle(subtitle = '') {
    const subtitleEl = document.getElementById('current-track');
    if (!subtitleEl) {
        return;
    }

    if (subtitle) {
        subtitleEl.textContent = subtitle;
        subtitleEl.hidden = false;
    } else {
        subtitleEl.textContent = '';
        subtitleEl.hidden = true;
    }
}

function setHeaderDisplay(title, subtitle = '') {
    setHeaderTitle(title);
    setHeaderSubtitle(subtitle);
}

async function loadLastPlayedStation() {
    if (currentPlayingUrl && currentStationName) {
        return {
            url: currentPlayingUrl,
            name: currentStationName
        };
    }

    try {
        const res = await fetch('/api/last_played');
        if (!res.ok) {
            return null;
        }

        const data = await res.json();
        if (!data.url) {
            return null;
        }

        currentPlayingUrl = data.url;
        currentStationName = data.name || currentStationName;
        return data;
    } catch (e) {
        console.error('Failed to load last played station', e);
        return null;
    }
}

function updateRadioHeader() {
    const stationName = currentStationName || 'Radio';
    const liveText = currentRadioTrack || '';
    setHeaderDisplay(stationName, liveText);

    const sourceDisplay = document.getElementById('status-source');
    if (sourceDisplay && isRadioSource(currentSource)) {
        const detail = liveText || stationName;
        sourceDisplay.innerHTML = `<strong>${currentSource}</strong><br><span style="font-size:0.9em; color: var(--accent);">${detail}</span>`;
    }
}

async function updateRadioNowPlaying() {
    if (!isRadioSource(currentSource)) {
        return;
    }

    try {
        const res = await fetch('/api/radio_now_playing');
        if (!res.ok) {
            return;
        }

        const data = await res.json();

        if (!data.url) {
            const lastPlayed = await loadLastPlayedStation();
            if (lastPlayed?.name) {
                currentStationName = lastPlayed.name;
            }
            updateRadioHeader();
            return;
        }

        currentPlayingUrl = data.url;
        currentStationName = data.station_name || currentStationName;
        currentRadioTrack = data.now_playing && data.now_playing !== 'Unknown' ? data.now_playing : '';
        updateRadioHeader();
    } catch (e) {
        console.error('Failed to update radio metadata', e);
    }
}

function startRadioMetadataPolling() {
    if (radioMetadataInterval) {
        return;
    }

    updateRadioNowPlaying();
    radioMetadataInterval = setInterval(updateRadioNowPlaying, RADIO_METADATA_INTERVAL_MS);
}

function stopRadioMetadataPolling() {
    if (radioMetadataInterval) {
        clearInterval(radioMetadataInterval);
        radioMetadataInterval = null;
    }

    currentRadioTrack = '';
    if (!isRadioSource(currentSource)) {
        setHeaderSubtitle('');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Theme Logic — light is always default; dark only applied manually
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-theme');
    }

    document.getElementById('theme-toggle').addEventListener('click', () => {
        document.body.classList.toggle('dark-theme');
        const isDark = document.body.classList.contains('dark-theme');
        localStorage.setItem('theme', isDark ? 'dark' : 'light');
    });

    document.getElementById('refresh-btn').addEventListener('click', () => {
        updateStatus();
    });

    updateStatus();
    loadFavorites();
    checkSpotifyAuth();

    // Bind Search
    const searchBtn = document.getElementById('search-btn');
    const searchInput = document.getElementById('search-input');

    if (searchBtn && searchInput) {
        const doSearch = () => {
            const query = searchInput.value;
            if (query.length > 2) {
                searchStations(query);
            }
        };

        searchBtn.addEventListener('click', doSearch);
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') doSearch();
        });
    }
    // Bind Modal Close
    const modal = document.getElementById('info-modal');
    const closeBtn = document.getElementById('close-modal');
    if (closeBtn) {
        closeBtn.onclick = () => modal.style.display = "none";
        window.onclick = (event) => {
            if (event.target == modal) modal.style.display = "none";
        }
    }
    const volSlider = document.getElementById('volume-slider');
    if (volSlider) {
        // Debounce volume updates
        let volTimeout;
        volSlider.addEventListener('input', (e) => {
            const absVol = parseFloat(e.target.value);
            document.getElementById('volume-val').textContent = absVol; // Display 0-98
            clearTimeout(volTimeout);
            volTimeout = setTimeout(() => {
                // Convert 0-98 back to -80 to +18 dB for API
                const dbVol = absVol - 80;
                setVolume(dbVol);
            }, 300);
        });
    }

    document.getElementById('mute-btn').addEventListener('click', async () => {
        try {
            const res = await fetch('/api/mute/toggle', {method: 'POST'});
            const data = await res.json();
            if (data.status === 'success') {
                updateStatus(); // Will update icon
            }
        } catch (e) {
            console.error(e);
        }
    });

    document.getElementById('power-on-btn').addEventListener('click', async () => {
        try {
            const res = await fetch('/api/power/on', {method: 'POST'});
            const data = await res.json();
            if (data.status === 'success') {
                // Initial status update
                updateStatus();
                // Set volume to 25 (default after power on)
                setTimeout(() => setVolume(25 - 80), 1500); // Convert 25 to -55 dB
                // Additional delayed updates to catch power-on state changes
                setTimeout(updateStatus, 1000);
                setTimeout(updateStatus, 2500);
            }
        } catch (e) {
            console.error(e);
        }
    });

    document.getElementById('power-off-btn').addEventListener('click', async () => {
        try {
            const res = await fetch('/api/power/off', {method: 'POST'});
            const data = await res.json();
            if (data.status === 'success') {
                // Immediate and delayed updates to catch power-off state
                updateStatus();
                setTimeout(updateStatus, 500);
                setTimeout(updateStatus, 1500);
            }
        } catch (e) {
            console.error(e);
        }
    });
});

async function setSource(source) {
    try {
        // Update current input
        currentInput = source;

        // Show/hide input sections
        showInputSection(source);

        // For NETWORK (Radio) and SPOTIFY, only navigate UI - don't change AVR input
        // Input will change when user selects a station or playlist
        if (source === 'NETWORK' || source === 'SPOTIFY') {
            console.log(`Navigation only: ${source} section displayed`);
            return;
        }

        const res = await fetch('/api/input', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({input: source})
        });
        const data = await res.json();
        if(data.status === 'success') {
            // Multiple delayed updates to catch AVR state changes
            updateStatus();
            setTimeout(updateStatus, 500);
            setTimeout(updateStatus, 1500);
        } else {
            console.error('Set Source Error:', data);
            alert('Failed to set source: ' + (data.error || 'Unknown error'));
        }
    } catch(e) {
        console.error('Network Error setting source:', e);
        alert('Network error while setting source. Check AVR connection.');
    }
}

async function setVolume(vol) {
    try {
        await fetch('/api/volume', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({volume: parseFloat(vol)})
        });
        // Don't immediate updateStatus to avoid jumping slider
    } catch(e) {
        console.error(e);
    }
}

function changeVolume(delta) {
    const slider = document.getElementById('volume-slider');
    let currentVal = parseFloat(slider.value);
    let newVal = currentVal + delta;
    if (newVal < 0) newVal = 0;
    if (newVal > 98) newVal = 98;

    // Update UI immediately
    slider.value = newVal;
    document.getElementById('volume-val').textContent = newVal;

    // Send API req (Db = abs - 80)
    setVolume(newVal - 80);
}

function playNextFavorite() {
    if (!favoriteStations.length) return;
    let idx = getCurrentFavoriteIndex();
    idx = (idx + 1) % favoriteStations.length;
    let station = favoriteStations[idx];
    playUrl(station.url, station.name);
}

function playPrevFavorite() {
    if (!favoriteStations.length) return;
    let idx = getCurrentFavoriteIndex();
    idx = (idx - 1 + favoriteStations.length) % favoriteStations.length;
    let station = favoriteStations[idx];
    playUrl(station.url, station.name);
}

function getCurrentFavoriteIndex() {
    // Try to match current stream url if needed, but simple way is to match by name from UI?
    // Actually, we don't track current URL in client state tightly.
    // Let's just find the one that matches what we last requested?
    // Or we can just start from 0 if unknown.
    // Ideally we store `currentPlayingUrl`.
    if (!currentPlayingUrl) return -1;
    return favoriteStations.findIndex(f => f.url_resolved === currentPlayingUrl || f.url === currentPlayingUrl);
}

let currentPlayingUrl = null;

let currentResults = [];
let favoriteStations = [];

async function showStationInfo(station) {
    const modal = document.getElementById('info-modal');
    const title = document.getElementById('modal-title');
    const logo = document.getElementById('modal-logo');
    const homepage = document.getElementById('modal-homepage');
    const playBtn = document.getElementById('modal-play-btn');
    const liveInfo = document.getElementById('modal-live-info');

    // Fill Static Data
    title.textContent = station.name;
    if (station.favicon) {
        logo.src = station.favicon;
        logo.style.display = 'block';
    } else {
        logo.style.display = 'none';
    }

    homepage.href = station.homepage || '#';
    homepage.style.display = station.homepage ? 'inline' : 'none';

    document.getElementById('modal-bitrate').textContent = (station.bitrate || '?') + ' kbps';
    document.getElementById('modal-codec').textContent = station.codec || 'MP3';
    document.getElementById('modal-country').textContent = station.country || '-';
    document.getElementById('modal-tags').textContent = station.tags || '-';

    playBtn.onclick = () => {
        playUrl(station.url_resolved || station.url, station.name);
        modal.style.display = "none";
    };

    // Reset Live Info
    liveInfo.innerHTML = '<div class="loader" style="display:inline-block; border-width:2px; width:12px; height:12px;"></div> Connecting to stream...';

    modal.style.display = "flex";

    // Fetch Live Metadata
    const url = station.url_resolved || station.url;
    try {
        const res = await fetch(`/api/metadata?url=${encodeURIComponent(url)}`);
        const meta = await res.json();

        let content = '';
        if (meta.now_playing && meta.now_playing !== 'Unknown') {
            content += `<div style="font-weight:bold; color:var(--accent); font-size:1.1rem;">🎵 ${meta.now_playing}</div>`;
        } else {
            content += `<div style="color:var(--text-secondary);">No playing info available</div>`;
        }

        if (meta.server_name) content += `<div>Server: ${meta.server_name}</div>`;

        liveInfo.innerHTML = content;
    } catch (e) {
        liveInfo.textContent = "Could not fetch metadata.";
    }
}

async function loadFavorites() {
    try {
        const res = await fetch('/api/favorites');
        favoriteStations = await res.json();
        renderFavorites();
    } catch (e) {
        console.error("Failed to load favorites", e);
    }
}

function renderFavorites() {
    const container = document.getElementById('favorites-grid');
    if (!favoriteStations.length) {
        container.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--text-secondary); padding: 20px;">No favorites saved. Search for a station and click ❤️ to save.</div>';
        return;
    }

    container.innerHTML = '';
    favoriteStations.forEach(station => {
        const card = document.createElement('div');
        card.className = 'fav-card';

        // Image / placeholder
        let imageHtml;
        if (station.favicon) {
            imageHtml = `<div class="fav-card-image"><img src="${station.favicon}" alt="" onerror="this.parentElement.innerHTML='📻'"></div>`;
        } else {
            imageHtml = `<div class="fav-card-image">📻</div>`;
        }

        // Country flag
        let flagHtml = '';
        if (station.countrycode) {
            const countryCode = station.countrycode.toUpperCase();
            const flag = countryCode
                .split('')
                .map(char => String.fromCodePoint(0x1F1E6 - 65 + char.charCodeAt(0)))
                .join('');
            flagHtml = `<span title="${countryCode}">${flag}</span>`;
        }

        // Bitrate badge
        const bitrate = station.bitrate ? `${station.bitrate}k` : '';

        card.innerHTML = `
            ${imageHtml}
            <div class="fav-card-body">
                <div class="fav-card-name" title="${station.name}">${station.name}</div>
                <div class="fav-card-meta">${flagHtml}${bitrate ? `<span>${bitrate}</span>` : ''}</div>
            </div>
            <div class="fav-card-actions">
                <button class="btn-play" title="Play station">▶</button>
                <button class="btn-info" title="Station info">ℹ️</button>
                <button class="btn-delete" title="Remove">✕</button>
            </div>
        `;

        card.querySelector('.btn-play').addEventListener('click', (e) => {
            e.stopPropagation();
            playUrl(station.url, station.name);
        });

        card.querySelector('.btn-info').addEventListener('click', (e) => {
            e.stopPropagation();
            showStationInfo(station);
        });

        card.querySelector('.btn-delete').addEventListener('click', async (e) => {
            e.stopPropagation();
            await fetch('/api/favorites/delete', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({url: station.url})
            });
            loadFavorites();
        });

        // Clicking the card body also plays
        card.addEventListener('click', () => playUrl(station.url, station.name));

        container.appendChild(card);
    });
}

async function addToFavorites(station) {
    try {
        const res = await fetch('/api/favorites', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                name: station.name,
                url: station.url_resolved,
                favicon: station.favicon,
                bitrate: station.bitrate,
                countrycode: station.countrycode
            })
        });
        const data = await res.json();
        if (data.status === 'success') {
            loadFavorites();
            // alert(`Saved "${station.name}" to favorites!`); // Disabled per user request
        }
    } catch (e) {
        console.error("Failed to save favorite", e);
    }
}

async function searchStations(query) {
    const table = document.getElementById('results-table');
    const tbody = document.getElementById('results-body');
    const btn = document.getElementById('search-btn');

    btn.textContent = "Detailed Search...";
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px;">Searching...</td></tr>';
    table.style.display = 'table';

    try {
        const res = await fetch(`/api/search?name=${encodeURIComponent(query)}`);
        const data = await res.json();
        currentResults = data;
        renderResults(data);
    } catch (e) {
        console.error("Search failed", e);
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px; color: var(--error);">Search failed</td></tr>';
    } finally {
        btn.textContent = "Search";
    }
}

function renderResults(data) {
    const tbody = document.getElementById('results-body');
    tbody.innerHTML = '';

    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px;">No results found</td></tr>';
        return;
    }

    data.forEach((station, index) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border-color)';

        const logoHtml = station.favicon
            ? `<img src="${station.favicon}" style="width: 32px; height: 32px; object-fit: contain; border-radius: 4px;" onerror="this.style.display='none'">`
            : '<span style="font-size:1.5rem">📻</span>';

        tr.innerHTML = `
            <td style="padding: 12px; text-align: center;">${logoHtml}</td>
            <td style="padding: 12px;">${station.name}</td>
            <td style="padding: 12px; color: var(--text-secondary);">${station.countrycode || ''}</td>
            <td style="padding: 12px; color: var(--text-secondary);">${station.bitrate}k</td>
            <td style="padding: 12px; display:flex; gap:8px;">
                <button class="btn-small" onclick="playUrl('${station.url_resolved}', '${station.name.replace(/'/g, "\\'")}')" title="Play">
                   ▶
                </button>
                <button class="btn-small" onclick="showStationInfo(currentResults[${index}])" title="Info" style="background:var(--card-bg); border:1px solid var(--border-color); color:var(--text-primary);">
                   ℹ️
                </button>
                <button class="btn-small" onclick="addToFavorites(currentResults[${index}])" title="Save to Favorites" style="background:var(--card-bg); border:1px solid var(--border-color); color:var(--accent);">
                   ❤️
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function playUrl(url, name) {
    currentSource = 'NETWORK';
    currentStationName = name || currentStationName;
    currentRadioTrack = '';
    setHeaderDisplay(currentStationName || 'Radio');

    // Switch AVR to Radio/NETWORK input first
    try {
        await fetch('/api/input', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({input: 'NETWORK'})
        });
    } catch (e) {
        console.error('Failed to switch to NETWORK input:', e);
    }

    try {
        let apiUrl = `/api/play_url?url=${encodeURIComponent(url)}`;
        if (name) apiUrl += `&name=${encodeURIComponent(name)}`;

        const res = await fetch(apiUrl);
        const data = await res.json();
        console.log("Play result:", data);

        if (data.status === 'success') {
             currentPlayingUrl = url;
             startRadioMetadataPolling();
             setTimeout(updateStatus, 2000);
        } else {
            alert('Failed to play stream: ' + (data.error || 'Unknown error'));
            // Restore header on error
            updateStatus();
        }
    } catch (e) {
        console.error("Play URL failed", e);
        alert("Command failed");
        // Restore header on error
        updateStatus();
    }
}

function resumeRadio() {
    // Show the radio section — AVR input only switches when user actually plays a station
    currentInput = 'NETWORK';
    showInputSection('NETWORK');
    updateStatus();
}


function sortTable(n) {
    // Basic sort implementation could go here, but for simplicity we rely on backend sorting order usually
    // or implement client side sort if requested.
    // The user asked for sortable (name, bitrate, country).
    // Let's do a simple client side sort on currentResults and re-render.

    if (!currentResults.length) return;

    const keys = ['name', 'countrycode', 'bitrate'];
    const key = keys[n];

    currentResults.sort((a, b) => {
        let valA = a[key] || '';
        let valB = b[key] || '';

        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();

        if (key === 'bitrate') {
            return (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0); // High to low for bitrate
        }

        if (valA < valB) return -1;
        if (valA > valB) return 1;
        return 0;
    });

    renderResults(currentResults);
}


async function updateStatus() {
    try {
        const response = await fetch('/api/status');
        const data = await response.json();

        if (data.error) {
            console.error(data.error);
            return;
        }

        // Power State Handling
        const powerOnBtn = document.getElementById('power-on-btn');
        const volumeControls = document.getElementById('volume-controls');
        const isPoweredOn = data.power === 'ON';

        if (isPoweredOn) {
            powerOnBtn.style.display = 'none';
            volumeControls.style.display = 'flex';
        } else {
            powerOnBtn.style.display = 'block';
            volumeControls.style.display = 'none';
        }

        // Update status elements if they exist
        const powerEl = document.getElementById('status-power');
        if (powerEl) powerEl.textContent = data.power || '-';

        const sourceEl = document.getElementById('status-source');
        if (sourceEl) sourceEl.textContent = data.source || '-';

        // Update Mute Icon
        const muteBtn = document.getElementById('mute-btn');
        if (data.muted !== undefined && muteBtn) {
            muteBtn.textContent = data.muted ? '🔇' : '🔊';
            muteBtn.style.opacity = data.muted ? '0.5' : '1';
        }

        // Volume update (only if not dragging to avoid conflict, or simple update)
        // We can check if active element is slider
        if (document.activeElement.id !== 'volume-slider') {
             // Convert API dB value to Absolute (0-98)
             const dbVol = parseFloat(data.volume);
             // Check if it's actually a number
             if (!isNaN(dbVol)) {
                 const absVol = Math.round((dbVol + 80) * 2) / 2; // Round to 0.5
                 // Clamp between 0 and 98 just in case
                 const displayVol = Math.max(0, Math.min(98, absVol));

                 const statusVolEl = document.getElementById('status-volume');
                 if (statusVolEl) statusVolEl.textContent = displayVol;

                 const volValEl = document.getElementById('volume-val');
                 if (volValEl) volValEl.textContent = displayVol;

                 const volSliderEl = document.getElementById('volume-slider');
                 if (volSliderEl) volSliderEl.value = displayVol;
             } else {
                 const statusVolEl = document.getElementById('status-volume');
                 if (statusVolEl) statusVolEl.textContent = '-';
             }
        }

        currentSource = data.source || null;

        if (isPoweredOn && isRadioSource(currentSource)) {
            if (data.station) {
                currentStationName = data.station;
            } else {
                const lastPlayed = await loadLastPlayedStation();
                if (lastPlayed?.name) {
                    currentStationName = lastPlayed.name;
                }
            }

            if (data.url) {
                currentPlayingUrl = data.url;
            }

            updateRadioHeader();
            startRadioMetadataPolling();
        } else {
            stopRadioMetadataPolling();

            let displayText = 'DENON AVR';
            if (data.source) {
                displayText = data.source;
            } else if (data.name) {
                displayText = data.name;
            }

            setHeaderDisplay(displayText);

            const sourceDisplay = document.getElementById('status-source');
            if (sourceDisplay) {
                sourceDisplay.textContent = data.source || '-';
            }
        }

    } catch (e) {
        console.error("Failed to fetch status", e);
    }
}

async function callApi(url) {
    try {
        // Show loading state if we had a global loader, or specific button state
        const res = await fetch(url);
        const data = await res.json();
        console.log("Command result:", data);

        // Refresh status immediately
        setTimeout(updateStatus, 1000);
    } catch (e) {
        console.error("API call failed", e);
        alert("Command failed");
    }
}

// ============ SPOTIFY INTEGRATION ============

let currentSpotifyPlaylist = null;
let allSpotifyPlaylists = [];
let currentSpotifySort = 'name-asc';

// Show/hide input sections based on selected source
function showInputSection(source) {
    const radioSection = document.getElementById('radio-section');
    const spotifySection = document.getElementById('spotify-section');

    // Hide all sections
    radioSection.classList.remove('active');
    spotifySection.classList.remove('active');
    radioSection.style.display = 'none';
    spotifySection.style.display = 'none';

    // Stop Spotify updates if leaving Spotify
    if (source !== 'SPOTIFY' && spotifyUpdateInterval) {
        clearInterval(spotifyUpdateInterval);
        spotifyUpdateInterval = null;
    }

    // Show relevant section
    if (source === 'NETWORK' || source === 'resumeRadio') {
        radioSection.classList.add('active');
        radioSection.style.display = 'block';
    } else if (source === 'SPOTIFY') {
        spotifySection.classList.add('active');
        spotifySection.style.display = 'block';

        // Start periodic updates for Spotify now playing
        if (!spotifyUpdateInterval) {
            updateSpotifyNowPlaying(); // Immediate update
            spotifyUpdateInterval = setInterval(updateSpotifyNowPlaying, 5000); // Every 5 seconds
        }
    }
}

// Control Spotify playback
async function spotifyControl(action) {
    try {
        const res = await fetch('/api/spotify/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
        });

        if (res.ok) {
            console.log(`Spotify ${action} successful`);
            // Update now playing display after a short delay
            setTimeout(updateSpotifyNowPlaying, 500);
        } else {
            const data = await res.json();
            console.error(`Spotify ${action} failed:`, data);
            alert(`Failed to ${action}: ${data.error || 'Unknown error'}`);
        }
    } catch (e) {
        console.error(`Failed to ${action} Spotify`, e);
        alert(`Network error during ${action}`);
    }
}

// Update Spotify now playing display
async function updateSpotifyNowPlaying() {
    try {
        const res = await fetch('/api/spotify/current');
        const data = await res.json();

        const controls = document.getElementById('spotify-controls');
        const artEl = document.getElementById('spotify-art');
        const trackEl = document.getElementById('spotify-track');
        const artistEl = document.getElementById('spotify-artist');
        const playBtn = document.getElementById('spotify-play-btn');
        const pauseBtn = document.getElementById('spotify-pause-btn');

        if (data.track) {
            controls.style.display = 'block';
            artEl.src = data.track.image_url || '';
            trackEl.textContent = data.track.name || 'Unknown Track';
            artistEl.textContent = data.track.artists || 'Unknown Artist';

            // Toggle play/pause button visibility
            if (data.playing) {
                playBtn.style.display = 'none';
                pauseBtn.style.display = 'flex';
            } else {
                playBtn.style.display = 'flex';
                pauseBtn.style.display = 'none';
            }
        } else {
            // No track playing
            controls.style.display = 'none';
        }
    } catch (e) {
        console.error('Failed to update Spotify now playing', e);
        // Don't show controls if there's an error
        document.getElementById('spotify-controls').style.display = 'none';
    }
}

async function checkSpotifyAuth() {
    try {
        const res = await fetch('/api/spotify/status');
        const data = await res.json();

        const authStatus = document.getElementById('spotify-auth-status');
        const spotifyContent = document.getElementById('spotify-content');

        if (data.authenticated) {
            // Show user info and logout button
            authStatus.innerHTML = `
                <span style="color: var(--text-secondary); font-size: 0.9rem;">
                    Logged in as <strong>${data.user.display_name || data.user.id}</strong>
                </span>
                <button class="btn-small" onclick="logoutSpotify()" style="background: var(--card-bg); border: 1px solid var(--border-color);">
                    Logout
                </button>
            `;

            // Load playlists
            loadSpotifyPlaylists();
        } else {
            // Show login button
            authStatus.innerHTML = `
                <button class="btn-small btn-primary" onclick="loginSpotify()">
                    Login with Spotify
                </button>
            `;

            spotifyContent.innerHTML = `
                <div style="text-align: center; color: var(--text-secondary); padding: 20px;">
                    Login with your Spotify Premium account to browse and play your playlists on the Denon AVR.
                </div>
            `;
        }
    } catch (e) {
        console.error("Failed to check Spotify auth", e);
        document.getElementById('spotify-content').innerHTML = `
            <div style="text-align: center; color: var(--error); padding: 20px;">
                Failed to check Spotify authentication status.
            </div>
        `;
    }
}

function loginSpotify() {
    window.location.href = '/spotify/login';
}

async function logoutSpotify() {
    try {
        const res = await fetch('/api/spotify/logout', { method: 'POST' });
        if (res.ok) {
            checkSpotifyAuth();
        }
    } catch (e) {
        console.error("Logout failed", e);
    }
}

async function loadSpotifyPlaylists() {
    const spotifyContent = document.getElementById('spotify-content');
    spotifyContent.innerHTML = '<div style="text-align: center; padding: 20px;">Loading playlists...</div>';

    try {
        const [playlistsRes, recentsRes] = await Promise.all([
            fetch('/api/spotify/playlists'),
            fetch('/api/spotify/recently_played_contexts')
        ]);

        const playlists = await playlistsRes.json();

        if (playlists.error) {
            spotifyContent.innerHTML = `<div style="text-align: center; color: var(--error); padding: 20px;">${playlists.error}</div>`;
            return;
        }

        if (!playlists.length) {
            spotifyContent.innerHTML = `<div style="text-align: center; color: var(--text-secondary); padding: 20px;">No playlists found.</div>`;
            return;
        }

        let recents = { recent_contexts: [] };
        if (recentsRes.ok) {
            recents = await recentsRes.json();
            if (recents.error) recents.recent_contexts = [];
        }

        // Attach lastPlayedRank based on presence in recent_contexts (lower is more recent)
        // If not found in recents, it gets a high rank (999) + its original index to maintain a stable fallback order
        allSpotifyPlaylists = playlists.map((p, index) => {
            let rank = recents.recent_contexts.indexOf(p.uri);
            if (rank === -1) {
                rank = 999 + index; // Fallback to default spotify order
            }
            return { ...p, lastPlayedRank: rank };
        });

        currentSpotifySort = 'last-played';
        renderSpotifyPlaylists();
    } catch (e) {
        console.error("Failed to load Spotify playlists", e);
        spotifyContent.innerHTML = `<div style="text-align: center; color: var(--error); padding: 20px;">Failed to load playlists.</div>`;
    }
}

function sortSpotifyPlaylists(sortKey) {
    if (sortKey === 'name') {
        currentSpotifySort = currentSpotifySort === 'name-asc' ? 'name-desc' : 'name-asc';
    } else if (sortKey === 'tracks') {
        currentSpotifySort = currentSpotifySort === 'tracks-desc' ? 'tracks-asc' : 'tracks-desc';
    } else {
        currentSpotifySort = 'last-played';
    }
    renderSpotifyPlaylists();
}

function renderSpotifyPlaylists() {
    const spotifyContent = document.getElementById('spotify-content');

    // Sort a copy
    const sorted = [...allSpotifyPlaylists];
    if (currentSpotifySort === 'name-asc') {
        sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (currentSpotifySort === 'name-desc') {
        sorted.sort((a, b) => b.name.localeCompare(a.name));
    } else if (currentSpotifySort === 'tracks-asc') {
        sorted.sort((a, b) => a.tracks_total - b.tracks_total);
    } else if (currentSpotifySort === 'tracks-desc') {
        sorted.sort((a, b) => b.tracks_total - a.tracks_total);
    } else if (currentSpotifySort === 'last-played') {
        sorted.sort((a, b) => a.lastPlayedRank - b.lastPlayedRank);
    }

    // Sort toolbar
    let nameLabel = 'Name';
    if (currentSpotifySort === 'name-asc') nameLabel = 'Name (A→Z)';
    if (currentSpotifySort === 'name-desc') nameLabel = 'Name (Z→A)';

    let tracksLabel = 'Tracks';
    if (currentSpotifySort === 'tracks-desc') tracksLabel = 'Tracks ↓';
    if (currentSpotifySort === 'tracks-asc') tracksLabel = 'Tracks ↑';

    const sortOptions = [
        { key: 'last-played', label: 'Last Played', isActive: currentSpotifySort === 'last-played' },
        { key: 'name',        label: nameLabel,     isActive: currentSpotifySort.startsWith('name') },
        { key: 'tracks',      label: tracksLabel,   isActive: currentSpotifySort.startsWith('tracks') },
    ];

    let toolbarHtml = '<div class="sort-bar"><label>Sort:</label>';
    sortOptions.forEach(opt => {
        const activeClass = opt.isActive ? ' active' : '';
        toolbarHtml += `<button class="sort-btn${activeClass}" onclick="sortSpotifyPlaylists('${opt.key}')">${opt.label}</button>`;
    });
    toolbarHtml += '</div>';

    // Grid
    let gridHtml = '<div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px;">';

    sorted.forEach(playlist => {
        const imgHtml = playlist.image_url
            ? `<img src="${playlist.image_url}" style="width: 100%; height: 150px; object-fit: cover; border-radius: 8px; margin-bottom: 8px;" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22150%22 height=%22150%22><rect fill=%22%233a3a3a%22 width=%22150%22 height=%22150%22/><text x=%2250%%22 y=%2250%%22 font-family=%22Arial%22 font-size=%2220%22 fill=%22%23666%22 text-anchor=%22middle%22 dy=%22.3em%22>🎵</text></svg>'">`
            : '<div style="width: 100%; height: 150px; background: var(--input-bg); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 3rem; margin-bottom: 8px;">💚</div>';

        gridHtml += `
            <div class="btn" onclick="showSpotifyPlaylist('${playlist.id}', '${playlist.name.replace(/'/g, "\\'")}', '${playlist.uri || ''}', ${playlist.tracks_total})"
                 style="flex-direction: column; align-items: stretch; padding: 0; overflow: hidden; cursor: pointer;">
                ${imgHtml}
                <div style="padding: 12px;">
                    <div style="font-weight: 600; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${playlist.name}">
                        ${playlist.name}
                    </div>
                    <div style="font-size: 0.85rem; color: var(--text-secondary);">
                        ${playlist.tracks_total} tracks
                    </div>
                </div>
            </div>
        `;
    });

    gridHtml += '</div>';
    spotifyContent.innerHTML = toolbarHtml + gridHtml;
}

async function showSpotifyPlaylist(playlistId, playlistName, playlistUri, trackCount) {
    const modal = document.getElementById('spotify-tracks-modal');
    const title = document.getElementById('spotify-modal-title');
    const info = document.getElementById('spotify-modal-info');
    const tracksList = document.getElementById('spotify-tracks-list');
    const playBtn = document.getElementById('spotify-play-playlist-btn');

    // Store current playlist for playback
    currentSpotifyPlaylist = { id: playlistId, uri: playlistUri, name: playlistName };

    // Set header
    title.textContent = playlistName;
    info.textContent = `${trackCount} tracks`;

    // Show loading
    tracksList.innerHTML = '<div style="text-align: center; padding: 20px;">Loading tracks...</div>';
    modal.style.display = 'flex';

    // Set play button action
    playBtn.onclick = () => {
        playSpotifyPlaylist(playlistUri, playlistName);
        modal.style.display = 'none';
    };

    // Load tracks
    try {
        const res = await fetch(`/api/spotify/playlist/${playlistId}/tracks`);
        const tracks = await res.json();

        if (tracks.error) {
            tracksList.innerHTML = `<div style="text-align: center; color: var(--error); padding: 20px;">${tracks.error}</div>`;
            return;
        }

        if (!tracks.length) {
            tracksList.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px;">No tracks found.</div>';
            return;
        }

        // Render tracks
        let html = '<div style="display: flex; flex-direction: column; gap: 8px;">';
        tracks.forEach((track, index) => {
            const duration = track.duration_ms ? formatDuration(track.duration_ms) : '';
            const imgHtml = track.image_url
                ? `<img src="${track.image_url}" style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px;">`
                : '<div style="width: 40px; height: 40px; background: var(--input-bg); border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 1.2rem;">🎵</div>';

            html += `
                <div style="display: flex; gap: 12px; align-items: center; padding: 8px; background: var(--input-bg); border-radius: 6px; cursor: pointer;"
                     onclick="playSpotifyTrack(['${track.uri}'], '${track.name.replace(/'/g, "\\'")} - ${track.artists.replace(/'/g, "\\'")}')"
                     title="Click to play">
                    ${imgHtml}
                    <div style="flex-grow: 1; min-width: 0;">
                        <div style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            ${track.name}
                        </div>
                        <div style="font-size: 0.85rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            ${track.artists}
                        </div>
                    </div>
                    <div style="color: var(--text-secondary); font-size: 0.85rem; white-space: nowrap;">
                        ${duration}
                    </div>
                </div>
            `;
        });
        html += '</div>';

        tracksList.innerHTML = html;
    } catch (e) {
        console.error("Failed to load tracks", e);
        tracksList.innerHTML = '<div style="text-align: center; color: var(--error); padding: 20px;">Failed to load tracks.</div>';
    }
}

function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

async function playSpotifyPlaylist(playlistUri, playlistName) {
    if (!playlistUri) {
        alert('Cannot play this playlist directly. Try playing individual tracks.');
        return;
    }

    // Switch AVR to Spotify input first
    try {
        await fetch('/api/input', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({input: 'SPOTIFY'})
        });
    } catch (e) {
        console.error('Failed to switch to SPOTIFY input:', e);
    }

    try {
        const res = await fetch('/api/spotify/play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context_uri: playlistUri })
        });

        const data = await res.json();

        if (data.status === 'success') {
            console.log('Spotify playback started');
            setHeaderDisplay(`🎵 ${playlistName}`);
            // Update status
            setTimeout(updateStatus, 2000);
        } else {
            alert(`Error: ${data.error || 'Failed to start playback'}`);
        }
    } catch (e) {
        console.error('Failed to play Spotify', e);
        alert('Failed to start Spotify playback. Make sure AVR is on and Spotify input is available.');
    }
}

async function playSpotifyTrack(trackUris, trackName) {
    try {
        const res = await fetch('/api/spotify/play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ track_uris: trackUris })
        });

        const data = await res.json();

        if (data.status === 'success') {
            console.log('Spotify track playing');
            setHeaderDisplay(trackName);
            setTimeout(updateStatus, 2000);
        } else {
            alert(`Error: ${data.error || 'Failed to play track'}`);
        }
    } catch (e) {
        console.error('Failed to play Spotify track', e);
        alert('Failed to play track.');
    }
}

// Bind Spotify modal close
document.addEventListener('DOMContentLoaded', () => {
    const spotifyModal = document.getElementById('spotify-tracks-modal');
    const closeSpotifyBtn = document.getElementById('close-spotify-modal');

    if (closeSpotifyBtn) {
        closeSpotifyBtn.onclick = () => spotifyModal.style.display = "none";
        window.addEventListener('click', (event) => {
            if (event.target == spotifyModal) spotifyModal.style.display = "none";
        });
    }
});
