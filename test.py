import tensorrt as trt
logger = trt.Logger(trt.Logger.WARNING)
try:
    rt = trt.Runtime(logger)
    print("TRT runtime OK")
except Exception as e:
    print("TRT failed:", e)
