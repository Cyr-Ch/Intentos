"""Apply the deterministic naive B change; does not commit or merge."""
from pathlib import Path
from mergeguard.demo import change_b

change_b(Path.cwd(), 'S3')
