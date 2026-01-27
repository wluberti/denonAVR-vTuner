document.addEventListener('DOMContentLoaded', () => {
    // Theme Logic
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
        document.body.classList.add('light-theme');
    }

    document.getElementById('theme-toggle').addEventListener('click', () => {
        document.body.classList.toggle('light-theme');
        const isLight = document.body.classList.contains('light-theme');
        localStorage.setItem('theme', isLight ? 'light' : 'dark');
    });

    document.getElementById('refresh-btn').addEventListener('click', () => {
        updateStatus();
    });

    updateStatus();
    loadFavorites();

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
