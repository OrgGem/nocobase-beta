import argparse
import os
import sys


def main() -> int:
    vendor_dir = os.path.dirname(os.path.abspath(__file__))
    if vendor_dir not in sys.path:
        sys.path.insert(0, vendor_dir)

    parser = argparse.ArgumentParser(description="Run the bundled MarkItDown source.")
    parser.add_argument("--use-plugins", action="store_true", help="Enable MarkItDown plugins.")
    parser.add_argument("--check", action="store_true", help="Check that MarkItDown can be imported.")
    parser.add_argument("path", nargs="?", help="Path to the file to convert.")
    args = parser.parse_args()

    if args.check:
        from markitdown import MarkItDown

        MarkItDown(enable_plugins=args.use_plugins)
        return 0

    if not args.path:
        parser.print_help()
        return 0

    from markitdown import MarkItDown

    md = MarkItDown(enable_plugins=args.use_plugins)
    result = md.convert(args.path)
    sys.stdout.write(result.text_content or "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
