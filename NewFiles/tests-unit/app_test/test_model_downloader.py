import os
import pytest

import folder_paths
from app.model_downloader import (
    resolve_target_path,
    validate_url_host_sync,
    validate_url_syntax,
)


def test_resolve_target_path_standard_and_legacy_folders():
    canon, rel, base_dir, abs_path = resolve_target_path("checkpoints", "model.safetensors")
    assert canon == "checkpoints"
    assert rel == "model.safetensors"
    assert abs_path == os.path.abspath(os.path.join(base_dir, "model.safetensors"))

    canon_unet, _, base_unet, _ = resolve_target_path("unet", "flux.safetensors")
    assert canon_unet == "diffusion_models"
    assert os.path.basename(base_unet) == "diffusion_models"

    canon_clip, _, base_clip, _ = resolve_target_path("clip", "t5.safetensors")
    assert canon_clip == "text_encoders"
    assert os.path.basename(base_clip) == "text_encoders"

    canon_prefixed, rel_sub, _, _ = resolve_target_path("models/loras", "style/my_lora.safetensors")
    assert canon_prefixed == "loras"
    assert rel_sub == "style/my_lora.safetensors"


@pytest.mark.parametrize(
    "directory,filename",
    [
        ("custom_nodes", "evil.safetensors"),
        ("configs", "cfg.yaml"),
        ("datasets", "data.safetensors"),
        ("../outside", "model.safetensors"),
        ("checkpoints", "../escape.safetensors"),
        ("checkpoints", "/etc/passwd.safetensors"),
        ("checkpoints", "sub/../../escape.safetensors"),
        ("checkpoints", "model.py"),
        ("checkpoints", "model.sh"),
        ("checkpoints", "bad\x00name.safetensors"),
        ("checkpoints", "C:/evil.safetensors"),
        ("checkpoints", ""),
        ("", "model.safetensors"),
    ],
)
def test_resolve_target_path_rejects_unsafe_inputs(directory, filename):
    with pytest.raises(ValueError):
        resolve_target_path(directory, filename)


@pytest.mark.parametrize(
    "bad_url",
    [
        "",
        "file:///etc/passwd",
        "ftp://example.com/model.safetensors",
        "https://user:pass@huggingface.co/model.safetensors",
        "https://huggingface.co/model.safetensors\nInjected: 1",
    ],
)
def test_validate_url_syntax_rejects_bad_urls(bad_url):
    with pytest.raises(ValueError):
        validate_url_syntax(bad_url)


@pytest.mark.parametrize(
    "ssrf_url",
    [
        "http://127.0.0.1/model.safetensors",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/model.safetensors",
        "http://192.168.1.1/model.safetensors",
        "http://[::1]/model.safetensors",
        "http://[::ffff:127.0.0.1]/model.safetensors",
    ],
)
def test_validate_url_host_blocks_private_and_metadata_ips(ssrf_url):
    with pytest.raises(ValueError):
        validate_url_host_sync(ssrf_url)


def test_validate_url_host_allows_public_ip():
    parsed = validate_url_host_sync("https://1.1.1.1/model.safetensors")
    assert parsed.hostname == "1.1.1.1"
    assert folder_paths.is_within_directory(
        folder_paths.get_folder_paths("checkpoints")[0],
        os.path.join(folder_paths.get_folder_paths("checkpoints")[0], "ok.safetensors"),
    )
