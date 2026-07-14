from flask import Flask, render_template, jsonify, request, redirect, session, url_for
import sys
import requests
import os
import socket
import html
import json
import time
import threading
import re
from urllib.parse import quote, unquote, urljoin
import xml.etree.ElementTree as ET
from dotenv import load_dotenv
import spotipy
from spotipy.oauth2 import SpotifyOAuth

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", os.urandom(24))

def get_env_int(name, default):
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default

def get_env_bool(name, default=False):
    default_value = "true" if default else "false"
    return os.getenv(name, default_value).lower() in ("true", "1", "yes")

def get_env_list(name, default=""):
    raw_value = os.getenv(name, default)
    return [item.strip() for item in raw_value.split(",") if item.strip()]

# Configuration
DENON_IP = os.getenv("DENON_IP")
DEBUG = get_env_bool("DEBUG")
DENON_DISPLAY_METADATA = get_env_bool("DENON_DISPLAY_METADATA", True)
# Push live track titles to the AVR display over UPnP when the song changes.
# The only way to update the display of these AVRs during DLNA playback is to
# re-send SetAVTransportURI, which makes the AVR reopen the stream — audible
# as a short gap on every song change (confirmed on AVR-X4000; it requests
# in-stream ICY titles but never displays them in DLNA mode). Off by default:
# the display then shows the station name and audio is never interrupted.
DENON_DISPLAY_TRACK_PUSHES = get_env_bool("DENON_DISPLAY_TRACK_PUSHES", False)
DENON_DISPLAY_METADATA_MIN_POLL_INTERVAL = 10
DENON_DISPLAY_METADATA_POLL_INTERVAL = max(
    DENON_DISPLAY_METADATA_MIN_POLL_INTERVAL,
    get_env_int("DENON_DISPLAY_METADATA_UPDATE_INTERVAL", 30)
)
# The AVR display is only pushed to when the track title actually changes;
# this is the minimum gap between two pushes so the AVR is never hammered.
DENON_DISPLAY_METADATA_MIN_PUSH_INTERVAL = 30
DENON_DISPLAY_METADATA_VERIFY_DELAY_SECONDS = 5
DENON_DISPLAY_METADATA_MAX_PUSH_ATTEMPTS = 2
# Pass ICY (Shoutcast) metadata through the stream proxy when the AVR asks for
# it (harmless for clients that can use it; the X4000 asks but ignores it).
DENON_ICY_PASSTHROUGH = get_env_bool("DENON_ICY_PASSTHROUGH", True)
# Route plain-HTTP streams through the proxy as well (HTTPS always is, since
# old AVRs can't do TLS). Off by default: direct playback survives app
# restarts and the proxy adds nothing for the AVR display.
PROXY_ALL_STREAMS = get_env_bool("PROXY_ALL_STREAMS", False)
HOME_ASSISTANT_CORS_ORIGINS = get_env_list("HOME_ASSISTANT_CORS_ORIGINS", "*")

# Spotify Configuration
SPOTIFY_CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET")
SPOTIFY_REDIRECT_URI = os.getenv("SPOTIFY_REDIRECT_URI")
SPOTIFY_SCOPE = "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-library-read user-read-recently-played"
SPOTIFY_TOKENS_FILE = os.path.join(os.path.dirname(__file__), "spotify_tokens.json")

def log_debug(msg):
    if DEBUG:
        print(f"[DEBUG] {msg}", file=sys.stderr)

# State persistence
LAST_PLAYED_FILE = os.path.join(os.path.dirname(__file__), "last_played.json")
RADIO_SOURCES = {"NET", "IRADIO", "NETWORK"}
_AV_TRANSPORT_CONTROL_URL = None
_LAST_DENON_DISPLAY_UPDATE = {"url": None, "title": None, "at": 0}
_DENON_DISPLAY_UPDATE_LOCK = threading.Lock()
_DENON_DISPLAY_WORKER_LOCK = threading.Lock()
_DENON_DISPLAY_WORKER_STARTED = False

ICY_METADATA_READ_TIMEOUT = 6
ICY_METADATA_MAX_BLOCKS = 4
ICY_METADATA_READ_CHUNK_SIZE = 16384


XML_INVALID_CHARS_RE = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F]")
DIDL_NS = "urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"
DC_NS = "http://purl.org/dc/elements/1.1/"
UPNP_NS = "urn:schemas-upnp-org:metadata-1-0/upnp/"
DLNA_NS = "urn:schemas-dlna-org:metadata-1-0/"
SOAP_ENV_NS = "http://schemas.xmlsoap.org/soap/envelope/"
AVTRANSPORT_NS = "urn:schemas-upnp-org:service:AVTransport:1"

ET.register_namespace("", DIDL_NS)
ET.register_namespace("dc", DC_NS)
ET.register_namespace("upnp", UPNP_NS)
ET.register_namespace("dlna", DLNA_NS)
ET.register_namespace("s", SOAP_ENV_NS)
ET.register_namespace("u", AVTRANSPORT_NS)

def save_last_played(url, name, playback_url=None):
    try:
        data = {"url": url, "name": name}
        if playback_url and playback_url != url:
            data["playback_url"] = playback_url
        with open(LAST_PLAYED_FILE, "w") as f:
            json.dump(data, f)
    except Exception as e:
        log_debug(f"Failed to save last played: {e}")

def get_last_played():
    try:
        if os.path.exists(LAST_PLAYED_FILE):
             with open(LAST_PLAYED_FILE, "r") as f:
                 return json.load(f)
    except Exception as e:
        log_debug(f"Failed to load last played: {e}")
    return None

def normalize_now_playing(value):
    if not value:
        return None

    cleaned = value.replace("\x00", "").strip()
    if not cleaned or cleaned.lower() == "unknown":
        return None

    return cleaned

def split_now_playing(value):
    normalized = normalize_now_playing(value)
    if not normalized or " - " not in normalized:
        return None, None

    artist, title = normalized.split(" - ", 1)
    artist = artist.strip()
    title = title.strip()

    if not artist or not title:
        return None, None

    return artist, title

def unwrap_proxy_url(url):
    if not url:
        return url

    if "/stream.mp3?url=" not in url:
        return url

    return unquote(url.split("url=", 1)[1])

def get_playback_url(stream_url):
    if not stream_url:
        return stream_url

    lowered = stream_url.lower()
    if "/stream.mp3?url=" in lowered:
        return stream_url

    if not lowered.startswith("https://") and not (
        PROXY_ALL_STREAMS and lowered.startswith("http://")
    ):
        return stream_url

    local_ip = os.getenv("HOST_IP")
    if not local_ip:
        local_ip = get_local_ip()

    host_port = os.getenv("HOST_PORT", "5000")
    log_debug(f"Detected Local IP: {local_ip}, Port: {host_port}")

    proxy_url = f"http://{local_ip}:{host_port}/stream.mp3?url={quote(stream_url, safe='')}"
    log_debug(f"Rewriting HTTPS url to HTTP Proxy: {proxy_url}")
    return proxy_url

def get_denon_display_title(station_name, now_playing=None):
    # Without track pushes the display is set once, at playback start; a track
    # title would freeze there and go stale, so prefer the station name.
    if not DENON_DISPLAY_TRACK_PUSHES:
        return station_name or normalize_now_playing(now_playing) or "vTuner Stream"
    return normalize_now_playing(now_playing) or station_name or "vTuner Stream"

def get_current_radio_state():
    last_played = get_last_played() or {}
    if not last_played.get("url"):
        return {}

    stream_url = unwrap_proxy_url(last_played["url"])
    info = get_stream_metadata(stream_url)
    now_playing = normalize_now_playing(info.get("now_playing"))
    artist, title = split_now_playing(now_playing)

    return {
        "url": stream_url,
        "playback_url": last_played.get("playback_url"),
        "station_name": last_played.get("name"),
        "server_name": info.get("server_name"),
        "genre": info.get("genre"),
        "bitrate": info.get("bitrate"),
        "now_playing": now_playing,
        "artist": artist,
        "title": title
    }

def send_avr_command(command):
    """Send command to AVR via HTTP API"""
    try:
        url = f"http://{DENON_IP}/goform/formiPhoneAppDirect.xml?{command}"
        log_debug(f"Sending command: {url}")
        resp = requests.get(url, timeout=2)
        return resp.status_code == 200
    except Exception as e:
        log_debug(f"Command failed: {e}")
        return False

def get_avr_status():
    """Get AVR status via HTTP API"""
    try:
        url = f"http://{DENON_IP}/goform/formMainZone_MainZoneXml.xml"
        log_debug(f"Getting status from: {url}")
        resp = requests.get(url, timeout=2)

        if resp.status_code != 200:
            return None

        # Parse XML response
        root = ET.fromstring(resp.content)

        # Extract values from XML
        power = root.find('.//Power/value')
        volume = root.find('.//MasterVolume/value')
        muted = root.find('.//Mute/value')
        source = root.find('.//InputFuncSelect/value')

        return {
            "power": power.text if power is not None else "UNKNOWN",
            "state": "on" if (power is not None and power.text == "ON") else "off",
            "source": source.text if source is not None else "UNKNOWN",
            "volume": float(volume.text) if volume is not None else 0,
            "muted": (muted.text.lower() == "on") if muted is not None else False,
            "name": "denon"
        }
    except Exception as e:
        log_debug(f"Failed to get status: {e}")
        return None

def is_avr_ready_for_radio_metadata_update():
    status = get_avr_status()
    if not status:
        log_debug("Skipping Denon display metadata update: AVR status unavailable")
        return False

    power_on = status.get("power") == "ON" or status.get("state") == "on"
    if not power_on:
        log_debug("Skipping Denon display metadata update: AVR is in standby")
        return False

    source = status.get("source")
    if source not in RADIO_SOURCES:
        log_debug(f"Skipping Denon display metadata update: AVR source is {source}")
        return False

    return True

@app.route('/')
def index():
    return render_template('index.html')

@app.after_request
def add_home_assistant_cors_headers(response):
    origin = request.headers.get("Origin")

    if "*" in HOME_ASSISTANT_CORS_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin or "*"
        response.headers["Vary"] = "Origin"
    elif origin in HOME_ASSISTANT_CORS_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"

    if response.headers.get("Access-Control-Allow-Origin"):
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"

    return response

@app.route('/api/status')
def status():
    if not DENON_IP:
        return jsonify({"error": "DENON_IP not configured"}), 500

    try:
        data = get_avr_status()
        if data is None:
            return jsonify({"error": "Failed to get AVR status"}), 500

        if data.get("source") in RADIO_SOURCES:
            last_played = get_last_played() or {}
            if last_played.get("name"):
                data["station"] = last_played["name"]
            if last_played.get("url"):
                data["url"] = last_played["url"]

        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500



import json

FAVORITES_FILE = 'favorites.json'

def load_favorites():
    if not os.path.exists(FAVORITES_FILE):
        return []
    try:
        with open(FAVORITES_FILE, 'r') as f:
            return json.load(f)
    except:
        return []

def save_favorites(favs):
    with open(FAVORITES_FILE, 'w') as f:
        json.dump(favs, f, indent=2)

@app.route('/api/favorites', methods=['GET'])
def list_favorites():
    return jsonify(load_favorites())

@app.route('/api/favorites', methods=['POST'])
def add_favorite():
    data = request.json
    # data should have: name, url, favicon (optional), bitrate (optional)
    if not data or 'url' not in data or 'name' not in data:
        return jsonify({"error": "Missing name or url"}), 400

    favs = load_favorites()
    # Avoid duplicates by URL
    if not any(f['url'] == data['url'] for f in favs):
        favs.append(data)
        save_favorites(favs)

    return jsonify({"status": "success", "favorites": favs})

@app.route('/api/favorites/delete', methods=['POST'])
def delete_favorite():
    data = request.json
    url = data.get('url')
    if not url:
        return jsonify({"error": "Missing url"}), 400

    favs = load_favorites()
    favs = [f for f in favs if f['url'] != url]
    save_favorites(favs)
    return jsonify({"status": "success", "favorites": favs})

@app.route('/api/volume', methods=['POST'])
def set_volume():
    data = request.json
    try:
        val = data.get('volume')
        if val is not None:
            log_debug(f"Setting volume to {val}")
            # Convert to Denon format: -80 to +18 becomes 00 to 98
            # Example: -30 dB = MV50 (Absolute 50)
            denon_vol = int(float(val) + 80)
            command = f"MV{denon_vol:02d}"
            if send_avr_command(command):
                return jsonify({"status": "success", "volume": val})
            return jsonify({"error": "Failed to set volume"}), 500
        return jsonify({"error": "Missing volume"}), 400
    except Exception as e:
        log_debug(f"Error setting volume: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/input', methods=['POST'])
def set_input():
    data = request.json
    try:
        source = data.get('input')
        if source:
            # Map common names/user labels to Denon internal codes
            INPUT_MAPPING = {
                # Active Inputs (Used in UI)
                "CBL/SAT": "SAT/CBL",   # TV Audio (Button sends CBL/SAT, requires SAT/CBL command)
                "NETWORK": "IRADIO",    # Radio (Button sends NETWORK, requires IRADIO command)
                "CD": "CD",             # XS4ALL STB (Button sends CD)
                "SPOTIFY": "SPOTIFY",   # Spotify Connect

                # Unused Inputs (Commented out)
                # "TV": "TV",
                # "TV AUDIO": "TV",
                # "STB": "SAT/CBL",
                # "SAT/CBL": "SAT/CBL",
                # "SATCBL": "SAT/CBL",
                # "XS4ALL STB": "SAT/CBL",
                # "NET": "IRADIO",
                # "RADIO": "IRADIO",
                # "TUNER": "TUNER",
                # "DVD": "DVD",
                # "BD": "BD",
                # "GAME": "GAME",
                # "AUX1": "AUX1",
                # "AUX2": "AUX2",
                # "PHONO": "PHONO",
                # "MPLAY": "MPLAY",
                # "USB/IPOD": "USB/IPOD"
            }

            clean_source = source.strip()
            final_source = INPUT_MAPPING.get(clean_source, clean_source)

            log_debug(f"Input selection requested: {source} -> {final_source}")

            # Try HTTP API first (most reliable for Denon AVRs)
            http_success = False
            try:
                log_debug(f"Attempting HTTP API method...")
                # The AVR's HTTP API expects commands like SICD, SISATCBL, etc.
                # However, SAT/CBL requires the slash: SISAT/CBL
                http_code = final_source.replace(" ", "")
                # Only strip slashes if NOT SAT/CBL (just to be safe, though most modern Denons accept encoded slashes)
                if "SAT/CBL" not in http_code:
                    http_code = http_code.replace("/", "")

                url = f"http://{DENON_IP}/goform/formiPhoneAppDirect.xml?SI{http_code}"
                log_debug(f"HTTP API URL: {url}")
                resp = requests.get(url, timeout=2)
                if resp.status_code == 200:
                    http_success = True
                    log_debug(f"Successfully set input via HTTP API")
                else:
                    log_debug(f"HTTP API returned status {resp.status_code}")
            except Exception as http_err:
                log_debug(f"HTTP API failed: {http_err}")





            if not http_success:
                return jsonify({"error": "Failed to set input via HTTP API"}), 500

            return jsonify({"status": "success", "input": final_source, "method": "http"})
        return jsonify({"error": "Missing input"}), 400
    except Exception as e:
        log_debug(f"Error setting input: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/mute/toggle', methods=['POST'])
def toggle_mute():
    try:
        log_debug("Toggling mute")
        # Get current status to determine mute state
        status = get_avr_status()
        if status is None:
            return jsonify({"error": "Failed to get AVR status"}), 500

        current_muted = status.get("muted", False)
        command = "MUOFF" if current_muted else "MUON"

        if send_avr_command(command):
            return jsonify({"status": "success", "muted": not current_muted})
        return jsonify({"error": "Failed to toggle mute"}), 500
    except Exception as e:
        log_debug(f"Error toggling mute: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/power/on', methods=['POST'])
def power_on():
    try:
        log_debug("Turning power on (main zone)")
        if send_avr_command("ZMON"):
            return jsonify({"status": "success"})
        return jsonify({"error": "Failed to turn on"}), 500
    except Exception as e:
        log_debug(f"Error turning on: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/power/off', methods=['POST'])
def power_off():
    try:
        log_debug("Turning power off")
        if send_avr_command("PWSTANDBY"):
            return jsonify({"status": "success"})
        return jsonify({"error": "Failed to turn off"}), 500
    except Exception as e:
        log_debug(f"Error turning off: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/stream.mp3')
def stream_proxy():
    """
    Proxy HTTPS streams to HTTP for older AVRs.
    Exposed as .mp3 to satisfy DLNA requirements.
    """
    # Extract the full URL from the original request line to avoid breaking URLs with query parameters
    # request.args.get('url') will truncate at the first '&' in the target URL.
    try:
        url = request.url.split('url=', 1)[1]
        url = unquote(url)
    except IndexError:
        url = None

    if not url:
        return "Missing url", 400

    try:
        log_debug(f"Streaming proxy requested for: {url}")

        # ICY (Shoutcast) metadata pass-through: only when the client (the AVR)
        # explicitly asks for it with Icy-MetaData: 1, request it upstream and
        # forward the stream bytes untouched together with the icy-metaint
        # header, so the client can strip the metadata blocks itself and show
        # the track title on its display — without any UPnP push and thus
        # without interrupting audio.
        # Clients that don't ask get a clean stream: metadata bytes a client
        # was never told about play as noise (pop/jitter).
        client_wants_icy = (
            DENON_ICY_PASSTHROUGH
            and (request.headers.get('Icy-MetaData') or '').strip() == '1'
        )
        upstream_headers = {'Accept-Encoding': 'identity'}
        if client_wants_icy:
            upstream_headers['Icy-MetaData'] = '1'

        req = requests.get(url, headers=upstream_headers, stream=True, timeout=10)

        try:
            icy_metaint = int(req.headers.get('icy-metaint', 0))
        except (TypeError, ValueError):
            icy_metaint = 0
        icy_enabled = client_wants_icy and icy_metaint > 0

        log_debug(
            f"Proxy client requested ICY: {client_wants_icy}, "
            f"upstream icy-metaint: {icy_metaint}, pass-through: {icy_enabled}"
        )

        def generate():
            # Increase chunk size to 32KB for better buffering
            for chunk in req.iter_content(chunk_size=32768):
                yield chunk

        # Force audio/mpeg for compatibility
        resp = app.response_class(generate(), mimetype='audio/mpeg')

        if icy_enabled:
            resp.headers['icy-metaint'] = str(icy_metaint)
            for icy_header in ('icy-name', 'icy-genre', 'icy-br', 'icy-url'):
                icy_value = req.headers.get(icy_header)
                if icy_value:
                    resp.headers[icy_header] = icy_value

        # Add DLNA headers
        # MP3 profile, Streaming mode, Time-seek supported (OP=01) or not?
        # For live streams OP=00 (no seek) is safer, but OP=01 is common.
        # DLNA.ORG_FLAGS: Binary flags for available features.
        resp.headers['ContentFeatures.dlna.org'] = 'DLNA.ORG_PN=MP3;DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000'
        resp.headers['TransferMode.dlna.org'] = 'Streaming'
        resp.headers['DAAP-Server'] = 'iTunes/10.0' # Sometimes helps

        return resp
    except Exception as e:
        log_debug(f"Proxy error: {e}")
        return str(e), 500

def get_local_ip():
    """Try to determine the host IP reachable by the AVR."""
    # Best guess: connect to the AVR IP and see what our local IP is
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect((DENON_IP, 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return '0.0.0.0' # Fallback

def read_stream_bytes(raw, size, deadline):
    data = bytearray()

    while len(data) < size:
        if time.monotonic() >= deadline:
            return None

        chunk = raw.read(min(size - len(data), ICY_METADATA_READ_CHUNK_SIZE))
        if not chunk:
            return None

        data.extend(chunk)

    return bytes(data)

def skip_stream_bytes(raw, size, deadline):
    remaining = size

    while remaining > 0:
        if time.monotonic() >= deadline:
            return False

        chunk = raw.read(min(remaining, ICY_METADATA_READ_CHUNK_SIZE))
        if not chunk:
            return False

        remaining -= len(chunk)

    return True

def parse_stream_title(meta_data):
    if not meta_data:
        return None

    for encoding in ("utf-8", "latin-1"):
        try:
            meta_str = meta_data.decode(encoding).replace("\x00", "")
        except UnicodeDecodeError:
            continue

        match = re.search(r"StreamTitle=(?:'([^']*)'|\"([^\"]*)\"|([^;]*));", meta_str)
        if match:
            title = next((group for group in match.groups() if group is not None), "")
            return normalize_now_playing(html.unescape(title))

    return None

def get_stream_metadata(stream_url):
    """
    Connect to stream, get headers, and try to read ICY metadata (StreamTitle).
    """
    r = None
    try:
        headers = {'Icy-MetaData': '1', 'User-Agent': 'VLC/3.0.0'}
        r = requests.get(stream_url, headers=headers, stream=True, timeout=(3, 3))

        # Check headers
        try:
            icy_metaint = int(r.headers.get('icy-metaint', 0))
        except (TypeError, ValueError):
            icy_metaint = 0

        server_name = r.headers.get('icy-name', '')
        genre = r.headers.get('icy-genre', '')
        bitrate = r.headers.get('icy-br', '')

        info = {
            "server_name": server_name,
            "genre": genre,
            "bitrate": bitrate,
            "now_playing": "Unknown"
        }

        if icy_metaint > 0:
            deadline = time.monotonic() + ICY_METADATA_READ_TIMEOUT

            for _ in range(ICY_METADATA_MAX_BLOCKS):
                if not skip_stream_bytes(r.raw, icy_metaint, deadline):
                    break

                length_byte = read_stream_bytes(r.raw, 1, deadline)
                if not length_byte:
                    break

                length = length_byte[0] * 16
                if length == 0:
                    continue

                meta_data = read_stream_bytes(r.raw, length, deadline)
                stream_title = parse_stream_title(meta_data)
                if stream_title:
                    info['now_playing'] = stream_title
                    break

        info["now_playing"] = normalize_now_playing(info.get("now_playing")) or "Unknown"
        artist, title = split_now_playing(info["now_playing"])
        info["artist"] = artist
        info["title"] = title

        return info

    except Exception as e:
        log_debug(f"Metadata fetch error: {e}")
        return {}
    finally:
        if r:
            r.close()

@app.route('/api/metadata')
def api_metadata():
    url = request.args.get('url')
    if not url:
        return jsonify({"error": "Missing url"}), 400

    info = get_stream_metadata(url)
    return jsonify(info)

@app.route('/api/radio_now_playing')
def api_radio_now_playing():
    radio_state = get_current_radio_state()
    schedule_denon_display_update(radio_state)
    return jsonify(radio_state)

def discover_upnp_location(timeout=3):
    """
    Discover the UPnP Location URL via SSDP.
    Returns the location URL (e.g., http://192.168.1.100:8080/description.xml)
    """
    ssdp_request = (
        'M-SEARCH * HTTP/1.1\r\n'
        'HOST: 239.255.255.250:1900\r\n'
        'MAN: "ssdp:discover"\r\n'
        'MX: 1\r\n'
        'ST: urn:schemas-upnp-org:service:AVTransport:1\r\n'
        '\r\n'
    )

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)

    try:
        sock.sendto(ssdp_request.encode(), ('239.255.255.250', 1900))

        while True:
            try:
                data, addr = sock.recvfrom(1024)
                if addr[0] == DENON_IP:
                    # Found our device, parse Location header
                    headers = data.decode().split('\r\n')
                    for header in headers:
                        if header.lower().startswith('location:'):
                            return header.split(':', 1)[1].strip()
            except socket.timeout:
                break
    except Exception as e:
        print(f"SSDP Discovery failed: {e}")

    return None

def get_control_url(location_url):
    """
    Fetch description.xml and parse for AVTransport ControlURL.
    """
    try:
        resp = requests.get(location_url, timeout=5)
        # Simple string parsing to avoid lxml dependency for now
        # Look for AVTransport service -> ControlURL

        import xml.etree.ElementTree as ET
        # Remove xmlns attributes for easier parsing
        xml_str = resp.text
        import re
        xml_str = re.sub(r' xmlns="[^"]+"', '', xml_str, count=1)
        root = ET.fromstring(xml_str)

        # Navigate to service list: device -> serviceList -> service
        for service in root.findall(".//service"):
            service_type = service.find("serviceType").text
            if "AVTransport" in service_type:
                control_path = service.find("controlURL").text
                # If path is relative, join with base URL
                return urljoin(location_url, control_path)

    except Exception as e:
        print(f"Failed to get control URL: {e}")

    return None

def discover_avtransport_control_url():
    global _AV_TRANSPORT_CONTROL_URL

    if _AV_TRANSPORT_CONTROL_URL:
        return _AV_TRANSPORT_CONTROL_URL

    control_url = None

    log_debug(f"Discovering UPnP services for {DENON_IP}...")
    location = discover_upnp_location()
    if location:
        log_debug(f"Found Device Description at: {location}")
        control_url = get_control_url(location)
        log_debug(f"Discovered Control URL: {control_url}")

    if not control_url:
        log_debug("SSDP failed or yielded no result. Starting manual scan...")

        common_ports = [8080, 80, 55000, 38067]
        desc_paths = ["/description.xml", "/upnp/desc/aios_device/aios_device.xml", "/DeviceDescription.xml"]

        for port in common_ports:
            for path in desc_paths:
                try:
                    test_url = f"http://{DENON_IP}:{port}{path}"
                    log_debug(f"Scanning {test_url} ...")
                    r = requests.get(test_url, timeout=1)
                    if r.status_code == 200:
                        log_debug(f"Found description at {test_url}")
                        control_url = get_control_url(test_url)
                        if control_url:
                            break
                except Exception as e:
                    log_debug(f"Scan error for {test_url}: {e}")
            if control_url:
                break

        if not control_url:
            log_debug("Manual scan failed. Trying fallback to port 8080 direct control...")
            control_url = f"http://{DENON_IP}:8080/AVTransport/control"

    _AV_TRANSPORT_CONTROL_URL = control_url
    return control_url

def clean_xml_text(value):
    text = "" if value is None else str(value)
    return XML_INVALID_CHARS_RE.sub("", text)

def serialize_xml(element):
    return '<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(
        element,
        encoding="unicode",
        short_empty_elements=False
    )

def build_didl_lite(stream_url, station_name, display_title=None, artist=None):
    display_title = get_denon_display_title(station_name, display_title)

    root = ET.Element(f"{{{DIDL_NS}}}DIDL-Lite")
    item = ET.SubElement(
        root,
        f"{{{DIDL_NS}}}item",
        {"id": "0", "parentID": "0", "restricted": "1"}
    )

    ET.SubElement(item, f"{{{DC_NS}}}title").text = clean_xml_text(display_title)

    if artist:
        clean_artist = clean_xml_text(artist)
        ET.SubElement(item, f"{{{DC_NS}}}creator").text = clean_artist
        ET.SubElement(item, f"{{{UPNP_NS}}}artist").text = clean_artist

    ET.SubElement(item, f"{{{UPNP_NS}}}album").text = clean_xml_text(station_name or "Radio")
    ET.SubElement(item, f"{{{UPNP_NS}}}class").text = "object.item.audioItem.audioBroadcast"
    ET.SubElement(
        item,
        f"{{{DIDL_NS}}}res",
        {
            "protocolInfo": (
                "http-get:*:audio/mpeg:"
                "DLNA.ORG_PN=MP3;DLNA.ORG_OP=01;DLNA.ORG_CI=0;"
                "DLNA.ORG_FLAGS=01700000000000000000000000000000"
            )
        }
    ).text = clean_xml_text(stream_url)

    return ET.tostring(root, encoding="unicode", short_empty_elements=False)

def build_avtransport_action_body(action_name, arguments=None):
    envelope = ET.Element(
        f"{{{SOAP_ENV_NS}}}Envelope",
        {f"{{{SOAP_ENV_NS}}}encodingStyle": "http://schemas.xmlsoap.org/soap/encoding/"}
    )
    body = ET.SubElement(envelope, f"{{{SOAP_ENV_NS}}}Body")
    action = ET.SubElement(body, f"{{{AVTRANSPORT_NS}}}{action_name}")

    ET.SubElement(action, "InstanceID").text = "0"
    for name, value in (arguments or {}).items():
        ET.SubElement(action, name).text = value

    return serialize_xml(envelope)

def post_avtransport_action(control_url, action_name, arguments=None):
    headers = {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': f'"{AVTRANSPORT_NS}#{action_name}"'
    }
    soap_body = build_avtransport_action_body(action_name, arguments)

    resp = requests.post(control_url, data=soap_body, headers=headers, timeout=5)
    log_debug(f"{action_name} Response: {resp.status_code} {resp.text}")
    if resp.status_code >= 400:
        raise RuntimeError(f"{action_name} failed with HTTP {resp.status_code}")

    return resp

def send_set_avtransport_uri(control_url, playback_url, station_name, display_title=None, artist=None):
    didl_lite = build_didl_lite(playback_url, station_name, display_title, artist)

    log_debug(f"Sending SetAVTransportURI to {control_url} with title: {display_title or station_name}")
    return post_avtransport_action(control_url, "SetAVTransportURI", {
        "CurrentURI": clean_xml_text(playback_url),
        "CurrentURIMetaData": clean_xml_text(didl_lite)
    })

def send_play(control_url):
    log_debug(f"Sending Play to {control_url}...")
    return post_avtransport_action(control_url, "Play", {"Speed": "1"})

def send_avtransport_uri(control_url, playback_url, station_name, display_title=None, artist=None):
    resp1 = send_set_avtransport_uri(control_url, playback_url, station_name, display_title, artist)
    resp2 = send_play(control_url)
    return resp1, resp2

def get_avr_transport_state(control_url):
    try:
        resp = post_avtransport_action(control_url, "GetTransportInfo")
        root = ET.fromstring(resp.content)
        node = root.find(".//CurrentTransportState")
        if node is not None and node.text:
            return node.text.strip()
    except Exception as e:
        log_debug(f"GetTransportInfo failed: {e}")
    return None

def get_avr_displayed_title(control_url):
    """Read back the track title the AVR is currently displaying via GetPositionInfo."""
    try:
        resp = post_avtransport_action(control_url, "GetPositionInfo")
        root = ET.fromstring(resp.content)
        node = root.find(".//TrackMetaData")
        metadata = node.text if node is not None else None
        if not metadata or metadata == "NOT_IMPLEMENTED":
            return None

        didl = ET.fromstring(metadata)
        title = didl.find(f".//{{{DC_NS}}}title")
        if title is not None and title.text:
            return title.text.strip()
    except Exception as e:
        log_debug(f"GetPositionInfo failed: {e}")
    return None

def remember_denon_display_update(playback_url, display_title):
    _LAST_DENON_DISPLAY_UPDATE["url"] = playback_url
    _LAST_DENON_DISPLAY_UPDATE["title"] = display_title
    _LAST_DENON_DISPLAY_UPDATE["at"] = time.time()

def verify_denon_display_update(control_url, expected_title):
    """
    Give the AVR a few seconds, then read back what it is displaying.
    Also recovers playback with Play if the metadata push knocked the
    transport out of PLAYING. Returns True when the display matches or
    cannot be verified (old models may not report a track title).
    """
    time.sleep(DENON_DISPLAY_METADATA_VERIFY_DELAY_SECONDS)

    state = get_avr_transport_state(control_url)
    if state and state not in ("PLAYING", "TRANSITIONING"):
        log_debug(f"AVR transport state is {state} after metadata update, sending Play to recover")
        try:
            send_play(control_url)
        except Exception as e:
            log_debug(f"Failed to resume playback after metadata update: {e}")

    displayed_title = get_avr_displayed_title(control_url)
    if displayed_title is None:
        log_debug("AVR does not report a track title, skipping display verification")
        return True

    if displayed_title == expected_title:
        log_debug(f"AVR display verified: {displayed_title}")
        return True

    log_debug(f"AVR display shows '{displayed_title}' instead of '{expected_title}'")
    return False

def maybe_update_denon_display(radio_state):
    if not DENON_IP or not DENON_DISPLAY_METADATA or not DENON_DISPLAY_TRACK_PUSHES:
        return

    now_playing = normalize_now_playing(radio_state.get("now_playing"))
    if not now_playing:
        return

    station_name = radio_state.get("station_name") or "Radio"
    display_title = get_denon_display_title(station_name, now_playing)
    stream_url = radio_state.get("url")
    playback_url = radio_state.get("playback_url") or get_playback_url(stream_url)

    if not playback_url:
        return

    last_update_at = _LAST_DENON_DISPLAY_UPDATE.get("at") or 0
    if (
        _LAST_DENON_DISPLAY_UPDATE.get("url") == playback_url
        and _LAST_DENON_DISPLAY_UPDATE.get("title") == display_title
    ):
        return

    if time.time() - last_update_at < DENON_DISPLAY_METADATA_MIN_PUSH_INTERVAL:
        return

    if not is_avr_ready_for_radio_metadata_update():
        return

    try:
        control_url = discover_avtransport_control_url()
        artist, _ = split_now_playing(now_playing)

        for attempt in range(1, DENON_DISPLAY_METADATA_MAX_PUSH_ATTEMPTS + 1):
            # Only SetAVTransportURI, no Play: re-sending Play is what used to
            # restart the stream. verify_denon_display_update recovers playback
            # in case this model stops on a bare metadata push.
            send_set_avtransport_uri(control_url, playback_url, station_name, display_title, artist)
            remember_denon_display_update(playback_url, display_title)

            if verify_denon_display_update(control_url, display_title):
                return

            log_debug(
                f"AVR display update attempt {attempt}/{DENON_DISPLAY_METADATA_MAX_PUSH_ATTEMPTS} "
                f"not confirmed for '{display_title}'"
            )
    except Exception as e:
        log_debug(f"Failed to update Denon display metadata: {e}")

def run_denon_display_update(radio_state):
    with _DENON_DISPLAY_UPDATE_LOCK:
        maybe_update_denon_display(radio_state)

def schedule_denon_display_update(radio_state):
    if not DENON_IP or not DENON_DISPLAY_METADATA or not DENON_DISPLAY_TRACK_PUSHES:
        return

    if _DENON_DISPLAY_UPDATE_LOCK.locked():
        return

    now_playing = normalize_now_playing(radio_state.get("now_playing"))
    if not now_playing:
        return

    thread = threading.Thread(
        target=run_denon_display_update,
        args=(dict(radio_state),),
        daemon=True
    )
    thread.start()

def denon_display_metadata_worker():
    sleep_seconds = DENON_DISPLAY_METADATA_POLL_INTERVAL
    log_debug(f"Started Denon display metadata worker, poll interval={sleep_seconds}s")

    while True:
        try:
            if not get_last_played():
                time.sleep(sleep_seconds)
                continue

            avr_ready = is_avr_ready_for_radio_metadata_update()
            if not avr_ready:
                time.sleep(sleep_seconds)
                continue

            radio_state = get_current_radio_state()
            if radio_state:
                run_denon_display_update(radio_state)
        except Exception as e:
            log_debug(f"Denon display metadata worker error: {e}")

        time.sleep(sleep_seconds)

def start_denon_display_metadata_worker():
    global _DENON_DISPLAY_WORKER_STARTED

    if not DENON_IP or not DENON_DISPLAY_METADATA or not DENON_DISPLAY_TRACK_PUSHES:
        return

    with _DENON_DISPLAY_WORKER_LOCK:
        if _DENON_DISPLAY_WORKER_STARTED:
            return

        thread = threading.Thread(
            target=denon_display_metadata_worker,
            daemon=True,
            name="denon-display-metadata"
        )
        thread.start()
        _DENON_DISPLAY_WORKER_STARTED = True

@app.before_request
def ensure_denon_display_metadata_worker():
    start_denon_display_metadata_worker()

@app.route('/api/search')
def search_stations():
    query = request.args.get('name', '')
    if not query:
        return jsonify([])

    try:
        # Use a random RadioBrowser server via DNS round robin or hardcoded high avail one
        # "de1.api.radio-browser.info" is usually reliable
        url = "https://de1.api.radio-browser.info/json/stations/search"
        params = {
            'name': query,
            'limit': 20,
            'hidebroken': 'true',
            'order': 'clickcount',
            'reverse': 'true'
        }
        resp = requests.get(url, params=params, timeout=5)
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/last_played')
def api_last_played():
    data = get_last_played()
    if data:
        return jsonify(data)
    return jsonify({}), 404

@app.route('/api/play_url')
def play_url():
    if not DENON_IP:
        return jsonify({"error": "DENON_IP not configured"}), 500

    stream_url = request.args.get('url')
    station_name = request.args.get('name', 'vTuner Stream')

    if not stream_url:
        return jsonify({"error": "Missing 'url' parameter"}), 400

    try:
        log_debug(f"play_url called with url={stream_url}")

        control_url = discover_avtransport_control_url()
        log_debug(f"Using Control URL: {control_url}")

        playback_url = get_playback_url(stream_url)
        # Reading the current track only matters when it will be pushed to the
        # display; skipping it also makes starting a station faster.
        metadata = (
            get_stream_metadata(stream_url)
            if DENON_DISPLAY_METADATA and DENON_DISPLAY_TRACK_PUSHES
            else {}
        )
        now_playing = normalize_now_playing(metadata.get("now_playing"))
        artist, _ = split_now_playing(now_playing)
        display_title = get_denon_display_title(station_name, now_playing)

        send_avtransport_uri(control_url, playback_url, station_name, display_title, artist)
        remember_denon_display_update(playback_url, display_title)

        # Debug: Check actual status via Denon Web Interface
        # The user mentioned http://IP/NetAudio/index.html
        # We can try to fetch the XML status commonly found at /goform/formNetAudio_StatusXml.xml
        try:
            status_url = f"http://{DENON_IP}/goform/formNetAudio_StatusXml.xml"
            r = requests.get(status_url, timeout=2)
            log_debug(f"AVR NetAudio Status: {r.text}")
        except Exception as e:
            log_debug(f"Could not fetch NetAudio Status: {e}")

        save_last_played(stream_url, station_name, playback_url)
        return jsonify({"status": "success", "played": playback_url, "control_url": control_url, "display_title": display_title})

    except Exception as e:
        log_debug(f"Error playing URL: {e}")
        if DEBUG:
            import traceback
            traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# ============ SPOTIFY INTEGRATION ============

def get_spotify_oauth():
    """Create Spotify OAuth handler"""
    if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET or not SPOTIFY_REDIRECT_URI:
        return None
    return SpotifyOAuth(
        client_id=SPOTIFY_CLIENT_ID,
        client_secret=SPOTIFY_CLIENT_SECRET,
        redirect_uri=SPOTIFY_REDIRECT_URI,
        scope=SPOTIFY_SCOPE,
        cache_path=SPOTIFY_TOKENS_FILE
    )

def get_spotify_client():
    """Get authenticated Spotify client"""
    sp_oauth = get_spotify_oauth()
    if not sp_oauth:
        return None

    token_info = sp_oauth.get_cached_token()
    if not token_info:
        return None

    # Refresh if needed
    if sp_oauth.is_token_expired(token_info):
        token_info = sp_oauth.refresh_access_token(token_info['refresh_token'])

    return spotipy.Spotify(auth=token_info['access_token'])

@app.route('/spotify/login')
def spotify_login():
    """Initiate Spotify OAuth flow"""
    sp_oauth = get_spotify_oauth()
    if not sp_oauth:
        return jsonify({"error": "Spotify not configured"}), 500

    auth_url = sp_oauth.get_authorize_url()
    return redirect(auth_url)

@app.route('/spotify/callback')
def spotify_callback():
    """Handle Spotify OAuth callback"""
    sp_oauth = get_spotify_oauth()
    if not sp_oauth:
        return jsonify({"error": "Spotify not configured"}), 500

    code = request.args.get('code')
    if not code:
        return jsonify({"error": "No authorization code provided"}), 400

    try:
        token_info = sp_oauth.get_access_token(code)
        session['spotify_authed'] = True
        log_debug("Spotify authentication successful")
        return redirect('/')
    except Exception as e:
        log_debug(f"Spotify auth error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/spotify/status')
def spotify_status():
    """Check if user is authenticated with Spotify"""
    sp = get_spotify_client()
    if sp:
        try:
            user = sp.current_user()
            return jsonify({
                "authenticated": True,
                "user": {
                    "display_name": user.get('display_name'),
                    "id": user.get('id')
                }
            })
        except:
            return jsonify({"authenticated": False})
    return jsonify({"authenticated": False})

@app.route('/api/spotify/logout', methods=['POST'])
def spotify_logout():
    """Clear Spotify authentication"""
    try:
        if os.path.exists(SPOTIFY_TOKENS_FILE):
            os.remove(SPOTIFY_TOKENS_FILE)
        session.pop('spotify_authed', None)
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/spotify/playlists')
def spotify_playlists():
    """Get user's Spotify playlists"""
    sp = get_spotify_client()
    if not sp:
        return jsonify({"error": "Not authenticated"}), 401

    try:
        playlists = []
        results = sp.current_user_playlists(limit=50)

        while results:
            for item in results['items']:
                # Get album art (first image, or None)
                images = item.get('images', [])
                image_url = images[0]['url'] if images else None

                playlists.append({
                    "id": item['id'],
                    "name": item['name'],
                    "uri": item['uri'],
                    "tracks_total": item['tracks']['total'],
                    "image_url": image_url,
                    "owner": item['owner']['display_name']
                })

            # Get next page if available
            if results['next']:
                results = sp.next(results)
            else:
                results = None

        # Also get saved tracks/liked songs
        try:
            saved_tracks = sp.current_user_saved_tracks(limit=1)
            if saved_tracks['total'] > 0:
                playlists.insert(0, {
                    "id": "liked",
                    "name": "Liked Songs",
                    "uri": None,  # Special case
                    "tracks_total": saved_tracks['total'],
                    "image_url": None,
                    "owner": "You"
                })
        except:
            pass

        return jsonify(playlists)
    except Exception as e:
        log_debug(f"Error fetching playlists: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/spotify/recently_played_contexts')
def spotify_recently_played_contexts():
    """Get the URIs of recently played contexts (like playlists) to derive 'last played' sorting"""
    sp = get_spotify_client()
    if not sp:
        return jsonify({"error": "Not authenticated"}), 401

    try:
        results = sp.current_user_recently_played(limit=50)
        recent_contexts = []
        for item in results.get('items', []):
            context = item.get('context')
            if context and context.get('type') == 'playlist' and context.get('uri'):
                uri = context['uri']
                if uri not in recent_contexts:
                    recent_contexts.append(uri)
        return jsonify({"recent_contexts": recent_contexts})
    except Exception as e:
        log_debug(f"Error fetching recently played context: {e}")
        return jsonify({"error": str(e)}), 500

SPOTIFY_SEARCH_TYPE_ALIASES = {
    "song": "track",
    "songs": "track",
    "track": "track",
    "tracks": "track",
    "playlist": "playlist",
    "playlists": "playlist",
    "podcast": "episode",
    "podcasts": "episode",
    "episode": "episode",
    "episodes": "episode",
}

def normalize_spotify_search_types(raw_value):
    selected_types = []

    for item in (raw_value or "track,playlist,episode").split(","):
        search_type = SPOTIFY_SEARCH_TYPE_ALIASES.get(item.strip().lower())
        if search_type and search_type not in selected_types:
            selected_types.append(search_type)

    return ",".join(selected_types or ["track", "playlist", "episode"])

def first_image_url(images):
    if not images:
        return None

    first_image = images[0]
    if isinstance(first_image, dict):
        return first_image.get("url")

    return None

@app.route('/api/spotify/search')
def spotify_search():
    """Search Spotify for songs, playlists, and podcast episodes."""
    sp = get_spotify_client()
    if not sp:
        return jsonify({"error": "Not authenticated"}), 401

    query = request.args.get('q', '').strip()
    if not query:
        return jsonify([])

    try:
        limit = max(1, min(int(request.args.get('limit', 8)), 20))
    except (TypeError, ValueError):
        limit = 8

    search_types = normalize_spotify_search_types(request.args.get('types'))

    try:
        results = sp.search(
            q=query,
            type=search_types,
            limit=limit,
            market="from_token"
        )

        items = []

        for track in results.get('tracks', {}).get('items', []):
            if not track or not track.get('uri'):
                continue

            artists = ', '.join([artist['name'] for artist in track.get('artists', [])])
            album_images = track.get('album', {}).get('images', [])
            items.append({
                "type": "track",
                "label": "Song",
                "id": track.get('id'),
                "name": track.get('name'),
                "subtitle": artists,
                "uri": track.get('uri'),
                "image_url": first_image_url(album_images),
                "duration_ms": track.get('duration_ms', 0),
            })

        for playlist in results.get('playlists', {}).get('items', []):
            if not playlist or not playlist.get('uri'):
                continue

            owner = playlist.get('owner') or {}
            tracks = playlist.get('tracks') or {}
            items.append({
                "type": "playlist",
                "label": "Playlist",
                "id": playlist.get('id'),
                "name": playlist.get('name'),
                "subtitle": owner.get('display_name') or "Spotify",
                "uri": playlist.get('uri'),
                "image_url": first_image_url(playlist.get('images')),
                "tracks_total": tracks.get('total'),
            })

        for episode in results.get('episodes', {}).get('items', []):
            if not episode or not episode.get('uri'):
                continue

            show = episode.get('show') or {}
            items.append({
                "type": "episode",
                "label": "Podcast",
                "id": episode.get('id'),
                "name": episode.get('name'),
                "subtitle": show.get('name') or episode.get('publisher') or "Podcast episode",
                "uri": episode.get('uri'),
                "image_url": first_image_url(episode.get('images') or show.get('images')),
                "duration_ms": episode.get('duration_ms', 0),
            })

        return jsonify(items)
    except Exception as e:
        log_debug(f"Error searching Spotify: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/spotify/playlist/<playlist_id>/tracks')
def spotify_playlist_tracks(playlist_id):
    """Get tracks from a specific playlist"""
    sp = get_spotify_client()
    if not sp:
        return jsonify({"error": "Not authenticated"}), 401

    try:
        tracks = []

        # Special case for liked songs
        if playlist_id == "liked":
            results = sp.current_user_saved_tracks(limit=50)
        else:
            results = sp.playlist_tracks(playlist_id, limit=50)

        while results:
            for item in results['items']:
                track = item['track'] if 'track' in item else item
                if not track:
                    continue

                artists = ', '.join([artist['name'] for artist in track.get('artists', [])])
                album_images = track.get('album', {}).get('images', [])
                image_url = album_images[0]['url'] if album_images else None

                tracks.append({
                    "id": track['id'],
                    "name": track['name'],
                    "uri": track['uri'],
                    "artists": artists,
                    "album": track.get('album', {}).get('name', ''),
                    "duration_ms": track.get('duration_ms', 0),
                    "image_url": image_url
                })

            # Get next page if available
            if results['next']:
                results = sp.next(results)
            else:
                results = None

        return jsonify(tracks)
    except Exception as e:
        log_debug(f"Error fetching playlist tracks: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/spotify/devices')
def spotify_devices():
    """Get available Spotify Connect devices"""
    sp = get_spotify_client()
    if not sp:
        return jsonify({"error": "Not authenticated"}), 401

    try:
        devices = sp.devices()
        return jsonify(devices.get('devices', []))
    except Exception as e:
        log_debug(f"Error fetching devices: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/spotify/play', methods=['POST'])
def spotify_play():
    """Play Spotify content on AVR"""
    sp = get_spotify_client()
    if not sp:
        return jsonify({"error": "Not authenticated"}), 401

    data = request.json
    context_uri = data.get('context_uri')  # playlist/album URI
    track_uris = data.get('track_uris') or data.get('uris')  # specific tracks or episodes
    device_id = data.get('device_id')      # target device

    try:
        # Step 1: Switch AVR to Spotify input
        log_debug("Switching AVR to Spotify input...")
        if not send_avr_command("SISPOTIFY"):
            log_debug("Failed to switch to Spotify input, but continuing...")

        # Wait a moment for AVR to switch
        import time
        time.sleep(1)

        # Step 2: Find Denon device if device_id not provided
        if not device_id:
            devices = sp.devices()
            denon_device = None

            for device in devices.get('devices', []):
                # Look for Denon, AVR, or X4000 in device name
                device_name = device.get('name', '').lower()
                if 'denon' in device_name or 'avr' in device_name or 'x4000' in device_name:
                    denon_device = device
                    device_id = device['id']
                    log_debug(f"Found Denon device: {device['name']}")
                    break

            if not device_id:
                log_debug(f"Available devices: {devices.get('devices', [])}")
                return jsonify({"error": "Denon AVR not found in Spotify Connect devices. Make sure Spotify input is active on AVR."}), 404

        # Step 3: Transfer playback and play
        if context_uri:
            # Play playlist/album
            log_debug(f"Starting playback of {context_uri} on device {device_id}")
            sp.start_playback(device_id=device_id, context_uri=context_uri)
        elif track_uris:
            # Play specific tracks
            log_debug(f"Starting playback of tracks on device {device_id}")
            sp.start_playback(device_id=device_id, uris=track_uris)
        else:
            # Just transfer playback
            log_debug(f"Transferring playback to device {device_id}")
            sp.transfer_playback(device_id=device_id, force_play=True)

        return jsonify({"status": "success", "device_id": device_id})

    except Exception as e:
        log_debug(f"Error playing Spotify: {e}")
        if DEBUG:
            import traceback
            traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/api/spotify/control', methods=['POST'])
def spotify_control():
    """Control Spotify playback (play/pause/skip)"""
    sp = get_spotify_client()
    if not sp:
        return jsonify({"error": "Not authenticated"}), 401

    data = request.json
    action = data.get('action')

    try:
        if action == 'play':
            sp.start_playback()
        elif action == 'pause':
            sp.pause_playback()
        elif action == 'stop':
            sp.pause_playback()
        elif action == 'next':
            sp.next_track()
        elif action == 'previous':
            sp.previous_track()
        else:
            return jsonify({"error": "Invalid action"}), 400

        return jsonify({"status": "success"})
    except Exception as e:
        log_debug(f"Error controlling Spotify: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/spotify/current')
def spotify_current():
    """Get currently playing track"""
    sp = get_spotify_client()
    if not sp:
        return jsonify({"error": "Not authenticated"}), 401

    try:
        current = sp.current_playback()
        if not current or not current.get('item'):
            return jsonify({"playing": False})

        track = current['item']
        artists = ', '.join([artist['name'] for artist in track.get('artists', [])])
        album_images = track.get('album', {}).get('images', [])
        image_url = album_images[0]['url'] if album_images else None

        return jsonify({
            "playing": current.get('is_playing', False),
            "track": {
                "name": track['name'],
                "artists": artists,
                "album": track.get('album', {}).get('name', ''),
                "image_url": image_url,
                "duration_ms": track.get('duration_ms', 0),
                "progress_ms": current.get('progress_ms', 0)
            },
            "device": {
                "name": current.get('device', {}).get('name', ''),
                "type": current.get('device', {}).get('type', '')
            }
        })
    except Exception as e:
        log_debug(f"Error fetching current track: {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
