from payments.charge import charge

def test_charge():
    assert charge(5) == 500
