import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("inference", Path(__file__).parents[1] / "inference.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
def test_rejects_placeholder_midi(): assert not module.valid_midi(b"MThd" + b"\0" * 28)
def test_accepts_nonempty_smf(): assert module.valid_midi(b"MThd\0\0\0\6\0\1\0\1\1\xe0MTrk\0\0\0\14\0\x90\x3c\x40\x60\x80\x3c\0\0\xff\x2f\0")