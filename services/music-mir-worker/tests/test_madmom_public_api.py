"""Run inside the py311 image to guard the exact madmom-infer public API."""
import importlib.util
import unittest


@unittest.skipUnless(
    importlib.util.find_spec("madmom_infer"),
    "madmom-infer is intentionally installed only in the isolated py311 image",
)
class MadmomPublicApiTests(unittest.TestCase):
    def test_phase_two_processors_are_the_supported_public_interface(self):
        from madmom_infer.features.downbeats import (
            DBNDownBeatTrackingProcessor,
            RNNDownBeatProcessor,
        )
        from madmom_infer.models import downbeats_blstm

        self.assertTrue(callable(downbeats_blstm))
        self.assertTrue(callable(RNNDownBeatProcessor))
        self.assertTrue(callable(DBNDownBeatTrackingProcessor))