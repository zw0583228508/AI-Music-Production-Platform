---
name: Python music runtime compatibility
description: Compatibility constraints discovered across local and isolated Python music-model runtimes.
---

Use Python 3.11 for the local music-model worker. Keep Basic Pitch 0.4 with
TensorFlow 2.14 on NumPy 1.26 rather than NumPy 2, and treat a package install as
incomplete until model inference and output encoding both pass.

**Why:** Basic Pitch loaded unsuccessfully with NumPy 2 because its TensorFlow
binary was compiled against NumPy 1.x. Demucs completed inference but could not
write stems until TorchCodec was installed for the current Torchaudio release.
Pedalboard installed but could not import until the Nix environment supplied
GCC's `libatomic` runtime.
For an exact standalone CPython runtime, create uv virtual environments with
seed tooling when later build steps invoke pip. Legacy `pyworld` releases still
import `pkg_resources`, so pin a setuptools release that provides it and prove
compatibility with real inference.

**How to apply:** When changing Python, TensorFlow, Torch/Torchaudio, or
Pedalboard versions, rerun real Basic Pitch inference, ONNX inference, Demucs
stem writing, and Pedalboard processing. Never infer readiness from dependency
resolution alone. For isolated GPU images, verify the interpreter patch version
inside the image and rerun source-conditioned inference after changing Python
distribution or virtual-environment tooling.