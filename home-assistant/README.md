# Home Assistant Denon vTuner Tile

This adds a direct Home Assistant Lovelace card for the Flask app in this repo.
It uses the existing vTuner API for AVR power, volume, mute, input selection,
radio station playback, and Spotify playback.

The stock Home Assistant `tile` card can show media-player controls, but it
cannot host the radio and Spotify search/result workflows needed here. This
card is therefore a custom tile-style Lovelace module:

- Power on/off for the Denon AVR.
- Volume slider and mute toggle.
- Input buttons for TV Audio, XS4ALL STB, Radio, and Spotify.
- Radio favorites as station selection.
- Radio search with play and save actions.
- Spotify last-played playlists.
- Spotify search for songs, playlists, and podcast episodes.

## 1. Allow Home Assistant to call the app

If the Home Assistant dashboard is loaded from a different origin than this
Flask app, browsers require CORS headers. By default the app allows all origins
for local dashboard use. To restrict it, set this in `.env`:

```bash
HOME_ASSISTANT_CORS_ORIGINS=http://homeassistant.local:8123,http://192.168.1.10:8123
```

Restart the app after changing `.env`.

## 2. Add the dashboard resource

In Home Assistant, go to **Settings > Dashboards > Resources** and add:

```yaml
url: http://HOST_IP:HOST_PORT/static/denon-vtuner-tile.js?v=0.1.2
type: module
```

Replace `HOST_IP:HOST_PORT` with the host and port for this project, for
example `192.168.1.20:8877`.

If Home Assistant is served over HTTPS, the browser may block an HTTP module.
In that case, either serve this app through HTTPS/reverse proxy or copy
`static/denon-vtuner-tile.js` to Home Assistant's `/config/www` directory and
use `/local/denon-vtuner-tile.js?v=0.1.2` as the resource URL.

## 3. Add the card

Use the YAML in [dashboard.yaml](dashboard.yaml), changing only `api_base_url`
and any labels you want to customize:

```yaml
type: custom:denon-vtuner-tile
name: Denon AVR-X4000
api_base_url: http://HOST_IP:HOST_PORT
refresh_interval: 10
station_limit: 8
playlist_limit: 8
resume_radio_on_select: true
inputs:
  - label: TV Audio
    input: CBL/SAT
    icon: mdi:television
  - label: XS4ALL STB
    input: CD
    icon: mdi:set-top-box
  - label: Radio
    input: NETWORK
    icon: mdi:radio
  - label: Spotify
    input: SPOTIFY
    icon: mdi:spotify
```

## Notes

- Spotify still requires the Spotify OAuth settings from the main project
  README and a Spotify Premium account.
- Selecting Radio resumes the last played station by default. Set
  `resume_radio_on_select: false` if you only want to switch the AVR input.
- The card talks to the Flask app directly, so it does not depend on
  `media_player.denon`. You can keep that entity for other automations.

## Troubleshooting: "Custom element doesn't exist"

Home Assistant shows this when the JavaScript resource did not load or did not
execute. Check these in order:

1. Restart this app after updating the branch, so the new CORS headers are
   active:

   ```bash
   docker compose restart web
   ```

2. Open the resource URL from the same browser/device that runs Home Assistant:

   ```text
   http://HOST_IP:HOST_PORT/static/denon-vtuner-tile.js?v=0.1.2
   ```

   It should show JavaScript text. If it does not, fix `HOST_IP:HOST_PORT` to
   the address reachable from your browser, not only from the Docker host.

3. In Home Assistant, add the resource as **JavaScript Module**. If it already
   exists, update the URL to include `?v=0.1.2`, then refresh the browser.

4. If Home Assistant is on HTTPS and this app is on HTTP, use HTTPS for this
   app or copy the file to `/config/www` and use:

   ```yaml
   url: /local/denon-vtuner-tile.js?v=0.1.2
   type: module
   ```

5. The card YAML must start with:

   ```yaml
   type: custom:denon-vtuner-tile
   ```
