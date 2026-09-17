import argparse
import os
import tempfile
from promptcut_cards.worker import Worker

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--temp-dir", required=True)
    args = parser.parse_args()
    os.environ["TEMP"] = os.environ["TMP"] = args.temp_dir
    tempfile.tempdir = args.temp_dir
    Worker().run()
