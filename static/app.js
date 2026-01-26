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

    updateStatus();
    loadFavorites();
    // setInterval(updateStatus, 10000); // Poll removed to save connections

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
});

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
        playUrl(station.url_resolved || station.url);
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

        btn.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">${logoHtml} <span>${station.name}</span></div>
            <button class="info-fav" style="position:absolute; bottom:8px; right:8px; background:none; border:none; color:var(--text-secondary); cursor:pointer; font-size:1.2rem;">ℹ️</button>
            <button class="delete-fav" style="position:absolute; top:8px; right:8px; background:none; border:none; color:var(--text-secondary); cursor:pointer;">✕</button>
        `;

        // Click main area to play
        btn.onclick = (e) => {
            if (e.target.closest('.delete-fav') || e.target.closest('.info-fav')) return;
            playUrl(station.url);
        };

        // Delete button
        btn.querySelector('.delete-fav').onclick = async () => {
            if (confirm(`Remove "${station.name}" from favorites?`)) {
                await fetch('/api/favorites/delete', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({url: station.url})
                });
                loadFavorites();
            }
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
                bitrate: station.bitrate
            })
        });
        const data = await res.json();
        if (data.status === 'success') {
            loadFavorites();
            alert(`Saved "${station.name}" to favorites!`);
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
                <button class="btn-small" onclick="playUrl('${station.url_resolved}')" title="Play">
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

async function playUrl(url) {
    // Show instant feedback
    const originalText = document.querySelector('.header h1').innerText;
    document.querySelector('.header h1').innerText = "Requesting Stream...";

    try {
        const res = await fetch(`/api/play_url?url=${encodeURIComponent(url)}`);
        const data = await res.json();
        console.log("Play result:", data);

        if (data.status === 'success') {
             // Refresh status soon
             setTimeout(updateStatus, 2000);
        } else {
            alert('Failed to play stream: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        console.error("Play URL failed", e);
        alert("Command failed");
    } finally {
        setTimeout(() => {
             document.querySelector('.header h1').innerText = "DENON AVR";
        }, 3000);
    }
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

        document.getElementById('status-power').textContent = data.power || '-';
        document.getElementById('status-source').textContent = data.source || '-';
        document.getElementById('status-volume').textContent = data.volume !== undefined ? `${data.volume} dB` : '-';

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
