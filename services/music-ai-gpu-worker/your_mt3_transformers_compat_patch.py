"""Hash-guarded YourMT3 cache-position patch for Transformers 4.48.3."""
from __future__ import annotations

import hashlib
import sysconfig
from pathlib import Path


RELATIVE_TARGET = Path("mt3_infer/models/yourmt3/model/t5mod.py")
ORIGINAL_SHA256 = "b2cc683b55f5d3284c0788d59f8f0a7c39b03535731aeb7a62c81c86c351f480"
PATCHED_SHA256 = "81363b1b69d01d9ea94ac72201f897fdd2ba011b7d0090219b509fa6909ad3ee"
REPLACEMENTS = (
    (
        b"        mask_seq_length = past_key_values[0][0].shape[2] + seq_length "
        b"if past_key_values is not None else seq_length\n\n"
        b"        # mod: required for additive PE\n"
        b"        past_key_values_length = past_key_values[0][0].shape[2] "
        b"if past_key_values is not None else 0\n",
        b"        has_first_layer_cache = bool(past_key_values) and "
        b"past_key_values[0] is not None\n"
        b"        mask_seq_length = (\n"
        b"            past_key_values[0][0].shape[2] + seq_length\n"
        b"            if has_first_layer_cache else seq_length\n"
        b"        )\n\n"
        b"        # mod: required for additive PE\n"
        b"        past_key_values_length = (\n"
        b"            past_key_values[0][0].shape[2] "
        b"if has_first_layer_cache else 0\n"
        b"        )\n",
    ),
    (
        b"        output_attentions=False,\n"
        b"        return_dict=True,\n"
        b"    ):\n",
        b"        output_attentions=False,\n"
        b"        return_dict=True,\n"
        b"        cache_position=None,\n"
        b"    ):\n",
    ),
    (
        b"            use_cache=use_cache,\n"
        b"            output_attentions=output_attentions,\n"
        b"        )\n"
        b"        hidden_states, present_key_value_state",
        b"            use_cache=use_cache,\n"
        b"            output_attentions=output_attentions,\n"
        b"            cache_position=cache_position,\n"
        b"        )\n"
        b"        hidden_states, present_key_value_state",
    ),
    (
        b"                use_cache=use_cache,\n"
        b"                output_attentions=output_attentions,\n"
        b"            )\n"
        b"            hidden_states = cross_attention_outputs[0]",
        b"                use_cache=use_cache,\n"
        b"                output_attentions=output_attentions,\n"
        b"                cache_position=cache_position,\n"
        b"            )\n"
        b"            hidden_states = cross_attention_outputs[0]",
    ),
    (
        b"        hidden_states = self.dropout(inputs_embeds)\n\n"
        b"        for i, (layer_module, past_key_value) in enumerate(zip(self.block, past_key_values)):",
        b"        hidden_states = self.dropout(inputs_embeds)\n\n"
        b"        # Required by Transformers 4.48 T5 attention for current and cached tokens.\n"
        b"        cache_position = torch.arange(\n"
        b"            past_key_values_length, past_key_values_length + seq_length,\n"
        b"            device=inputs_embeds.device,\n"
        b"        )\n\n"
        b"        for i, (layer_module, past_key_value) in enumerate(zip(self.block, past_key_values)):",
    ),
    (
        b"                    use_cache=use_cache,\n"
        b"                    output_attentions=output_attentions,\n"
        b"                )\n\n"
        b"            # layer_outputs",
        b"                    use_cache=use_cache,\n"
        b"                    output_attentions=output_attentions,\n"
        b"                    cache_position=cache_position,\n"
        b"                )\n\n"
        b"            # layer_outputs",
    ),
)


def file_sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def patch_content(content: bytes) -> bytes:
    if file_sha256(content) != ORIGINAL_SHA256:
        raise RuntimeError("YourMT3 compatibility patch source hash mismatch")
    patched = content
    for original, replacement in REPLACEMENTS:
        if patched.count(original) != 1:
            raise RuntimeError("YourMT3 compatibility patch fragment mismatch")
        patched = patched.replace(original, replacement, 1)
    if file_sha256(patched) != PATCHED_SHA256:
        raise RuntimeError("YourMT3 compatibility patch result hash mismatch")
    if any(original in patched for original, _ in REPLACEMENTS):
        raise RuntimeError("YourMT3 compatibility patch verification failed")
    return patched


def main() -> None:
    target = Path(sysconfig.get_paths()["purelib"]) / RELATIVE_TARGET
    if not target.is_file():
        raise RuntimeError("reviewed YourMT3 compatibility patch target is missing")
    target.write_bytes(patch_content(target.read_bytes()))


if __name__ == "__main__":
    main()