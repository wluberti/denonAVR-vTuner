from unittest.mock import patch, MagicMock

@patch('requests.get')
def test_search_api(mock_get, client):
    # Mock RadioBrowser response
    mock_resp = MagicMock()
    mock_resp.json.return_value = [
        {"name": "Radio 1", "countrycode": "US", "bitrate": 128, "url_resolved": "http://stream.url"}
    ]
    mock_get.return_value = mock_resp

    response = client.get('/api/search?name=test')
    assert response.status_code == 200
    data = response.get_json()
    assert len(data) == 1
    assert data[0]['name'] == 'Radio 1'

@patch('requests.post')
def test_play_url_api(mock_post, client):
    response = client.get('/api/play_url?url=http://test.stream')
    assert response.status_code == 200
    assert response.get_json()['status'] == 'success'

    # Check if SOAP request was sent
    assert mock_post.called
    args, kwargs = mock_post.call_args_list[0]
    assert "SetAVTransportURI" in kwargs['data']
