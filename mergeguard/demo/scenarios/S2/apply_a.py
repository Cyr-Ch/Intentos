"""Apply scripted A in the current demo clone; does not commit or merge."""
from pathlib import Path
from mergeguard.demo import change_a

change_a(Path.cwd(), 'S2')
