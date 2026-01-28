# Denon AVR vTuner Replacement

Since Denon/Marantz discontinued vTuner support for older AVR models (e.g., AVR-3808, AVR-4308), the "Internet Radio" function became useless. This project provides a modern web interface to restore radio functionality using your own server as a proxy.

## Features
- **Radio Browser**: Search and play thousands of stations via radio-browser.info.
- **Favorites**: Save your favorite stations.
- **Spotify Connect**: Browse and play your Spotify playlists directly on the AVR.
- **Input Control**: Easy switching between TV Audio, STB, Radio, and Spotify.
- **Radio Resume**: "Radio" button remembers and resumes the last played station.
- **Volume Control**: Full volume control with slider and mute.
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
