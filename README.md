# Denon AVR vTuner Replacement

Since Denon/Marantz discontinued vTuner support for older AVR models (e.g., AVR-3808, AVR-4308), the "Internet Radio" function became useless. This project provides a modern web interface to restore radio functionality using your own server as a proxy.

## Features
- **vTuner Emulation**: Restores the AVR's native Internet Radio mode (gapless playback with live track titles on the AVR display) by impersonating the discontinued vTuner/radiodenon.com service.
- **Radio Browser**: Search and play thousands of stations via radio-browser.info.
- **Favorites**: Save your favorite stations — served to both the web UI and the AVR's Internet Radio menu.
- **Spotify Connect**: Browse and play your Spotify playlists directly on the AVR.
- **Input Control**: Easy switching between TV Audio, STB, Radio, and Spotify.
- **Radio Resume**: "Radio" button remembers and resumes the last played station.
- **Volume Control**: Full volume control with slider and mute.
- **Home Assistant Tile**: Custom Lovelace card for AVR controls, radio search, and Spotify search.
- **Modern UI**: Responsive web interface with dark mode.

## Setup

1. **Requirements**: Docker & Docker Compose.
2. **Configuration**:
   Copy `.env.example` to `.env` and set your AVR's IP and Host details:
   ```bash
   cp .env.example .env
   # Edit .env:
   # DENON_IP=192.168.x.x
   # HOST_IP=192.168.x.y     <-- IP of the machine running this app
   # HOST_PORT=8800          <-- Port mapped in docker-compose
   # DENON_DISPLAY_METADATA=true
   # DENON_DISPLAY_TRACK_PUSHES=false
   # DENON_DISPLAY_METADATA_UPDATE_INTERVAL=30
   # HOME_ASSISTANT_CORS_ORIGINS=*  <-- Or comma-separated HA origins, e.g. http://homeassistant.local:8123
   #
   # For Spotify integration (optional):
   # SPOTIFY_CLIENT_ID=your_client_id
   # SPOTIFY_CLIENT_SECRET=your_client_secret
   # SPOTIFY_REDIRECT_URI=http://HOST_IP:HOST_PORT/spotify/callback
   ```
3. **Spotify Setup (Optional)**:
   - Create a Spotify app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
   - Add redirect URI: `http://<HOST_IP>:<HOST_PORT>/spotify/callback`
   - Copy Client ID and Secret to `.env`
   - Requires Spotify Premium account
4. **Run**:
   ```bash
   docker-compose up -d
   ```
5. **Access**: Open `http://<HOST_IP>:8800`.

## Architecture
- **Backend (Flask)**: Proxies streams (HTTPS -> HTTP), handles UPnP/DLNA commands to AVR, integrates Spotify Web API.
- **Frontend**: HTML/JS Single Page Application for control.
- **Home Assistant**: Optional custom Lovelace card served from `/static/denon-vtuner-tile.js`.

## Home Assistant

This project includes a custom tile-style Lovelace card with power, volume,
input selection, radio station selection/search, and Spotify playlist/search
controls.

See [home-assistant/README.md](home-assistant/README.md) and
[home-assistant/dashboard.yaml](home-assistant/dashboard.yaml).

## Denon Display Metadata
When `DENON_DISPLAY_METADATA=true`, the app sends the station name (or the current track, see below) as the DLNA title when playback starts. XML for the UPnP request is generated with an XML serializer so special characters in station names, artists, titles, and URLs are escaped correctly.

### The trade-off: live track titles vs. gapless audio
On the AVRs this project targets there is no way to update the display during DLNA playback without interrupting audio. The display only changes when `SetAVTransportURI` is re-sent, and that always makes the AVR reopen the stream — audible as a short gap. In-stream ICY (Shoutcast) titles are no alternative: tested on an AVR-X4000, the AVR *requests* ICY metadata (`Icy-MetaData: 1`) and strips it correctly, but never shows the titles on its display in DLNA mode.

So there are two modes, chosen with `DENON_DISPLAY_TRACK_PUSHES`:

- `false` (default): no pushes during playback. The display shows the station name, audio is never interrupted.
- `true`: the app checks the current stream every `DENON_DISPLAY_METADATA_UPDATE_INTERVAL` seconds (minimum 10) and pushes new metadata to the AVR **only when the track title actually changes** (at most once per 30 s), while the AVR reports that it is powered on and using a radio/network source. Each push causes a short audio gap on the song change. A push sends only `SetAVTransportURI` (no `Play`); a few seconds later the displayed title is read back via `GetPositionInfo` to verify it took, retrying once, and playback is resumed with `Play` if the push knocked the transport out of `PLAYING`.

The web UI and Home Assistant card always show the live artist/track regardless of this setting — only the AVR front display is affected.

## vTuner Emulation (native Internet Radio — gapless AND live track titles)
The app impersonates the discontinued vTuner service, so the AVR's built-in **Internet Radio** mode works again. In that mode the AVR streams with its own player: audio is never interrupted by metadata updates and the display shows live track titles from the stream (ICY) by itself — the DLNA trade-off above does not apply.

The menu served to the AVR contains your **Favorites** (same `favorites.json` as the web UI), **Search** and **Most Popular** (both via radio-browser.info). HTTPS stations are automatically routed through the app's stream proxy because the AVR cannot do TLS.

Setup:

1. The AVR firmware hardcodes the radio service URL on **port 80**, so the compose file maps host port 80 to the app.
2. Make the AVR resolve the Denon radio service domain to the machine running this app. The **AVR-X4000 generation queries `radiodenon.com`** (which normally redirects to the vTuner backend); older models query `*.vtuner.com` directly. Either:
   - use the bundled dnsmasq service: `docker compose --profile dns up -d` (set `DNS_UPSTREAM` in `.env`, e.g. your router) — it overrides both `radiodenon.com` and `*.vtuner.com` — then set the DNS server in the AVR's network setup (manual/static network configuration on the AVR) to this machine's IP; or
   - if you run Pi-hole/AdGuard: add local DNS records pointing `radiodenon.com` **and** `radiodenon.vtuner.com` to this machine — no AVR changes needed. Make sure the AVR actually uses Pi-hole as its DNS server (it does if your router hands out Pi-hole via DHCP).
3. On the AVR choose **NET → Internet Radio**. The menu (Favorites, Search, Most Popular) now comes from this app.
4. Verify from any machine on the LAN: `curl -H "Host: radiodenon.com" http://<HOST_IP>/setupapp/Denon/asp/BrowseXml/loginXML.asp?token=0` must return `<EncryptedToken>...</EncryptedToken>`, and `docker compose logs web` shows the AVR's `/setupapp/...` requests once it opens the menu (the AVR is the client, so *it* must resolve the domain — testing with curl from a laptop only proves the app side).

### Stream proxy and ICY pass-through
HTTPS station URLs are always routed through the app's `/stream.mp3` proxy because old AVRs cannot do TLS; with `PROXY_ALL_STREAMS=true` plain-HTTP URLs are proxied as well (default off, so direct playback survives app restarts). When a client requests ICY metadata from the proxy (`DENON_ICY_PASSTHROUGH=true`, default), the metadata is passed through untouched together with the `icy-metaint` header; clients that do not ask get a clean stream, since unannounced metadata bytes would play as noise.
