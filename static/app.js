// Global state
let currentInput = null;
let spotifyUpdateInterval = null;

document.addEventListener('DOMContentLoaded', () => {
    // Theme Logic
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-theme');
    }

    document.getElementById('theme-toggle').addEventListener('click', () => {
        document.body.classList.toggle('dark-theme');
        const isLight = document.body.classList.contains('dark-theme');
        localStorage.setItem('theme', isLight ? 'light' : 'dark');
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
        const btn = document.createElement('div');
        btn.className = 'btn';
        btn.style.position = 'relative';
        btn.style.flexDirection = 'column';
        btn.style.alignItems = 'flex-start';
        btn.style.paddingRight = '40px'; // Space for delete button

        // Logo handling
        let logoHtml = '';
        if (station.favicon) {
            logoHtml = `<img src="${station.favicon}" style="width: 24px; height: 24px; object-fit: contain; margin-bottom: 8px;" onerror="this.style.display='none'">`;
        }

        // Country flag handling
        let flagHtml = '';
        if (station.countrycode) {
            const countryCode = station.countrycode.toUpperCase();
            // Convert country code to flag emoji using regional indicator symbols
            const flag = countryCode
                .split('')
                .map(char => String.fromCodePoint(0x1F1E6 - 65 + char.charCodeAt(0)))
                .join('');
            flagHtml = `<span style="font-size:1.2rem; margin-left:4px;" title="${countryCode}">${flag}</span>`;
        }

        btn.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">${logoHtml} <span>${station.name}</span>${flagHtml}</div>
            <div style="position:absolute; top:8px; right:8px; display:flex; gap:4px;">
                <button class="info-fav btn-icon" style="padding:4px 8px; font-size:1rem;" title="Station Info">ℹ️</button>
                <button class="delete-fav btn-icon" style="padding:4px 8px; font-size:1rem;" title="Remove">✕</button>
            </div>
        `;

        // Click main area to play
        btn.onclick = (e) => {
            if (e.target.closest('.delete-fav') || e.target.closest('.info-fav')) return;
            playUrl(station.url, station.name);
        };

        // Delete button
        btn.querySelector('.delete-fav').onclick = async () => {
            await fetch('/api/favorites/delete', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({url: station.url})
            });
            loadFavorites();
        };

        btn.querySelector('.info-fav').onclick = () => showStationInfo(station);

        container.appendChild(btn);
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
    // Update header immediately with station name
    const headerEl = document.getElementById('current-station');
    if (headerEl && name) {
        headerEl.textContent = name;
    }

    try {
        let apiUrl = `/api/play_url?url=${encodeURIComponent(url)}`;
        if (name) apiUrl += `&name=${encodeURIComponent(name)}`;

        const res = await fetch(apiUrl);
        const data = await res.json();
        console.log("Play result:", data);

        if (data.status === 'success') {
             currentPlayingUrl = url; // Track current
             // Single delayed status update
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

async function resumeRadio() {
    // Update current input and show radio section
    currentInput = 'NETWORK';
    showInputSection('NETWORK');

    try {
        const res = await fetch('/api/last_played');
        if (res.ok) {
            const data = await res.json();
            if (data.url) {
                console.log("Resuming last station:", data.name);
                playUrl(data.url, data.name);
                return;
            }
        }
    } catch (e) {
        console.error("Failed to fetch last played", e);
    }

    // Fallback: Alert user
    alert("No last played station found. Please select a station from the list first.");
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

        // Now Playing Logic and Header Update
        let displayText = 'DENON AVR';
        let nowPlaying = '-';

        if (data.artist && data.title) {
            nowPlaying = `${data.artist} - ${data.title}`;
            displayText = nowPlaying;
        } else if (data.station) {
            nowPlaying = data.station;
            displayText = data.station;
        } else if (data.name) {
             nowPlaying = data.name; // Fallback to AVR display name
        }

        // Show current station when Radio/NET is active, otherwise show input
        if (data.source === 'NET' || data.source === 'IRADIO') {
            if (displayText !== 'DENON AVR') {
                // Already set from nowPlaying
            } else {
                displayText = 'Radio';
            }
        } else if (data.source) {
            // Show the input name
            displayText = data.source;
        }

        // Update header
        const headerEl = document.getElementById('current-station');
        if (headerEl) {
            headerEl.textContent = displayText;
        }

        // We could create a dedicated 'Now Playing' element in the status card if requested.
        // User asked: "Also show playing information on the webinterface"
        // Let's reuse 'Source' or add a new line. The mock only has Power/Source/Volume.
        // Let's append to Source for now or replace Source if it's NET/Radio.

        const sourceDisplay = document.getElementById('status-source');
        if (sourceDisplay) {
            if (data.source === 'NET' || data.source === 'IRADIO') {
                 sourceDisplay.innerHTML = `<strong>${data.source}</strong><br><span style="font-size:0.9em; var(--accent);">${nowPlaying}</span>`;
            } else {
                 sourceDisplay.textContent = data.source;
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
        const res = await fetch('/api/spotify/playlists');
        const playlists = await res.json();

        if (playlists.error) {
            spotifyContent.innerHTML = `
                <div style="text-align: center; color: var(--error); padding: 20px;">
                    ${playlists.error}
                </div>
            `;
            return;
        }

        if (!playlists.length) {
            spotifyContent.innerHTML = `
                <div style="text-align: center; color: var(--text-secondary); padding: 20px;">
                    No playlists found.
                </div>
            `;
            return;
        }

        // Render playlists in a grid
        let html = '<div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px;">';

        playlists.forEach(playlist => {
            const imgHtml = playlist.image_url
                ? `<img src="${playlist.image_url}" style="width: 100%; height: 150px; object-fit: cover; border-radius: 8px; margin-bottom: 8px;" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22150%22 height=%22150%22><rect fill=%22%233a3a3a%22 width=%22150%22 height=%22150%22/><text x=%2250%%22 y=%2250%%22 font-family=%22Arial%22 font-size=%2220%22 fill=%22%23666%22 text-anchor=%22middle%22 dy=%22.3em%22>🎵</text></svg>'">`
                : '<div style="width: 100%; height: 150px; background: var(--input-bg); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 3rem; margin-bottom: 8px;">💚</div>';

            html += `
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

        html += '</div>';
        spotifyContent.innerHTML = html;
    } catch (e) {
        console.error("Failed to load Spotify playlists", e);
        spotifyContent.innerHTML = `
            <div style="text-align: center; color: var(--error); padding: 20px;">
                Failed to load playlists.
            </div>
        `;
    }
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

    try {
        const res = await fetch('/api/spotify/play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context_uri: playlistUri })
        });

        const data = await res.json();

        if (data.status === 'success') {
            console.log('Spotify playback started');
            // Update header to show Spotify is playing
            const headerEl = document.getElementById('current-station');
            if (headerEl) {
                headerEl.textContent = `🎵 ${playlistName}`;
            }
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
            const headerEl = document.getElementById('current-station');
            if (headerEl) {
                headerEl.textContent = trackName;
            }
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
