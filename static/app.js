// Global state
let currentInput = null;
let spotifyUpdateInterval = null;
let currentSource = null;
let currentStationName = null;
let currentRadioTrack = '';
let radioMetadataInterval = null;
const RADIO_SOURCES = new Set(['NET', 'IRADIO', 'NETWORK']);
const RADIO_METADATA_INTERVAL_MS = 15000;

function createElement(tagName, options = {}, children = []) {
    const element = document.createElement(tagName);

    Object.entries(options).forEach(([key, value]) => {
        if (value === undefined || value === null) {
            return;
        }

        if (key === 'className') {
            element.className = value;
        } else if (key === 'text') {
            element.textContent = value;
        } else if (key === 'style' && typeof value === 'object') {
            Object.assign(element.style, value);
        } else {
            element.setAttribute(key, value);
        }
    });

    children.forEach((child) => {
        if (child !== undefined && child !== null) {
            element.append(child);
        }
    });

    return element;
}

function setPanelMessage(container, text, color = 'var(--text-secondary)') {
    container.replaceChildren(createElement('div', {
        text,
        style: {
            textAlign: 'center',
            color,
            padding: '20px'
        }
    }));
}

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
        sourceDisplay.replaceChildren(
            createElement('strong', { text: currentSource }),
            document.createElement('br'),
            createElement('span', {
                text: detail,
                style: {
                    fontSize: '0.9em',
                    color: 'var(--accent)'
                }
            })
        );
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

        liveInfo.replaceChildren();
        if (meta.now_playing && meta.now_playing !== 'Unknown') {
            liveInfo.appendChild(createElement('div', {
                text: `🎵 ${meta.now_playing}`,
                style: {
                    fontWeight: 'bold',
                    color: 'var(--accent)',
                    fontSize: '1.1rem'
                }
            }));
        } else {
            liveInfo.appendChild(createElement('div', {
                text: 'No playing info available',
                style: { color: 'var(--text-secondary)' }
            }));
        }

        if (meta.server_name) {
            liveInfo.appendChild(createElement('div', { text: `Server: ${meta.server_name}` }));
        }
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
        container.replaceChildren(createElement('div', {
            text: 'No favorites saved. Search for a station and click ❤️ to save.',
            style: {
                gridColumn: '1 / -1',
                textAlign: 'center',
                color: 'var(--text-secondary)',
                padding: '20px'
            }
        }));
        return;
    }

    container.replaceChildren();
    favoriteStations.forEach(station => {
        const card = document.createElement('div');
        card.className = 'fav-card';

        const imageBox = createElement('div', { className: 'fav-card-image' });
        if (station.favicon) {
            const image = createElement('img', { src: station.favicon, alt: '' });
            image.addEventListener('error', () => imageBox.replaceChildren('📻'));
            imageBox.appendChild(image);
        } else {
            imageBox.textContent = '📻';
        }

        const meta = createElement('div', { className: 'fav-card-meta' });
        if (station.countrycode) {
            const countryCode = station.countrycode.toUpperCase().replace(/[^A-Z]/g, '');
            const flag = countryCode
                .split('')
                .map(char => String.fromCodePoint(0x1F1E6 - 65 + char.charCodeAt(0)))
                .join('');
            if (flag) {
                meta.appendChild(createElement('span', { title: countryCode, text: flag }));
            }
        }

        if (station.bitrate) {
            meta.appendChild(createElement('span', { text: `${station.bitrate}k` }));
        }

        const body = createElement('div', { className: 'fav-card-body' }, [
            createElement('div', {
                className: 'fav-card-name',
                title: station.name,
                text: station.name
            }),
            meta
        ]);

        const playButton = createElement('button', {
            className: 'btn-play',
            title: 'Play station',
            text: '▶'
        });
        const infoButton = createElement('button', {
            className: 'btn-info',
            title: 'Station info',
            text: 'ℹ️'
        });
        const deleteButton = createElement('button', {
            className: 'btn-delete',
            title: 'Remove',
            text: '✕'
        });
        const actions = createElement('div', { className: 'fav-card-actions' }, [
            playButton,
            infoButton,
            deleteButton
        ]);

        card.append(imageBox, body, actions);

        playButton.addEventListener('click', (e) => {
            e.stopPropagation();
            playUrl(station.url, station.name);
        });

        infoButton.addEventListener('click', (e) => {
            e.stopPropagation();
            showStationInfo(station);
        });

        deleteButton.addEventListener('click', async (e) => {
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
    tbody.replaceChildren();

    if (data.length === 0) {
        const row = document.createElement('tr');
        const cell = createElement('td', {
            colspan: '5',
            text: 'No results found',
            style: {
                textAlign: 'center',
                padding: '20px'
            }
        });
        row.appendChild(cell);
        tbody.appendChild(row);
        return;
    }

    data.forEach((station, index) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border-color)';

        const logoCell = createElement('td', {
            style: {
                padding: '12px',
                textAlign: 'center'
            }
        });
        if (station.favicon) {
            const logo = createElement('img', {
                src: station.favicon,
                alt: '',
                style: {
                    width: '32px',
                    height: '32px',
                    objectFit: 'contain',
                    borderRadius: '4px'
                }
            });
            logo.addEventListener('error', () => {
                logo.style.display = 'none';
            });
            logoCell.appendChild(logo);
        } else {
            logoCell.appendChild(createElement('span', {
                text: '📻',
                style: { fontSize: '1.5rem' }
            }));
        }

        const actionsCell = createElement('td', {
            style: {
                padding: '12px',
                display: 'flex',
                gap: '8px'
            }
        });
        const playButton = createElement('button', {
            className: 'btn-small',
            title: 'Play',
            text: '▶'
        });
        const infoButton = createElement('button', {
            className: 'btn-small',
            title: 'Info',
            text: 'ℹ️',
            style: {
                background: 'var(--card-bg)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)'
            }
        });
        const favoriteButton = createElement('button', {
            className: 'btn-small',
            title: 'Save to Favorites',
            text: '❤️',
            style: {
                background: 'var(--card-bg)',
                border: '1px solid var(--border-color)',
                color: 'var(--accent)'
            }
        });

        playButton.addEventListener('click', () => playUrl(station.url_resolved || station.url, station.name));
        infoButton.addEventListener('click', () => showStationInfo(currentResults[index]));
        favoriteButton.addEventListener('click', () => addToFavorites(currentResults[index]));
        actionsCell.append(playButton, infoButton, favoriteButton);

        tr.append(
            logoCell,
            createElement('td', { text: station.name, style: { padding: '12px' } }),
            createElement('td', {
                text: station.countrycode || '',
                style: {
                    padding: '12px',
                    color: 'var(--text-secondary)'
                }
            }),
            createElement('td', {
                text: station.bitrate ? `${station.bitrate}k` : '',
                style: {
                    padding: '12px',
                    color: 'var(--text-secondary)'
                }
            }),
            actionsCell
        );
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
            const loginText = createElement('span', {
                style: {
                    color: 'var(--text-secondary)',
                    fontSize: '0.9rem'
                }
            }, [
                'Logged in as ',
                createElement('strong', { text: data.user.display_name || data.user.id })
            ]);
            const logoutButton = createElement('button', {
                className: 'btn-small',
                text: 'Logout',
                style: {
                    background: 'var(--card-bg)',
                    border: '1px solid var(--border-color)'
                }
            });
            logoutButton.addEventListener('click', logoutSpotify);
            authStatus.replaceChildren(loginText, logoutButton);

            // Load playlists
            loadSpotifyPlaylists();
        } else {
            const loginButton = createElement('button', {
                className: 'btn-small btn-primary',
                text: 'Login with Spotify'
            });
            loginButton.addEventListener('click', loginSpotify);
            authStatus.replaceChildren(loginButton);

            setPanelMessage(
                spotifyContent,
                'Login with your Spotify Premium account to browse and play your playlists on the Denon AVR.'
            );
        }
    } catch (e) {
        console.error("Failed to check Spotify auth", e);
        setPanelMessage(
            document.getElementById('spotify-content'),
            'Failed to check Spotify authentication status.',
            'var(--error)'
        );
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
    setPanelMessage(spotifyContent, 'Loading playlists...', 'var(--text-primary)');

    try {
        const [playlistsRes, recentsRes] = await Promise.all([
            fetch('/api/spotify/playlists'),
            fetch('/api/spotify/recently_played_contexts')
        ]);

        const playlists = await playlistsRes.json();

        if (playlists.error) {
            setPanelMessage(spotifyContent, playlists.error, 'var(--error)');
            return;
        }

        if (!playlists.length) {
            setPanelMessage(spotifyContent, 'No playlists found.');
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
        setPanelMessage(spotifyContent, 'Failed to load playlists.', 'var(--error)');
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
        sorted.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    } else if (currentSpotifySort === 'name-desc') {
        sorted.sort((a, b) => String(b.name || '').localeCompare(String(a.name || '')));
    } else if (currentSpotifySort === 'tracks-asc') {
        sorted.sort((a, b) => (Number(a.tracks_total) || 0) - (Number(b.tracks_total) || 0));
    } else if (currentSpotifySort === 'tracks-desc') {
        sorted.sort((a, b) => (Number(b.tracks_total) || 0) - (Number(a.tracks_total) || 0));
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

    const toolbar = createElement('div', { className: 'sort-bar' }, [
        createElement('label', { text: 'Sort:' })
    ]);
    sortOptions.forEach(opt => {
        const activeClass = opt.isActive ? ' active' : '';
        const button = createElement('button', {
            className: `sort-btn${activeClass}`,
            text: opt.label
        });
        button.addEventListener('click', () => sortSpotifyPlaylists(opt.key));
        toolbar.appendChild(button);
    });

    const grid = createElement('div', {
        className: 'grid',
        style: {
            gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
            gap: '12px'
        }
    });

    const placeholderStyle = {
        width: '100%',
        height: '150px',
        background: 'var(--input-bg)',
        borderRadius: '8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '3rem',
        marginBottom: '8px'
    };

    sorted.forEach(playlist => {
        const imageFallback = () => createElement('div', {
            text: '💚',
            style: placeholderStyle
        });
        const media = playlist.image_url
            ? createElement('img', {
                src: playlist.image_url,
                alt: '',
                style: {
                    width: '100%',
                    height: '150px',
                    objectFit: 'cover',
                    borderRadius: '8px',
                    marginBottom: '8px'
                }
            })
            : imageFallback();

        if (playlist.image_url) {
            media.addEventListener('error', () => media.replaceWith(imageFallback()));
        }

        const card = createElement('div', {
            className: 'btn',
            style: {
                flexDirection: 'column',
                alignItems: 'stretch',
                padding: '0',
                overflow: 'hidden',
                cursor: 'pointer'
            }
        }, [
            media,
            createElement('div', { style: { padding: '12px' } }, [
                createElement('div', {
                    title: playlist.name || '',
                    text: playlist.name || 'Untitled playlist',
                    style: {
                        fontWeight: '600',
                        marginBottom: '4px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                    }
                }),
                createElement('div', {
                    text: `${playlist.tracks_total || 0} tracks`,
                    style: {
                        fontSize: '0.85rem',
                        color: 'var(--text-secondary)'
                    }
                })
            ])
        ]);

        card.addEventListener('click', () => {
            showSpotifyPlaylist(
                playlist.id,
                playlist.name || 'Untitled playlist',
                playlist.uri || '',
                playlist.tracks_total || 0
            );
        });
        grid.appendChild(card);
    });

    spotifyContent.replaceChildren(toolbar, grid);
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
    setPanelMessage(tracksList, 'Loading tracks...', 'var(--text-primary)');
    modal.style.display = 'flex';

    // Set play button action
    playBtn.onclick = () => {
        playSpotifyPlaylist(playlistUri, playlistName);
        modal.style.display = 'none';
    };

    // Load tracks
    try {
        const res = await fetch(`/api/spotify/playlist/${encodeURIComponent(playlistId)}/tracks`);
        const tracks = await res.json();

        if (tracks.error) {
            setPanelMessage(tracksList, tracks.error, 'var(--error)');
            return;
        }

        if (!tracks.length) {
            setPanelMessage(tracksList, 'No tracks found.');
            return;
        }

        const trackList = createElement('div', {
            style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '8px'
            }
        });

        tracks.forEach((track) => {
            const trackName = track.name || 'Unknown track';
            const trackArtists = track.artists || 'Unknown artist';
            const duration = track.duration_ms ? formatDuration(track.duration_ms) : '';
            const imageFallback = () => createElement('div', {
                text: '🎵',
                style: {
                    width: '40px',
                    height: '40px',
                    background: 'var(--input-bg)',
                    borderRadius: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '1.2rem'
                }
            });
            const media = track.image_url
                ? createElement('img', {
                    src: track.image_url,
                    alt: '',
                    style: {
                        width: '40px',
                        height: '40px',
                        objectFit: 'cover',
                        borderRadius: '4px'
                    }
                })
                : imageFallback();

            if (track.image_url) {
                media.addEventListener('error', () => media.replaceWith(imageFallback()));
            }

            const row = createElement('div', {
                title: 'Click to play',
                style: {
                    display: 'flex',
                    gap: '12px',
                    alignItems: 'center',
                    padding: '8px',
                    background: 'var(--input-bg)',
                    borderRadius: '6px',
                    cursor: 'pointer'
                }
            }, [
                media,
                createElement('div', {
                    style: {
                        flexGrow: '1',
                        minWidth: '0'
                    }
                }, [
                    createElement('div', {
                        text: trackName,
                        style: {
                            fontWeight: '500',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                        }
                    }),
                    createElement('div', {
                        text: trackArtists,
                        style: {
                            fontSize: '0.85rem',
                            color: 'var(--text-secondary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                        }
                    })
                ]),
                createElement('div', {
                    text: duration,
                    style: {
                        color: 'var(--text-secondary)',
                        fontSize: '0.85rem',
                        whiteSpace: 'nowrap'
                    }
                })
            ]);

            row.addEventListener('click', () => {
                playSpotifyTrack([track.uri], `${trackName} - ${trackArtists}`);
            });
            trackList.appendChild(row);
        });

        tracksList.replaceChildren(trackList);
    } catch (e) {
        console.error("Failed to load tracks", e);
        setPanelMessage(tracksList, 'Failed to load tracks.', 'var(--error)');
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
