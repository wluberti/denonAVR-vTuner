# AGENTS.md — context for AI agents working on this repo

## What this is
Flask app (single file: `app.py`) that restores internet radio on a Denon AVR-X4000
after Denon/vTuner discontinued the service. Three integration paths:

1. **vTuner emulation** (preferred): app impersonates the vTuner/radiodenon.com
   backend; the AVR's native "NET → Internet Radio" mode browses Favorites/Search/
   Popular served by this app. Native playback is gapless and the AVR shows live
   ICY track titles itself.
2. **DLNA/UPnP**: web UI + Home Assistant card push streams to the AVR via
   `SetAVTransportURI` (AVTransport control at `http://<AVR>:8080/AVTransport/ctrl`).
3. **Spotify Connect** via the Spotify Web API.

## Deployment
- Production: host `192.168.178.106` (ssh alias `docker`, root), checkout at
  `/var/www/sites/denonAVR-vTuner`, `docker compose` serving port 8877 + port 80.
- Deploy: `ssh docker "cd /var/www/sites/denonAVR-vTuner && git pull && docker compose up -d --build"`.
- The local Mac checkout is a dev copy; nothing running here serves the AVR.
- Optional DNS service: `docker compose --profile dns up -d` (dnsmasq overriding
  `radiodenon.com` + `*.vtuner.com` → `HOST_IP`). The user runs Pi-hole as an
  alternative; the AVR must actually use that resolver.

## Hardware facts (established by live testing on the AVR-X4000, 2026-07)
- **`SetAVTransportURI` always makes the AVR reopen the stream** → short audio gap.
  There is NO gapless way to update the display during DLNA playback.
- In DLNA mode the AVR sends `Icy-MetaData: 1` and strips ICY metadata correctly
  but **never displays** in-stream titles. Hence `DENON_DISPLAY_TRACK_PUSHES`
  (default false = gapless, station name only). Do not "fix" the static display
  by adding pushes back by default — that reintroduces the audio gap complaint.
- The X4000's Internet Radio firmware queries **`radiodenon.com`** (not
  `*.vtuner.com`; the real service 301s to `denon.vtuner.com`), hardcoded on
  **port 80**. Protocol: vTuner XML ("ListOfItems"), modelled on milaq/YCast.
  Paths look like `/setupapp/Denon/asp/BrowseXml/loginXML.asp`.
- The AVR cannot do TLS. HTTPS streams must go through `/stream.mp3` proxy.

## Useful diagnostics (AVR is reachable on the LAN)
- AVR status XML: `http://<AVR>/goform/formMainZone_MainZoneXml.xml`
- AVR front-display lines: `http://<AVR>/goform/formNetAudio_StatusXml.xml` (szLine block)
- Transport state / current URI: SOAP `GetTransportInfo` / `GetPositionInfo` to the
  AVTransport control URL (helpers exist in `app.py`).
- Switch AVR input: `http://<AVR>/goform/formiPhoneAppDirect.xml?SI<SOURCE>`
  (e.g. `SIIRADIO`, `SISPOTIFY`). This is audible — the user hears it.
- vTuner smoke test:
  `curl -H "Host: radiodenon.com" "http://<HOST_IP>/setupapp/Denon/asp/BrowseXml/loginXML.asp?token=0"`
- Unhandled vTuner paths are printed to stderr (visible in `docker compose logs web`);
  gunicorn access logs are enabled.

## Conventions / gotchas
- Everything lives in `app.py` on purpose; keep it single-file.
- `DEBUG=false` in prod: `log_debug()` output is invisible there.
- The Home Assistant card is `static/denon-vtuner-tile.js`. When changing it, bump
  `DENON_VTUNER_TILE_VERSION` and every `?v=x.y.z` reference in `home-assistant/`
  (HA caches module resources by URL).
- `home-assistant/lovelace.yaml` is the user's real dashboard (personal entities) —
  update the card config in it when card options change, leave the rest alone.
- `favorites.json` / `last_played.json` / `spotify_tokens.json` are runtime state
  written by the app (bind-mounted in prod).
- radio-browser.info mirrors are flaky; `radio_browser_request()` fails over
  (de2 → de1). Only de1/de2 exist as of 2026-07.
- User priority (why defaults are what they are): **gapless audio beats live track
  info on the AVR display**; the web UI/HA card always show live track info anyway.
