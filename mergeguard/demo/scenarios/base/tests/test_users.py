from users import get_user

def test_user():
    assert get_user(7) == {"id": 7}
