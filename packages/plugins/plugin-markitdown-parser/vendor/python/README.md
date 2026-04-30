# Bundled MarkItDown Source

This directory vendors the Python source package `markitdown==0.1.5` from
Microsoft MarkItDown as a fallback when the `markitdown` CLI is not installed.

Only MarkItDown source files are bundled. Python dependencies are not bundled,
because the default dependency set includes large platform wheels such as
`magika`, `numpy`, and `onnxruntime`. Install the needed Python dependencies in
the NocoBase runtime environment for the file formats you want to parse.

Source: https://pypi.org/project/markitdown/0.1.5/
License: MIT
