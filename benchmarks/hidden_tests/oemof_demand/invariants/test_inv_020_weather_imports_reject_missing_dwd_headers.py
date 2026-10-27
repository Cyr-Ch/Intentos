"""Hidden invariant test for INV-020: Weather imports reject missing DWD headers.

Lifted from tests/test_vdi4655.py::test_dwd_weather_file_missing_header by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import datetime
import os
import sys
from pathlib import Path
import pandas as pd
import pytest
from oemof import demand
from oemof.demand.vdi import Climate
from oemof.demand.vdi.regions import Region

class TestVDI4655Profiles:
    def test_dwd_weather_file_missing_header(self):
        """Test error handling for weather file with missing header."""
        import tempfile

        # Create temporary file without proper header
        with tempfile.NamedTemporaryFile(mode="w", delete=False) as tf:
            tf.write("Some data without header\n1 2 3 4 5\n")
            temp_filepath = tf.name

        try:
            with pytest.raises(TypeError, match="Header row not found"):
                from oemof.demand.vdi.dwd_try import read_dwd_weather_file

                read_dwd_weather_file(weather_file_path=temp_filepath)
        finally:
            os.remove(temp_filepath)
