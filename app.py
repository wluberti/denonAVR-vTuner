from flask import Flask, render_template, jsonify, request
import sys
import denonavr
import requests
import socket
import os
import asyncio
import telnetlib
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
        "name": d.name,
        "artist": getattr(d, 'artist', ''),
        "title": getattr(d, 'title', ''),
        "station": getattr(d, 'band', ''), # 'band' often holds station name in DenonAVR lib
        "input_list": d.input_func_list
    }

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

@app.route('/api/debug_inputs')
def debug_inputs():
    """Debug endpoint to show what inputs the library sees"""
    if not DENON_IP:
        return jsonify({"error": "DENON_IP not configured"}), 500

    try:
        d = denonavr.DenonAVR(DENON_IP)
        asyncio.run(d.async_setup())
        asyncio.run(d.async_update())
        return jsonify({
            "current_input": d.input_func,
            "available_inputs": d.input_func_list,
            "all_attributes": {
                "name": d.name,
                "power": d.power,
                "volume": d.volume
            }
        })
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
        # DenonAVR accepts float. -80 to +18 usually.
        # User might send absolute float.
        if val is not None:
            log_debug(f"Setting volume to {val}")
            d = denonavr.DenonAVR(DENON_IP)
            asyncio.run(d.async_setup())
            asyncio.run(d.async_set_volume(float(val)))
            return jsonify({"status": "success", "volume": val})
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
                "TV": "TV",
                "TV AUDIO": "TV",
                "STB": "CBL/SAT",
                "SAT/CBL": "CBL/SAT",
                "SATCBL": "CBL/SAT",
                "CBL/SAT": "CBL/SAT",
                "XS4ALL STB": "CBL/SAT",
                "CD": "CD",
                "NET": "NET",
                "RADIO": "NET",
                "TUNER": "TUNER",
                "DVD": "DVD",
                "BD": "BD",
                "GAME": "GAME",
                "AUX1": "AUX1",
                "AUX2": "AUX2",
                "PHONO": "PHONO",
                "MPLAY": "MPLAY",
                "USB/IPOD": "USB/IPOD"
            }

            clean_source = source.strip()
            final_source = INPUT_MAPPING.get(clean_source, clean_source)

            log_debug(f"Input selection requested: {source} -> {final_source}")

            # Try HTTP API first (most reliable for Denon AVRs)
            http_success = False
            try:
                log_debug(f"Attempting HTTP API method...")
                # The AVR's HTTP API expects commands like SICD, SISATCBL, etc.
                # Remove slashes for the HTTP command
                http_code = final_source.replace("/", "").replace(" ", "")
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

            # If HTTP failed, try denonavr library
            if not http_success:
                library_success = False
                lib_err = None
                try:
                    log_debug(f"Attempting denonavr library method...")
                    d = denonavr.DenonAVR(DENON_IP)
                    asyncio.run(d.async_setup())
                    log_debug(f"Available inputs: {d.input_func_list}")
                    asyncio.run(d.async_set_input_func(final_source))
                    library_success = True
                    log_debug(f"Successfully set input via library")
                except Exception as e:
                    lib_err = e
                    log_debug(f"Library method failed: {lib_err}")


            # If both library and HTTP failed, try Telnet as last resort
            if not http_success and not library_success:
                try:
                    log_debug(f"Attempting Telnet fallback to {DENON_IP}:23")
                    with telnetlib.Telnet(DENON_IP, 23, timeout=3) as tn:
                        cmd = f"SI{final_source}\r".encode('ascii')
                        log_debug(f"Sending Telnet command: {cmd}")
                        tn.write(cmd)
                        # Try to read response
                        import time
                        time.sleep(0.1)
                        try:
                            response = tn.read_very_eager().decode('ascii', errors='ignore')
                            log_debug(f"Telnet response: {response}")
                        except:
                            pass
                    log_debug(f"Telnet command sent successfully")
                except Exception as telnet_err:
                    log_debug(f"Telnet method also failed: {telnet_err}")
                    return jsonify({"error": f"All methods failed. HTTP, Library: {lib_err}, Telnet: {telnet_err}"}), 500

            # Determine which method succeeded
            if http_success:
                method = "http"
            elif library_success:
                method = "library"
            else:
                method = "telnet"

            return jsonify({"status": "success", "input": final_source, "method": method})
        return jsonify({"error": "Missing input"}), 400
    except Exception as e:
        log_debug(f"Error setting input: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/mute/toggle', methods=['POST'])
def toggle_mute():
    try:
        log_debug("Toggling mute")
        d = denonavr.DenonAVR(DENON_IP)
        asyncio.run(d.async_setup())
        asyncio.run(d.async_mute_volume(not d.muted))
        return jsonify({"status": "success", "muted": not d.muted})
    except Exception as e:
        log_debug(f"Error toggling mute: {e}")
        return jsonify({"error": str(e)}), 500

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
        # Stream the content WITHOUT ICY metadata request to avoid interleaved data
        # headers = {'Icy-MetaData': '1'}
        # CAUTION: Requesting Icy-MetaData=1 causes the server to insert metadata bytes
        # into the MP3 stream. The AVR doesn't expect this and plays them as noise (pop/jitter).
        req = requests.get(url, stream=True, timeout=10)

        def generate():
            # Increase chunk size to 32KB for better buffering
            for chunk in req.iter_content(chunk_size=32768):
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
