from flask import Flask, render_template, jsonify, request
import sys
import denonavr
import requests
import socket
import os
import asyncio
import html
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

# Configuration
DENON_IP = os.getenv("DENON_IP")
DEBUG = os.getenv("DEBUG", "false").lower() in ("true", "1", "yes")

def log_debug(msg):
    if DEBUG:
        print(f"[DEBUG] {msg}", file=sys.stderr)

def get_denon_receiver():
    """Synchronously get a denon receiver instance."""
    # Note: denonavr is async, but we can run the init in a loop if needed,
    # or just use it synchronously if possible.
    # The library is primarily async. We'll use asyncio.run for simple commands.
    return denonavr.DenonAVR(DENON_IP)

async def async_get_status():
    d = denonavr.DenonAVR(DENON_IP)
    await d.async_setup()
    await d.async_update()
    return {
        "power": d.power,
        "state": d.state,
        "source": d.input_func,
        "volume": d.volume,
        "muted": d.muted,
        "name": d.name
    }

async def async_play_favorite(favorite_id):
    """
    Simulates pressing a favorite button?
    DenonAVR library might expose this via direct command or input selection.
    If 'Favorites' are inputs, we select them.
    """
    d = denonavr.DenonAVR(DENON_IP)
    await d.async_setup()

    # Check if we can select 'Favorites' as a source
    # Or sending specific command.
    # The library allows sending arbitrary commands via telnet if needed,
    # but let's try standard input selection first.

    # Usually "Favorite 1" -> "FAVORITE1" or similar command.
    # We might need to send raw telnet command if the library doesn't support specific favorite selection easily.
    # Command: "FV 01" for Favorite 1? Or "ZNFAVORITE1" ?
    # Let's try sending raw command for Favorites as it's most reliable for older AVRs.
    # X4000: "ZMFAVORITE1" (Main Zone), "Z2FAVORITE1" (Zone 2)

    # However, denonavr library uses http/telnet.
    # Let's assume we want to trigger Quick Selects or Favorites.
    # Quick Select: "MSQUICK1", "MSQUICK2", etc.
    # Favorites call: "ZM" + "FAVORITE" + id

    # We will try to execute raw telnet command via the library if feasible,
    # otherwise we might just open a raw telnet connection for simplicity in this function.
    pass

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/status')
def status():
    if not DENON_IP:
        return jsonify({"error": "DENON_IP not configured"}), 500

    try:
        data = asyncio.run(async_get_status())
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

# Removed old direct telnet routes as we are pivoting to App Favorites via DLNA


@app.route('/stream.mp3')
def stream_proxy():
    """
    Proxy HTTPS streams to HTTP for older AVRs.
    Exposed as .mp3 to satisfy DLNA requirements.
    """
    url = request.args.get('url')
    if not url:
        return "Missing url", 400

    try:
        log_debug(f"Streaming proxy requested for: {url}")
        # Stream the content with ICY metadata request
        headers = {'Icy-MetaData': '1'}
        req = requests.get(url, stream=True, timeout=5, headers=headers)

        def generate():
            for chunk in req.iter_content(chunk_size=4096):
                yield chunk

        # Force audio/mpeg for compatibility
        resp = app.response_class(generate(), mimetype='audio/mpeg')

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

def get_stream_metadata(stream_url):
    """
    Connect to stream, get headers, and try to read ICY metadata (StreamTitle).
    """
    try:
        headers = {'Icy-MetaData': '1', 'User-Agent': 'VLC/3.0.0'}
        r = requests.get(stream_url, headers=headers, stream=True, timeout=3)

        # Check headers
        icy_metaint = int(r.headers.get('icy-metaint', 0))
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
            # Read up to metaint bytes of audio
            # r.raw.read is tricky with requests stream, use iter_content
            # We skip 'icy_metaint' bytes of audio data to find the metadata block

            # Read chunks until we pass metaint
            byte_count = 0

            # We need raw socket access or careful reading.
            # Requests iter_content(chunk_size=1) is slow.
            # Let's try reading a larger chunk and slicing.

            # Read just enough to cover the first metadata block if it's "close"
            # Some streams send it periodically.

            # Simplification: Read the first chunk. If metaint is small enough, we might find it.
            # But metaint is usually 16000 or 8192 bytes.

            # Let's read exactly metaint bytes
            audio_data = r.raw.read(icy_metaint)

            # Next byte is length of metadata (x 16)
            length_byte = r.raw.read(1)
            if length_byte:
                length = ord(length_byte) * 16
                if length > 0:
                    meta_data = r.raw.read(length)
                    # Decode and parse StreamTitle='...'
                    try:
                        meta_str = meta_data.decode('utf-8', errors='ignore')
                        # Extract StreamTitle
                        import re
                        m = re.search(r"StreamTitle='([^']*)';", meta_str)
                        if m:
                            info['now_playing'] = m.group(1)
                    except:
                        pass

        r.close()
        return info

    except Exception as e:
        print(f"Metadata fetch error: {e}")
        return {}

@app.route('/api/metadata')
def api_metadata():
    url = request.args.get('url')
    if not url:
        return jsonify({"error": "Missing url"}), 400

    info = get_stream_metadata(url)
    return jsonify(info)

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
                from urllib.parse import urljoin
                return urljoin(location_url, control_path)

    except Exception as e:
        print(f"Failed to get control URL: {e}")

    return None

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

        # Discovery Strategy:
        # 1. Try common ports/paths first (Fast path)
        # 2. If fail, run SSDP discovery (Robust path)

        control_url = None

        # Fast path 1: Standard 8080 (already tried and failed for user)
        # Fast path 2: Port 80

        # Let's try SSDP immediately since 8080 failed
        log_debug(f"Discovering UPnP services for {DENON_IP}...")
        location = discover_upnp_location()
        if location:
            log_debug(f"Found Device Description at: {location}")
            control_url = get_control_url(location)
            log_debug(f"Discovered Control URL: {control_url}")

        if not control_url:
            # Fallback: Manual Port/Path Scan
            log_debug("SSDP failed or yielded no result. Starting manual scan...")

            # Common ports for Denon/Marantz UPnP
            common_ports = [8080, 80, 55000, 38067]
            # Common paths for UPnP description
            desc_paths = ["/description.xml", "/upnp/desc/aios_device/aios_device.xml", "/DeviceDescription.xml"]

            # Common explicit control URLs (skip description parsing if we hit these directly)
            direct_control_paths = [
                "/AVTransport/control",
                "/upnp/control/AVTransport",
                "/MediaRenderer/AVTransport/Control"
            ]

            # Step 1: detailed scan for description.xml
            for port in common_ports:
                for path in desc_paths:
                    try:
                        test_url = f"http://{DENON_IP}:{port}{path}"
                        log_debug(f"Scanning {test_url} ...")
                        # Low timeout for scan
                        r = requests.get(test_url, timeout=1)
                        if r.status_code == 200:
                            log_debug(f"Found description at {test_url}")
                            control_url = get_control_url(test_url)
                            if control_url:
                                break
                    except Exception as e:
                        log_debug(f"Scan error for {test_url}: {e}")
                        pass
                if control_url:
                    break

            # Step 2: Only if specific scan failed, try blind POST to standard 8080 control path
            if not control_url:
                log_debug("Manual scan failed. Trying fallback to port 8080 direct control...")
                control_url = f"http://{DENON_IP}:8080/AVTransport/control"

        log_debug(f"Using Control URL: {control_url}")

        # ... DLNA Logic ...

        # PROXY LOGIC:
        # Check if URL is HTTPS. Older Denon AVRs (like X4000) fail with HTTPS.
        # We rewrite the URL to point to our local HTTP proxy.
        if stream_url.lower().startswith("https://"):
            local_ip = os.getenv("HOST_IP")
            if not local_ip:
                local_ip = get_local_ip()

            host_port = os.getenv("HOST_PORT", "5000")
            log_debug(f"Detected Local IP: {local_ip}, Port: {host_port}")

            # If running in Docker, get_local_ip might return the container IP (172.x).
            # The AVR cannot reach 172.x. We need the Host's LAN IP.
            # We strongly recommend setting HOST_IP in .env if automatic detection fails.

            # If we are in Docker Bridge mode, we can't easily guess the Host IP unless mapped.
            # But the user is mapping 5000:5000.

            proxy_url = f"http://{local_ip}:{host_port}/stream.mp3?url={stream_url}"
            log_debug(f"Rewriting HTTPS url to HTTP Proxy: {proxy_url}")
            stream_url = proxy_url

        # 1. Construct DIDL-Lite Metadata
        # This is critical for Denon AVRs to know what codec/protocol to expect.
        didl_lite = f"""<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">
<item id="0" parentID="0" restricted="1">
<dc:title>{html.escape(station_name)}</dc:title>
<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>
<res protocolInfo="http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000">{stream_url}</res>
</item>
</DIDL-Lite>"""

        escaped_didl = html.escape(didl_lite)

        # 2. Construct SOAP Body
        soap_body = f"""<?xml version="1.0" encoding="utf-8"?>
        <s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
            <s:Body>
                <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
                    <InstanceID>0</InstanceID>
                    <CurrentURI>{stream_url}</CurrentURI>
                    <CurrentURIMetaData>{escaped_didl}</CurrentURIMetaData>
                </u:SetAVTransportURI>
            </s:Body>
        </s:Envelope>"""

        headers = {
            'Content-Type': 'text/xml; charset="utf-8"',
            'SOAPAction': '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"'
        }

        # Action 1: Set URI
        log_debug(f"Sending SetAVTransportURI to {control_url}...")
        resp1 = requests.post(control_url, data=soap_body, headers=headers, timeout=5)
        log_debug(f"SetAVTransportURI Response: {resp1.status_code} {resp1.text}")

        # Action 2: Play
        play_body = """<?xml version="1.0" encoding="utf-8"?>
        <s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
            <s:Body>
                <u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
                    <InstanceID>0</InstanceID>
                    <Speed>1</Speed>
                </u:Play>
            </s:Body>
        </s:Envelope>"""

        headers['SOAPAction'] = '"urn:schemas-upnp-org:service:AVTransport:1#Play"'
        log_debug(f"Sending Play to {control_url}...")
        resp2 = requests.post(control_url, data=play_body, headers=headers, timeout=5)
        log_debug(f"Play Response: {resp2.status_code} {resp2.text}")

        # Debug: Check actual status via Denon Web Interface
        # The user mentioned http://IP/NetAudio/index.html
        # We can try to fetch the XML status commonly found at /goform/formNetAudio_StatusXml.xml
        try:
            status_url = f"http://{DENON_IP}/goform/formNetAudio_StatusXml.xml"
            r = requests.get(status_url, timeout=2)
            log_debug(f"AVR NetAudio Status: {r.text}")
        except Exception as e:
            log_debug(f"Could not fetch NetAudio Status: {e}")

        return jsonify({"status": "success", "played": stream_url, "control_url": control_url})

    except Exception as e:
        log_debug(f"Error playing URL: {e}")
        if DEBUG:
            import traceback
            traceback.print_exc()
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
