import os
import zipfile
from typing import AnyStr

import boto3

from utils.config import Config


def _s3():
    s3 = boto3.resource('s3')
    bucket = s3.Bucket('xanmc')
    for obj in bucket.objects.all():
        print(obj.key)


def zip_world(world_fp: AnyStr, output_file_name: str):
    # Determine the parent directory
    parent_dir = os.path.dirname(world_fp)
    output_filename = os.path.join(parent_dir, output_file_name + '.zip')

    # Create a ZipFile object in write mode
    with zipfile.ZipFile(output_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # Walk through the directory
        for root, dirs, files in os.walk(world_fp):
            for file in files:
                # Create a proper path relative to the folder being zipped
                file_path = os.path.join(root, file)
                file_path_in_zip = os.path.relpath(file_path, world_fp)
                # Add the file to the zip file
                zipf.write(file_path, file_path_in_zip)

    return output_filename


if __name__ == '__main__':
    cfg = Config()

    zipped_to = zip_world(cfg.world_filepath, cfg.world_name)
    print(f'Zipped world to {zipped_to}')
