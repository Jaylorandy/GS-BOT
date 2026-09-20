import argparse
import importlib
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static
from PIL import Image, ImageOps


MODEL_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
MODEL_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
DEFAULT_INPUT_SIZE = 1024
DEFAULT_OP_TYPES = "Conv,MatMul,Softmax"
ORT_CALIBRATE_MODULE = importlib.import_module("onnxruntime.quantization.calibrate")
ORT_QUANTIZE_MODULE = importlib.import_module("onnxruntime.quantization.quantize")


def discover_images(folder: Path):
    allowed = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
    return [
        path for path in sorted(folder.iterdir())
        if path.is_file() and path.suffix.lower() in allowed
    ]


def prepare_tensor(image_path: Path, width: int, height: int):
    image = ImageOps.exif_transpose(Image.open(image_path)).convert("RGB")
    image = image.resize((width, height), Image.Resampling.BILINEAR)
    arr = np.asarray(image, dtype=np.float32) / 255.0
    arr = (arr - MODEL_MEAN) / MODEL_STD
    arr = np.transpose(arr, (2, 0, 1))[None, ...]
    return arr.astype(np.float32, copy=False)


def resolve_dim(value, fallback: int):
    if isinstance(value, int) and value > 0:
        return value
    try:
        parsed = int(value)
        return parsed if parsed > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def load_model_without_shape_infer(model_path: Path):
    return onnx.load(str(model_path))


class RmbgCalibrationReader(CalibrationDataReader):
    def __init__(self, image_paths, input_name, width, height):
        self._image_paths = list(image_paths)
        self._input_name = input_name
        self._width = width
        self._height = height
        self._index = 0

    def get_next(self):
        if self._index >= len(self._image_paths):
            return None
        image_path = self._image_paths[self._index]
        self._index += 1
        return {
            self._input_name: prepare_tensor(image_path, self._width, self._height),
        }


def main():
    parser = argparse.ArgumentParser(description="Quantize RMBG ONNX model into an ORT-friendly INT8 QDQ artifact.")
    parser.add_argument("--input", required=True, help="Path to source model.onnx")
    parser.add_argument("--output", required=True, help="Path to output INT8 QDQ model")
    parser.add_argument("--calib-dir", required=True, help="Directory containing calibration images")
    parser.add_argument("--limit", type=int, default=8, help="Maximum number of calibration images")
    parser.add_argument(
        "--op-types",
        default=DEFAULT_OP_TYPES,
        help=f"Comma-separated ONNX op types to quantize. Defaults to {DEFAULT_OP_TYPES}.",
    )
    parser.add_argument("--width", type=int, default=DEFAULT_INPUT_SIZE, help="Calibration input width for dynamic ONNX models")
    parser.add_argument("--height", type=int, default=DEFAULT_INPUT_SIZE, help="Calibration input height for dynamic ONNX models")
    parser.add_argument(
        "--use-shape-infer",
        action="store_true",
        help="Let ONNX Runtime run pre-quantization shape inference. Disabled by default for large dynamic RMBG models.",
    )
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    calib_dir = Path(args.calib_dir).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    session = ort.InferenceSession(str(input_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    input_shape = session.get_inputs()[0].shape
    height = resolve_dim(input_shape[2], args.height)
    width = resolve_dim(input_shape[3], args.width)

    image_paths = discover_images(calib_dir)[: max(1, args.limit)]
    if not image_paths:
        raise RuntimeError(f"No calibration images were found in {calib_dir}")
    op_types = [op_type.strip() for op_type in args.op_types.split(",") if op_type.strip()]

    if not args.use_shape_infer:
        ORT_CALIBRATE_MODULE.load_model_with_shape_infer = load_model_without_shape_infer
        ORT_QUANTIZE_MODULE.load_model_with_shape_infer = load_model_without_shape_infer

    reader = RmbgCalibrationReader(image_paths, input_name, width, height)
    quantize_static(
        model_input=str(input_path),
        model_output=str(output_path),
        calibration_data_reader=reader,
        quant_format=QuantFormat.QDQ,
        op_types_to_quantize=op_types or None,
        activation_type=QuantType.QInt8,
        weight_type=QuantType.QInt8,
        per_channel=False,
        reduce_range=False,
        use_external_data_format=False,
        extra_options={
            "ActivationSymmetric": False,
            "WeightSymmetric": True,
        },
    )

    print(f"Quantized QDQ model written to: {output_path}")


if __name__ == "__main__":
    main()
