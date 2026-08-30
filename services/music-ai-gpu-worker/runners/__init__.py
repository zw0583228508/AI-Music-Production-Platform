"""Pinned, fail-closed provider runners.

These modules intentionally import their heavyweight dependencies only when a
runner is invoked.  Importing them in the API process must not download models
or initialise CUDA.
"""