"""
ComfyUI nodes for Model Downloader.
"""

class ModelDownloaderNode:
    """
    Info node: shows local model counts and opens the Model Downloader panel.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "execute"
    CATEGORY = "model_management"
    OUTPUT_NODE = True

    def execute(self):
        return ()


NODE_CLASS_MAPPINGS = {
    "ModelDownloader": ModelDownloaderNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ModelDownloader": "Advanced Model Manager",
}
