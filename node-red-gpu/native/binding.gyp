{
  "targets": [{
    "target_name": "gpu_addon",
    "sources": ["src/gpu_addon.cpp"],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "libraries": ["-lvulkan"],
    "cflags!": ["-fno-exceptions"],
    "cflags_cc!": ["-fno-exceptions"],
    "cflags_cc": ["-std=c++17", "-O2"],
    "defines": ["NAPI_VERSION=10", "NAPI_DISABLE_CPP_EXCEPTIONS"]
  }]
}
