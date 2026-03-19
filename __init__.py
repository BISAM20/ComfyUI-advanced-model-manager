"""
ComfyUI Model Downloader
Browse and download models from Comfy-Org and Kijai on HuggingFace.
"""
import traceback

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
except Exception:
    traceback.print_exc()

try:
    from .downloader_routes import setup_routes
    setup_routes()
except Exception:
    traceback.print_exc()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
