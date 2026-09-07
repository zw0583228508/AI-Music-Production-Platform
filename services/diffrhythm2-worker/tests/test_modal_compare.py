import os
import unittest
from unittest import mock

import modal_compare
import smoke


class FakeLifecycle:
    def __init__(self, events):
        self.events = events
        self.markers = []

    def put(self, marker):
        self.events.append(("marker", marker["outcome"]))
        self.markers.append(marker)


class ControlledCancellationContractTests(unittest.TestCase):
    def run_controlled_comparison(self, signal_comparison):
        events = []
        lifecycle = FakeLifecycle(events)

        def observed_comparison(source, output):
            events.append(("work", "entered"))
            try:
                return signal_comparison(source, output)
            finally:
                events.append(("work", "exited"))

        with mock.patch.dict(os.environ, {"MODAL_IMAGE_ID": "im-Safe123"}), \
             mock.patch.object(smoke, "signal_comparison", observed_comparison), \
             mock.patch("time.time", return_value=1000.0), \
             mock.patch("time.sleep"):
            try:
                result = modal_compare.drill_retained_smoke_comparison.local(
                    "cancel_execution", lifecycle
                )
            except Exception as error:
                return events, lifecycle.markers, None, error
        return events, lifecycle.markers, result, None

    def test_success_markers_bracket_only_the_controlled_comparison_work(self):
        observed_paths = []

        def successful_comparison(source, output):
            observed_paths.append((str(source), str(output)))
            return {"passesNotSourceCopy": True}

        events, markers, result, error = self.run_controlled_comparison(
            successful_comparison
        )

        self.assertIsNone(error)
        self.assertEqual(
            events,
            [
                ("marker", "pre_work"),
                ("work", "entered"),
                ("work", "exited"),
                ("marker", "post_work"),
            ],
        )
        self.assertEqual(len(observed_paths), 1)
        self.assertEqual(
            observed_paths[0],
            (
                f"{modal_compare.SMOKE_MOUNT}/golden-30s.wav",
                f"{modal_compare.MODEL_MOUNT}/full-fixture-output.mp3",
            ),
        )
        self.assertEqual(
            markers,
            [
                {
                    "outcome": "pre_work",
                    "startedUnixSeconds": 1000.0,
                    "modalImageId": "im-Safe123",
                },
                {
                    "outcome": "post_work",
                    "finishedUnixSeconds": 1000.0,
                    "modalImageId": "im-Safe123",
                },
            ],
        )
        self.assertEqual(
            result,
            {
                "outcome": "completed",
                "startedUnixSeconds": 1000.0,
                "finishedUnixSeconds": 1000.0,
                "modalImageId": "im-Safe123",
            },
        )

    def test_failure_emits_exact_markers_and_sanitizes_comparison_details(self):
        private_detail = "/private/customer-fixture.wav sha256:" + "a" * 64

        def failed_comparison(_source, _output):
            raise RuntimeError(private_detail)

        events, markers, result, error = self.run_controlled_comparison(
            failed_comparison
        )

        self.assertIsNone(result)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(
            str(error),
            "controlled comparison failed within the worker resource limit",
        )
        self.assertEqual(
            events,
            [
                ("marker", "pre_work"),
                ("work", "entered"),
                ("work", "exited"),
                ("marker", "post_work"),
            ],
        )
        self.assertEqual(
            markers,
            [
                {
                    "outcome": "pre_work",
                    "startedUnixSeconds": 1000.0,
                    "modalImageId": "im-Safe123",
                },
                {
                    "outcome": "post_work",
                    "finishedUnixSeconds": 1000.0,
                    "modalImageId": "im-Safe123",
                },
            ],
        )
        self.assertNotIn(private_detail, str(error))
        self.assertIsNone(error.__cause__)


if __name__ == "__main__":
    unittest.main()