const DENON_VTUNER_DEFAULT_INPUTS = [
  { label: "TV Audio", input: "CBL/SAT", icon: "mdi:television" },
  { label: "XS4ALL STB", input: "CD", icon: "mdi:set-top-box" },
  { label: "Radio", input: "NETWORK", icon: "mdi:radio" },
  { label: "Spotify", input: "SPOTIFY", icon: "mdi:spotify" },
];

const DENON_VTUNER_TILE_VERSION = "0.1.3";
const DENON_VTUNER_RADIO_SOURCES = new Set(["NET", "IRADIO", "NETWORK"]);

function denonVtunerEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function denonVtunerClamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function denonVtunerDuration(ms) {
  if (!ms) {
    return "";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

class DenonVtunerTile extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this.config = null;
    this.apiBase = "";
    this.inputs = DENON_VTUNER_DEFAULT_INPUTS;
    this.status = null;
    this.radioNowPlaying = null;
    this.radioFavorites = [];
    this.radioResults = [];
    this.spotifyAuth = null;
    this.spotifyPlaylists = [];
    this.spotifyCurrent = null;
    this.spotifyResults = [];
    this.activeInput = null;
    this.radioQuery = "";
    this.spotifyQuery = "";
    this.loading = false;
    this.error = "";
    this.pendingVolume = null;
    this.volumeTimer = null;
    this.refreshTimer = null;
    this.listenersInstalled = false;

    this.handleClick = this.handleClick.bind(this);
    this.handleSubmit = this.handleSubmit.bind(this);
    this.handleInput = this.handleInput.bind(this);
  }

  setConfig(config) {
    if (!config || !config.api_base_url) {
      throw new Error("denon-vtuner-tile requires api_base_url");
    }

    this.config = {
      name: "Denon AVR-X4000",
      refresh_interval: 10,
      playlist_limit: 8,
      station_limit: 8,
      resume_radio_on_select: true,
      ...config,
    };

    this.apiBase = this.config.api_base_url.replace(/\/+$/, "");
    this.inputs = Array.isArray(this.config.inputs) && this.config.inputs.length
      ? this.config.inputs
      : DENON_VTUNER_DEFAULT_INPUTS;

    this.render();
  }

  set hass(hass) {
    this._hass = hass;
  }

  connectedCallback() {
    if (!this.listenersInstalled) {
      this.shadowRoot.addEventListener("click", this.handleClick);
      this.shadowRoot.addEventListener("submit", this.handleSubmit);
      this.shadowRoot.addEventListener("input", this.handleInput);
      this.listenersInstalled = true;
    }

    this.refreshAll();
    this.startRefreshTimer();
  }

  disconnectedCallback() {
    window.clearInterval(this.refreshTimer);
    window.clearTimeout(this.volumeTimer);
  }

  getCardSize() {
    return 7;
  }

  startRefreshTimer() {
    window.clearInterval(this.refreshTimer);

    const seconds = Number(this.config?.refresh_interval || 10);
    if (seconds > 0) {
      this.refreshTimer = window.setInterval(() => {
        this.refreshAll({ quiet: true });
      }, seconds * 1000);
    }
  }

  async fetchJson(path, options = {}) {
    const response = await fetch(`${this.apiBase}${path}`, {
      mode: "cors",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    let data = null;
    try {
      data = await response.json();
    } catch (_error) {
      data = {};
    }

    if (!response.ok || data?.error) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }

    return data;
  }

  getJson(path) {
    return this.fetchJson(path);
  }

  postJson(path, body = {}) {
    return this.fetchJson(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async refreshAll({ quiet = false } = {}) {
    if (!this.config || this.loading) {
      return;
    }

    this.loading = !quiet;
    this.error = "";
    this.render();

    try {
      await this.loadStatus();
      await this.loadPanelData();
    } catch (error) {
      this.error = error.message || String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async loadStatus() {
    this.status = await this.getJson("/api/status");
  }

  async loadPanelData() {
    const inputKey = this.activeInput || this.currentInputKey();

    if (inputKey === "NETWORK") {
      if (this.isPoweredOn()) {
        await this.loadRadioData();
      } else {
        await this.loadRadioFavorites();
        this.radioNowPlaying = null;
      }
    } else {
      this.radioNowPlaying = null;
    }

    if (inputKey === "SPOTIFY") {
      await this.loadSpotifyData();
    }
  }

  async loadRadioFavorites() {
    this.radioFavorites = await this.getJson("/api/favorites");
  }

  async loadRadioData() {
    const [favorites, nowPlaying] = await Promise.all([
      this.getJson("/api/favorites"),
      this.getJson("/api/radio_now_playing").catch(() => null),
    ]);

    this.radioFavorites = favorites;
    this.radioNowPlaying = nowPlaying && (nowPlaying.now_playing || nowPlaying.station_name)
      ? nowPlaying
      : null;
  }

  async loadSpotifyData() {
    this.spotifyAuth = await this.getJson("/api/spotify/status");

    if (!this.spotifyAuth?.authenticated) {
      this.spotifyPlaylists = [];
      this.spotifyCurrent = null;
      return;
    }

    const [playlists, recents, current] = await Promise.all([
      this.getJson("/api/spotify/playlists"),
      this.getJson("/api/spotify/recently_played_contexts").catch(() => ({ recent_contexts: [] })),
      this.getJson("/api/spotify/current").catch(() => null),
    ]);

    const recentUris = recents.recent_contexts || [];
    this.spotifyPlaylists = playlists
      .map((playlist, index) => {
        const recentRank = recentUris.indexOf(playlist.uri);
        return {
          ...playlist,
          recentRank: recentRank === -1 ? 999 + index : recentRank,
        };
      })
      .sort((a, b) => a.recentRank - b.recentRank);
    this.spotifyCurrent = current;
  }

  currentInputKey() {
    const source = this.status?.source;

    if (DENON_VTUNER_RADIO_SOURCES.has(source)) {
      return "NETWORK";
    }

    if (source === "SAT/CBL" || source === "CBL/SAT") {
      return "CBL/SAT";
    }

    if (source === "CD" || source === "SPOTIFY") {
      return source;
    }

    return null;
  }

  sourceLabel(inputKey) {
    const input = this.inputs.find((item) => item.input === inputKey);
    return input?.label || inputKey || "Unknown";
  }

  isPoweredOn() {
    return this.status?.power === "ON" || this.status?.state === "on";
  }

  absoluteVolume() {
    if (this.pendingVolume !== null) {
      return this.pendingVolume;
    }

    const dbVolume = Number(this.status?.volume);
    if (Number.isNaN(dbVolume)) {
      return 0;
    }

    return denonVtunerClamp(Math.round((dbVolume + 80) * 2) / 2, 0, 98);
  }

  radioNowPlayingText() {
    if (!this.radioNowPlaying) {
      return "";
    }

    if (this.radioNowPlaying.artist && this.radioNowPlaying.title) {
      return `${this.radioNowPlaying.artist} - ${this.radioNowPlaying.title}`;
    }

    return this.radioNowPlaying.now_playing || "";
  }

  spotifyNowPlayingText() {
    const track = this.spotifyCurrent?.track;
    if (!track) {
      return "";
    }

    return [track.artists, track.name].filter(Boolean).join(" - ");
  }

  render() {
    if (!this.config) {
      this.shadowRoot.innerHTML = "";
      return;
    }

    const inputKey = this.activeInput || this.currentInputKey();
    const sourceText = this.sourceLabel(inputKey || this.currentInputKey());
    const volume = this.absoluteVolume();
    const muted = Boolean(this.status?.muted);
    const powerOn = this.isPoweredOn();
    const station = this.radioNowPlaying?.station_name || this.status?.station;
    const nowPlaying = inputKey === "NETWORK"
      ? this.radioNowPlayingText()
      : this.spotifyNowPlayingText();
    const subtitle = [sourceText, station, nowPlaying].filter(Boolean).join(" | ");

    this.shadowRoot.innerHTML = `
      <style>${this.styles()}</style>
      <ha-card>
        <div class="card-shell">
          <header class="header">
            <div class="title-block">
              <div class="eyebrow">${powerOn ? "Online" : "Standby"}</div>
              <h2>${denonVtunerEscape(this.config.name)}</h2>
              <p>${denonVtunerEscape(subtitle || "Ready")}</p>
            </div>
            <div class="header-actions">
              <button class="icon-button" data-action="refresh" title="Refresh">
                <ha-icon icon="mdi:refresh"></ha-icon>
              </button>
              <button class="icon-button ${powerOn ? "danger" : "primary"}" data-action="power" title="${powerOn ? "Power off" : "Power on"}">
                <ha-icon icon="${powerOn ? "mdi:power" : "mdi:power-on"}"></ha-icon>
              </button>
            </div>
          </header>

          ${this.error ? `<div class="notice error">${denonVtunerEscape(this.error)}</div>` : ""}
          ${this.loading ? `<div class="notice">Loading...</div>` : ""}

          <section class="volume-row">
            <button class="icon-button ${muted ? "active" : ""}" data-action="mute" title="${muted ? "Unmute" : "Mute"}">
              <ha-icon icon="${muted ? "mdi:volume-off" : "mdi:volume-high"}"></ha-icon>
            </button>
            <input class="volume-slider" data-field="volume" type="range" min="0" max="98" step="0.5" value="${volume}" aria-label="Volume">
            <span class="volume-value">${volume}</span>
          </section>

          <section class="input-grid">
            ${this.renderInputButtons(inputKey)}
          </section>

          ${inputKey === "NETWORK" ? this.renderRadioPanel() : ""}
          ${inputKey === "SPOTIFY" ? this.renderSpotifyPanel() : ""}
        </div>
      </ha-card>
    `;
  }

  renderInputButtons(activeInput) {
    return this.inputs
      .map((input) => {
        const active = input.input === activeInput ? "active" : "";
        return `
          <button class="input-button ${active}" data-action="select-input" data-input="${denonVtunerEscape(input.input)}">
            <ha-icon icon="${denonVtunerEscape(input.icon || "mdi:audio-video")}"></ha-icon>
            <span>${denonVtunerEscape(input.label)}</span>
          </button>
        `;
      })
      .join("");
  }

  renderRadioPanel() {
    const stationLimit = Number(this.config.station_limit || 8);
    const favorites = this.radioFavorites.slice(0, stationLimit);

    return `
      <section class="panel">
        <div class="section-heading">
          <h3>Radio Stations</h3>
          <span>${this.radioFavorites.length} saved</span>
        </div>
        ${this.renderRadioCurrent()}
        <div class="item-list">
          ${favorites.length ? favorites.map((station, index) => this.renderRadioItem(station, index, "favorite")).join("") : `
            <div class="empty">No saved stations yet. Search below to play or save one.</div>
          `}
        </div>
        <form class="search-row" data-form="radio-search">
          <input data-field="radio-query" type="search" value="${denonVtunerEscape(this.radioQuery)}" placeholder="Search new stations">
          <button class="text-button primary" type="submit">Search</button>
        </form>
        <div class="item-list compact">
          ${this.radioResults.map((station, index) => this.renderRadioItem(station, index, "search")).join("")}
        </div>
      </section>
    `;
  }

  renderRadioCurrent() {
    const station = this.radioNowPlaying?.station_name || this.status?.station || "";
    const nowPlaying = this.radioNowPlayingText();

    if (!station && !nowPlaying) {
      return "";
    }

    return `
      <div class="now-playing">
        <div class="thumb placeholder">
          <ha-icon icon="mdi:radio-tower"></ha-icon>
        </div>
        <div class="media-copy">
          <strong>${denonVtunerEscape(nowPlaying || station)}</strong>
          <span>${denonVtunerEscape(nowPlaying ? station || "Radio" : "Current station")}</span>
        </div>
        <span class="pill">Live</span>
      </div>
    `;
  }

  renderRadioItem(station, index, source) {
    const subtitle = [station.countrycode || station.country, station.bitrate ? `${station.bitrate} kbps` : ""]
      .filter(Boolean)
      .join(" | ");

    return `
      <div class="media-item">
        ${this.renderImage(station.favicon, "mdi:radio")}
        <div class="media-copy">
          <strong>${denonVtunerEscape(station.name)}</strong>
          <span>${denonVtunerEscape(subtitle || "Internet radio")}</span>
        </div>
        <button class="icon-button primary" data-action="play-radio" data-source="${source}" data-index="${index}" title="Play station">
          <ha-icon icon="mdi:play"></ha-icon>
        </button>
        ${source === "search" ? `
          <button class="icon-button" data-action="save-radio" data-index="${index}" title="Save station">
            <ha-icon icon="mdi:heart-outline"></ha-icon>
          </button>
        ` : ""}
      </div>
    `;
  }

  renderSpotifyPanel() {
    if (this.spotifyAuth && !this.spotifyAuth.authenticated) {
      return `
        <section class="panel">
          <div class="section-heading">
            <h3>Spotify</h3>
          </div>
          <div class="empty">Spotify is not authenticated in the vTuner app.</div>
          <button class="text-button primary wide" data-action="spotify-login">Login with Spotify</button>
        </section>
      `;
    }

    const playlistLimit = Number(this.config.playlist_limit || 8);
    const playlists = this.spotifyPlaylists.slice(0, playlistLimit);

    return `
      <section class="panel">
        <div class="section-heading">
          <h3>Last Played Playlists</h3>
          <span>${this.spotifyAuth?.authenticated ? "Connected" : "Checking"}</span>
        </div>
        ${this.renderSpotifyCurrent()}
        <div class="item-list">
          ${playlists.length ? playlists.map((playlist, index) => this.renderSpotifyPlaylist(playlist, index)).join("") : `
            <div class="empty">No playlists available yet.</div>
          `}
        </div>
        <form class="search-row" data-form="spotify-search">
          <input data-field="spotify-query" type="search" value="${denonVtunerEscape(this.spotifyQuery)}" placeholder="Search songs, playlists, podcasts">
          <button class="text-button primary" type="submit">Search</button>
        </form>
        <div class="item-list compact">
          ${this.spotifyResults.map((item, index) => this.renderSpotifyResult(item, index)).join("")}
        </div>
      </section>
    `;
  }

  renderSpotifyCurrent() {
    const track = this.spotifyCurrent?.track;
    if (!track) {
      return "";
    }

    return `
      <div class="now-playing">
        ${this.renderImage(track.image_url, "mdi:music")}
        <div class="media-copy">
          <strong>${denonVtunerEscape(track.name)}</strong>
          <span>${denonVtunerEscape(track.artists)}</span>
        </div>
        <span class="pill">${this.spotifyCurrent.playing ? "Playing" : "Paused"}</span>
      </div>
    `;
  }

  renderSpotifyPlaylist(playlist, index) {
    const disabled = playlist.uri ? "" : "disabled";
    return `
      <div class="media-item ${disabled}">
        ${this.renderImage(playlist.image_url, "mdi:playlist-music")}
        <div class="media-copy">
          <strong>${denonVtunerEscape(playlist.name)}</strong>
          <span>${denonVtunerEscape(`${playlist.tracks_total || 0} tracks`)}</span>
        </div>
        <button class="icon-button primary" data-action="play-spotify-playlist" data-index="${index}" ${disabled} title="Play playlist">
          <ha-icon icon="mdi:play"></ha-icon>
        </button>
      </div>
    `;
  }

  renderSpotifyResult(item, index) {
    const duration = denonVtunerDuration(item.duration_ms);
    const subtitle = [item.label, item.subtitle, duration].filter(Boolean).join(" | ");

    return `
      <div class="media-item">
        ${this.renderImage(item.image_url, item.type === "playlist" ? "mdi:playlist-music" : "mdi:music")}
        <div class="media-copy">
          <strong>${denonVtunerEscape(item.name)}</strong>
          <span>${denonVtunerEscape(subtitle)}</span>
        </div>
        <button class="icon-button primary" data-action="play-spotify-result" data-index="${index}" title="Play">
          <ha-icon icon="mdi:play"></ha-icon>
        </button>
      </div>
    `;
  }

  renderImage(url, icon) {
    if (url) {
      return `<img class="thumb" src="${denonVtunerEscape(url)}" alt="" loading="lazy">`;
    }

    return `
      <div class="thumb placeholder">
        <ha-icon icon="${denonVtunerEscape(icon)}"></ha-icon>
      </div>
    `;
  }

  async handleClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) {
      return;
    }

    const action = button.dataset.action;
    button.disabled = true;

    try {
      if (action === "refresh") {
        await this.refreshAll();
      } else if (action === "power") {
        await this.togglePower();
      } else if (action === "mute") {
        await this.postJson("/api/mute/toggle");
        await this.refreshAll({ quiet: true });
      } else if (action === "select-input") {
        await this.selectInput(button.dataset.input);
      } else if (action === "play-radio") {
        await this.playRadioFromButton(button);
      } else if (action === "save-radio") {
        await this.saveRadioResult(Number(button.dataset.index));
      } else if (action === "spotify-login") {
        window.open(`${this.apiBase}/spotify/login`, "_blank", "noopener");
      } else if (action === "play-spotify-playlist") {
        await this.playSpotifyPlaylist(Number(button.dataset.index));
      } else if (action === "play-spotify-result") {
        await this.playSpotifyResult(Number(button.dataset.index));
      }
    } catch (error) {
      this.error = error.message || String(error);
      this.render();
    } finally {
      button.disabled = false;
    }
  }

  async handleSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) {
      return;
    }

    event.preventDefault();

    if (form.dataset.form === "radio-search") {
      const input = form.querySelector('[data-field="radio-query"]');
      this.radioQuery = input.value.trim();
      await this.searchRadio();
    }

    if (form.dataset.form === "spotify-search") {
      const input = form.querySelector('[data-field="spotify-query"]');
      this.spotifyQuery = input.value.trim();
      await this.searchSpotify();
    }
  }

  handleInput(event) {
    const field = event.target.dataset.field;

    if (field === "radio-query") {
      this.radioQuery = event.target.value;
    }

    if (field === "spotify-query") {
      this.spotifyQuery = event.target.value;
    }

    if (field === "volume") {
      const value = Number(event.target.value);
      this.pendingVolume = value;

      const volumeValue = this.shadowRoot.querySelector(".volume-value");
      if (volumeValue) {
        volumeValue.textContent = String(value);
      }

      window.clearTimeout(this.volumeTimer);
      this.volumeTimer = window.setTimeout(() => {
        this.setVolume(value);
      }, 250);
    }
  }

  async togglePower() {
    await this.postJson(this.isPoweredOn() ? "/api/power/off" : "/api/power/on");
    await this.refreshAll({ quiet: true });
  }

  async setVolume(value) {
    const dbVolume = Number(value) - 80;
    await this.postJson("/api/volume", { volume: dbVolume });
    this.pendingVolume = null;
    await this.refreshAll({ quiet: true });
  }

  async selectInput(input) {
    this.activeInput = input;
    this.error = "";
    this.render();

    if (input === "NETWORK") {
      await this.loadRadioFavorites();

      if (this.config.resume_radio_on_select !== false) {
        const lastPlayed = await this.getJson("/api/last_played").catch(() => null);
        if (lastPlayed?.url) {
          await this.playRadioStation(lastPlayed);
          return;
        }
      }
    }

    await this.postJson("/api/input", { input });

    if (input === "SPOTIFY") {
      await this.loadSpotifyData();
    }

    await this.refreshAll({ quiet: true });
  }

  async searchRadio() {
    if (this.radioQuery.length < 2) {
      this.radioResults = [];
      this.render();
      return;
    }

    this.loading = true;
    this.render();

    try {
      this.radioResults = await this.getJson(`/api/search?name=${encodeURIComponent(this.radioQuery)}`);
      this.error = "";
    } catch (error) {
      this.error = error.message || String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async playRadioFromButton(button) {
    const source = button.dataset.source;
    const index = Number(button.dataset.index);
    const station = source === "favorite" ? this.radioFavorites[index] : this.radioResults[index];
    await this.playRadioStation(station);
  }

  async playRadioStation(station) {
    const url = station?.url_resolved || station?.url || station?.playback_url;
    const name = station?.name || station?.station_name || "Radio";

    if (!url) {
      throw new Error("Station has no stream URL");
    }

    await this.postJson("/api/input", { input: "NETWORK" }).catch(() => null);
    await this.getJson(`/api/play_url?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`);
    this.activeInput = "NETWORK";
    await this.refreshAll({ quiet: true });
  }

  async saveRadioResult(index) {
    const station = this.radioResults[index];
    if (!station) {
      return;
    }

    await this.postJson("/api/favorites", {
      name: station.name,
      url: station.url_resolved || station.url,
      favicon: station.favicon,
      bitrate: station.bitrate,
      countrycode: station.countrycode,
    });
    await this.loadRadioFavorites();
    this.render();
  }

  async searchSpotify() {
    if (this.spotifyQuery.length < 2) {
      this.spotifyResults = [];
      this.render();
      return;
    }

    this.loading = true;
    this.render();

    try {
      this.spotifyResults = await this.getJson(
        `/api/spotify/search?q=${encodeURIComponent(this.spotifyQuery)}&types=track,playlist,episode`
      );
      this.error = "";
    } catch (error) {
      this.error = error.message || String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async playSpotifyPlaylist(index) {
    const playlist = this.spotifyPlaylists[index];
    if (!playlist?.uri) {
      throw new Error("Playlist cannot be played directly");
    }

    await this.postJson("/api/spotify/play", { context_uri: playlist.uri });
    this.activeInput = "SPOTIFY";
    await this.refreshAll({ quiet: true });
  }

  async playSpotifyResult(index) {
    const item = this.spotifyResults[index];
    if (!item?.uri) {
      return;
    }

    if (item.type === "playlist") {
      await this.postJson("/api/spotify/play", { context_uri: item.uri });
    } else {
      await this.postJson("/api/spotify/play", { uris: [item.uri] });
    }

    this.activeInput = "SPOTIFY";
    await this.refreshAll({ quiet: true });
  }

  styles() {
    return `
      :host {
        display: block;
      }

      ha-card {
        overflow: hidden;
      }

      .card-shell {
        display: grid;
        gap: 16px;
        padding: 16px;
      }

      .header {
        align-items: flex-start;
        display: flex;
        gap: 12px;
        justify-content: space-between;
      }

      .title-block {
        min-width: 0;
      }

      .eyebrow {
        color: var(--secondary-text-color);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      h2,
      h3,
      p {
        margin: 0;
      }

      h2 {
        color: var(--primary-text-color);
        font-size: 20px;
        line-height: 1.25;
      }

      h3 {
        color: var(--primary-text-color);
        font-size: 14px;
        font-weight: 700;
      }

      p {
        color: var(--secondary-text-color);
        font-size: 13px;
        margin-top: 3px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .header-actions,
      .volume-row,
      .search-row,
      .section-heading,
      .media-item,
      .now-playing {
        align-items: center;
        display: flex;
      }

      .header-actions {
        gap: 8px;
      }

      button {
        font: inherit;
      }

      button:disabled {
        cursor: progress;
        opacity: 0.55;
      }

      .icon-button,
      .input-button,
      .text-button {
        background: var(--ha-card-background, var(--card-background-color));
        border: 1px solid var(--divider-color);
        color: var(--primary-text-color);
        cursor: pointer;
      }

      .icon-button {
        align-items: center;
        border-radius: 8px;
        display: inline-flex;
        height: 40px;
        justify-content: center;
        min-width: 40px;
        padding: 0;
      }

      .icon-button.primary,
      .text-button.primary,
      .input-button.active {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: var(--text-primary-color);
      }

      .icon-button.danger {
        color: var(--error-color);
      }

      .icon-button.active {
        color: var(--warning-color);
      }

      .notice {
        background: color-mix(in srgb, var(--primary-color) 12%, transparent);
        border-radius: 8px;
        color: var(--primary-text-color);
        font-size: 13px;
        padding: 10px 12px;
      }

      .notice.error {
        background: color-mix(in srgb, var(--error-color) 14%, transparent);
        color: var(--error-color);
      }

      .volume-row {
        gap: 10px;
      }

      .volume-slider {
        accent-color: var(--primary-color);
        flex: 1;
        min-width: 80px;
      }

      .volume-value {
        color: var(--secondary-text-color);
        font-variant-numeric: tabular-nums;
        min-width: 34px;
        text-align: right;
      }

      .input-grid {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .input-button {
        align-items: center;
        border-radius: 8px;
        display: grid;
        gap: 6px;
        justify-items: center;
        min-height: 74px;
        min-width: 0;
        padding: 10px 6px;
      }

      .input-button span {
        font-size: 12px;
        line-height: 1.2;
        overflow-wrap: anywhere;
        text-align: center;
      }

      .panel {
        border-top: 1px solid var(--divider-color);
        display: grid;
        gap: 12px;
        padding-top: 14px;
      }

      .section-heading {
        justify-content: space-between;
      }

      .section-heading span {
        color: var(--secondary-text-color);
        font-size: 12px;
      }

      .item-list {
        display: grid;
        gap: 8px;
      }

      .item-list.compact {
        gap: 6px;
      }

      .media-item,
      .now-playing {
        background: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
        border-radius: 8px;
        gap: 10px;
        min-width: 0;
        padding: 8px;
      }

      .media-item.disabled {
        opacity: 0.6;
      }

      .thumb {
        background: color-mix(in srgb, var(--primary-text-color) 8%, transparent);
        border-radius: 7px;
        flex: 0 0 44px;
        height: 44px;
        object-fit: cover;
        overflow: hidden;
        width: 44px;
      }

      .placeholder {
        align-items: center;
        color: var(--secondary-text-color);
        display: flex;
        justify-content: center;
      }

      .media-copy {
        display: grid;
        flex: 1;
        gap: 2px;
        min-width: 0;
      }

      .media-copy strong,
      .media-copy span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .media-copy strong {
        color: var(--primary-text-color);
        font-size: 13px;
      }

      .media-copy span {
        color: var(--secondary-text-color);
        font-size: 12px;
      }

      .search-row {
        gap: 8px;
      }

      input[type="search"] {
        background: var(--ha-card-background, var(--card-background-color));
        border: 1px solid var(--divider-color);
        border-radius: 8px;
        color: var(--primary-text-color);
        flex: 1;
        font: inherit;
        min-height: 40px;
        min-width: 0;
        padding: 0 12px;
      }

      .text-button {
        border-radius: 8px;
        font-weight: 700;
        min-height: 40px;
        padding: 0 14px;
      }

      .text-button.wide {
        width: 100%;
      }

      .empty {
        color: var(--secondary-text-color);
        font-size: 13px;
        padding: 8px 2px;
      }

      .pill {
        background: color-mix(in srgb, var(--primary-color) 15%, transparent);
        border-radius: 999px;
        color: var(--primary-color);
        font-size: 11px;
        font-weight: 700;
        padding: 4px 8px;
      }

      @media (max-width: 520px) {
        .input-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .header {
          align-items: stretch;
          flex-direction: column;
        }

        .header-actions {
          justify-content: flex-end;
        }
      }
    `;
  }
}

if (!customElements.get("denon-vtuner-tile")) {
  customElements.define("denon-vtuner-tile", DenonVtunerTile);
}

window.customCards = Array.isArray(window.customCards) ? window.customCards : [];
window.denonVtunerTileVersion = DENON_VTUNER_TILE_VERSION;

if (!window.customCards.some((card) => card && card.type === "denon-vtuner-tile")) {
  window.customCards.push({
    type: "denon-vtuner-tile",
    name: "Denon vTuner Tile",
    description: "Control a Denon AVR vTuner replacement from Home Assistant.",
  });
}
