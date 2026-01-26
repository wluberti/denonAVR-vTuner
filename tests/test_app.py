import pytest
from unittest.mock import patch, MagicMock

def test_index(client):
    response = client.get('/')
    assert response.status_code == 200
    assert b"DENON AVR" in response.data

@patch('app.denonavr.DenonAVR')
def test_status_api(mock_denon, client):
    # Mock the async status update
    mock_instance = MagicMock()
    mock_instance.async_setup = MagicMock(return_value=None) # async mock?

    # Since we are using asyncio.run in the route, we need to mock the async methods properly
    # or mock the whole asyncio.run call if it's easier, or mock the denonavr class to return awaitables.
    # However, app.py uses asyncio.run(async_get_status()).

    # It might be easier to patch 'app.async_get_status' directly if possible, or 'app.denonavr'

    # Let's try patching the return value of async_get_status inside the route would be hard without refactoring.
    # Instead, let's mock the DenonAVR instance attributes which are accessed.

    # We need to make sure the mocked async methods can be awaited.
    async def async_mock(*args, **kwargs):
        return None

    mock_instance.async_setup.side_effect = async_mock
    mock_instance.async_update.side_effect = async_mock
    mock_instance.power = "ON"
    mock_instance.state = "Playing"
    mock_instance.input_func = "Internet Radio"
    mock_instance.volume = -40
    mock_instance.muted = False
    mock_instance.name = "Denon Test"

    mock_denon.return_value = mock_instance

    # We also need to patch asyncio.run if we can't easily mock async calls across the boundary,
    # but asyncio.run should work if the side_effects are coroutines.

    response = client.get('/api/status')

    # Note: If Environment variable is missing, it might fail with 500 first.
    # But in test environment we might need to set it.

    # If it fails, checks logs.
    assert response.status_code == 200
    json_data = response.get_json()
    assert json_data['power'] == "ON"
    assert json_data['source'] == "Internet Radio"

@patch('telnetlib.Telnet')
def test_play_favorite(mock_telnet, client):
    mock_tn_instance = MagicMock()
    mock_telnet.return_value = mock_tn_instance

    response = client.get('/api/play_favorite/1')
    assert response.status_code == 200
    assert response.get_json()['status'] == 'success'

    # Verify correct command sent
    # Expecting: ZMFAVORITE1 + \r
    mock_tn_instance.write.assert_called_with(b"ZMFAVORITE1\r")

@patch('telnetlib.Telnet')
def test_set_source(mock_telnet, client):
    mock_tn_instance = MagicMock()
    mock_telnet.return_value = mock_tn_instance

    response = client.get('/api/source/tuner')
    assert response.status_code == 200

    # Verify correct command sent
    mock_tn_instance.write.assert_called_with(b"SITUNER\r")

