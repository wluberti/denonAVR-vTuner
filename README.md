# Denon AVR vTuner Replacement

Since Denon/Marantz discontinued vTuner support for older AVR models (e.g., AVR-3808, AVR-4308), the "Internet Radio" function became useless. This project provides a modern web interface to restore radio functionality using your own server as a proxy.

## Features
- **Radio Browser**: Search and play thousands of stations via radio-browser.info.
- **Favorites**: Save your favorite stations.
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
   # DENON_DISPLAY_METADATA_REFRESH=true
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
When `DENON_DISPLAY_METADATA=true`, the app reads radio metadata when playback starts and sends it as the DLNA title so compatible AVR displays can show artist and song details instead of only the station name. XML for the UPnP request is generated with an XML serializer so special characters in station names, artists, titles, and URLs are escaped correctly.

Live refresh is controlled by `DENON_DISPLAY_METADATA_REFRESH` (on by default). The app checks the current stream every `DENON_DISPLAY_METADATA_UPDATE_INTERVAL` seconds (minimum 10) and pushes new metadata to the AVR **only when the track title actually changes**, while the AVR reports that it is powered on and already using a radio/network source. Pushes are at least 30 seconds apart so the AVR is never hammered.

A refresh sends only `SetAVTransportURI` (no `Play`), which avoids the playback restart older refresh versions caused. A few seconds after each push the app reads back the AVR's displayed title via `GetPositionInfo` to verify it took; if not, it retries once. If the push happened to knock the transport out of `PLAYING`, playback is resumed automatically with a `Play` command. Set `DENON_DISPLAY_METADATA_REFRESH=false` to disable live refresh entirely.
